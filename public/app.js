/**
 * second-brain Web 前端(W3)。
 *
 * Vue3 全局构建(无构建链):页面模板在 index.html,这里只放状态与请求。
 * 两个渲染安全点:
 * - 回答/报告先整体 HTML 转义,再做白名单替换([n] 角标、**粗体**、# 标题)
 *   —— 机制上杜绝 LLM 输出或网页内容带进来的注入;
 * - 来源 URL 一律按纯文本展示,不生成可点击外链(避免误触离库跳转)。
 */
const { createApp } = Vue;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 引用角标:文本里的 [n] → 可点击上标(先转义后替换,n 保留原样) */
function withCites(escaped, cls) {
  return escaped.replace(/\[(\d{1,2})\]/g, (m, n) => `<sup class="cite ${cls}" data-n="${n}">${n}</sup>`);
}

/** 白名单 Markdown:只支持 #/##/### 标题、- 列表、**粗体**、段落。其余当纯文本 */
function mdToHtml(md) {
  const lines = escapeHtml(md).split(/\r?\n/);
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const raw of lines) {
    const t = raw.trim();
    const h = t.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      closeList();
      const tag = h[1].length <= 2 ? 'h3' : 'h4';
      out.push(`<${tag}>${withCites(h[2], 'cite-src')}</${tag}>`);
      continue;
    }
    const li = t.match(/^[-*]\s+(.+)$/);
    if (li) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${withCites(bold(li[1]), 'cite-src')}</li>`);
      continue;
    }
    closeList();
    if (t) out.push(`<p>${withCites(bold(t), 'cite-src')}</p>`);
  }
  closeList();
  return out.join('\n');
}

function bold(escapedLine) {
  return escapedLine.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

createApp({
  data() {
    return {
      tab: 'qa',
      regions: [],
      region: '',
      stats: null,
      // 归纳问答(多轮会话)
      question: '',
      asking: false,
      qaTurns: [],
      turnSeq: 0,
      askError: '',
      // 深度研究
      researchQ: '',
      researching: false,
      jobId: null,
      jobStage: '',
      researchResult: null,
      researchError: '',
      researchSaveState: '',
      // 文档库
      docs: [],
      docSearchQ: '',
      lastSearchQ: '',
      searchResults: null,
      activeDoc: null,
      // 文档库视图(文档/主题)
      docsView: 'docs',
      topics: [],
      activeTopic: null,
      topicMsg: '',
      // 向量索引
      embStatus: null,
      // 评估校准
      evalRunning: false,
      evalStage: '',
      evalSummary: null,
      evalSuggestions: [],
      // 数据存储
      dataInfo: null,
      dataMsg: '',
      dataOk: false,
      migrating: false,
      // 整理台
      inbox: [],
      resolvedRecent: [],
      taxoRegion: 'learning',
      taxonomy: [],
      taxoByRegion: {},
      newTagName: '',
      topicSuggestions: [],
      rulesText: '',
      rulesMsg: '',
      reviewing: false,
      reviewContent: '',
      reviewStage: '',
      resetWord: '',
      resetMsg: '',
      resetOk: false,
      // 导入
      dropHover: false,
      noteText: '',
      importRegion: 'learning',
      importUrl: '',
      importTag: true,
      importRel: true,
      importing: false,
      importStage: '',
      importResults: [],
      importDone: '',
    };
  },

  computed: {
    reportHtml() {
      if (!this.researchResult) return '';
      return mdToHtml(this.researchResult.report);
    },
    failedSummary() {
      const f = this.researchResult?.failed ?? [];
      return f
        .slice(0, 3)
        .map((x) => x.url.slice(0, 40))
        .join(' / ');
    },
    inboxCount() {
      return this.inbox.length;
    },
    isDesktop() {
      return !!window.sbDesktop;
    },
    pendingTags() {
      return this.taxonomy.filter((t) => t.status === 'pending');
    },
    approvedTags() {
      return this.taxonomy.filter((t) => t.status === 'approved');
    },
    topicHtml() {
      if (!this.activeTopic) return '';
      return mdToHtml(this.activeTopic.content);
    },
    reviewHtml() {
      if (!this.reviewContent) return '';
      return mdToHtml(this.reviewContent);
    },
  },

  methods: {
    async api(path, opts) {
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },

    async loadStats() {
      this.stats = await this.api('/api/stats');
    },
    async loadDocs() {
      const r = await this.api('/api/docs' + (this.region ? `?region=${this.region}` : ''));
      this.docs = r.docs;
    },

    // ── 归纳问答(多轮会话 + 流式输出)──────────────────────────────
    async ask() {
      if (!this.question.trim() || this.asking) return;
      this.asking = true;
      this.askError = '';
      const q = this.question.trim();
      this.question = '';
      // 带上最近 3 轮作上下文:服务端先补全指代("它怎么部署"→"X 怎么部署")再检索
      const history = this.qaTurns.slice(-3).map((t) => ({ q: t.q, a: t.rawAnswer }));
      this.turnSeq += 1;
      // 先占一张"生成中"的卡:阶段提示与流式文字都实时打进来
      const turn = Vue.reactive({
        id: this.turnSeq,
        q,
        rawAnswer: '',
        html: '',
        sufficient: true,
        citations: [],
        usedDocs: [],
        conflictNotes: [],
        streaming: true,
        stage: '整理问题…',
      });
      this.qaTurns.push(turn);
      this.scrollQaBottom();

      const render = (text) => {
        turn.rawAnswer = text;
        turn.html = withCites(escapeHtml(text), 'cite-qa');
      };
      try {
        const res = await fetch('/api/ask/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, region: this.region || null, history }),
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'HTTP ' + res.status);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let failed = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let ev = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) ev = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            const payload = JSON.parse(data);
            if (ev === 'stage') turn.stage = payload.stage;
            else if (ev === 'delta') {
              turn.stage = '';
              render(payload.full);
              this.scrollQaBottom();
            } else if (ev === 'done') {
              Object.assign(turn, {
                rawAnswer: payload.answer,
                html: withCites(escapeHtml(payload.answer), 'cite-qa'),
                sufficient: payload.sufficient,
                citations: payload.citations,
                usedDocs: payload.usedDocs,
                conflictNotes: payload.conflictNotes,
                reflection: payload.reflection ?? null,
                streaming: false,
              });
            } else if (ev === 'error') {
              failed = payload.error || '生成失败';
            }
          }
        }
        if (failed) {
          // 生成中途失败:占位卡直接移除,错误提示在输入区显示
          this.qaTurns = this.qaTurns.filter((t) => t.id !== turn.id);
          this.askError = '问答失败:' + failed;
        } else {
          turn.streaming = false;
          this.loadStats();
        }
        this.scrollQaBottom();
      } catch (e) {
        this.qaTurns = this.qaTurns.filter((t) => t.id !== turn.id);
        this.askError = '问答失败:' + e.message;
      } finally {
        this.asking = false;
      }
    },

    newTopic() {
      this.qaTurns = [];
      this.scrollQaBottom();
    },

    openQa() {
      this.tab = 'qa';
      // 切回问答页时,让最新一轮在视野内
      requestAnimationFrame(() => this.scrollQaBottom());
    },

    scrollQaBottom() {
      requestAnimationFrame(() => {
        const el = document.querySelector('.qa-scroll');
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    // ── 深度研究:发起 + 轮询 ─────────────────────────────────
    async startResearch() {
      if (!this.researchQ.trim() || this.researching) return;
      this.researching = true;
      this.researchError = '';
      this.researchResult = null;
      this.researchSaveState = '';
      this.jobStage = '提交中…';
      try {
        const { jobId } = await this.api('/api/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: this.researchQ }),
        });
        this.jobId = jobId;
        await this.pollResearch(jobId);
      } catch (e) {
        this.researchError = '研究失败:' + e.message;
      } finally {
        this.researching = false;
        this.jobStage = '';
      }
    },

    async pollResearch(jobId) {
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const job = await this.api('/api/research/' + jobId);
        this.jobStage = job.stage;
        if (job.status === 'done') {
          this.researchResult = job.result;
          return;
        }
        if (job.status === 'error') throw new Error(job.error || '未知错误');
      }
    },

    async saveResearch(withSources) {
      this.researchSaveState = withSources ? '沉淀中(报告 + 来源入库,约 1~2 分钟)…' : '报告入库中…';
      try {
        const r = await this.api('/api/research/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: this.jobId, withSources, region: this.importRegion }),
        });
        const srcOk = r.sources.filter((s) => s.result).length;
        const srcFail = r.sources.filter((s) => s.error).length;
        this.researchSaveState = `✔ 报告已入库:文档 #${r.report.docId}(${r.report.chunks} chunks);来源入库 ${srcOk} 个${srcFail ? `,失败 ${srcFail} 个` : ''}`;
        this.loadStats();
        this.loadDocs();
      } catch (e) {
        this.researchSaveState = '✘ 沉淀失败:' + e.message;
      }
    },

    async deferResearch() {
      try {
        const r = await this.api('/api/research/defer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: this.jobId }),
        });
        this.researchSaveState = `✔ 已存入收件箱(待办 #${r.inboxId}),稍后在整理台处理`;
        this.loadStats();
      } catch (e) {
        this.researchSaveState = '✘ 操作失败:' + e.message;
      }
    },

    jumpSource(ev) {
      const sup = ev.target.closest('.cite');
      if (!sup) return;
      const el = document.getElementById('src-' + sup.dataset.n);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    // ── 整理台 ────────────────────────────────────────────────
    async openDesk() {
      this.tab = 'desk';
      // 词表按区域全部拉齐:待办条目可能来自任一区域,"合并到"候选必须现成
      this.loadDataInfo();
      this.loadEmbStatus();
      this.loadEvalState();
      await Promise.all([
        this.loadInbox(),
        ...this.regions.map((r) => this.loadTaxonomy(r.slug)),
        this.loadTopicSuggestions(),
        this.loadRules(),
      ]);
    },

    // 向量索引:状态 + 构建/补全
    async loadEmbStatus() {
      try {
        this.embStatus = await this.api('/api/embeddings/status');
      } catch {
        this.embStatus = null;
      }
    },

    async backfillEmbeddings() {
      this.embStatus = await this.api('/api/embeddings/backfill', { method: 'POST' });
      const tick = setInterval(async () => {
        await this.loadEmbStatus();
        if (this.embStatus && !this.embStatus.running) clearInterval(tick);
      }, 2000);
    },

    // 评估校准:跑评估 → AI 判定建议 → 用户拍板
    async loadEvalState() {
      try {
        const r = await this.api('/api/eval');
        this.evalRunning = r.running;
        this.evalSuggestions = r.pending ? r.pending.suggestions.map((s) => ({ ...s, busy: false })) : [];
        if (r.pending) this.evalSummary = r.pending.summary;
      } catch {
        /* 忽略 */
      }
    },

    async runEvalJob() {
      if (this.evalRunning) return;
      this.evalRunning = true;
      this.evalStage = '提交中…';
      this.evalSuggestions = [];
      try {
        const { jobId } = await this.api('/api/eval/run', { method: 'POST' });
        for (;;) {
          await new Promise((r) => setTimeout(r, 3000));
          const job = await this.api('/api/llm/' + jobId);
          this.evalStage = job.stage;
          if (job.status === 'done') {
            this.evalSummary = job.result.summary;
            await this.loadEvalState();
            break;
          }
          if (job.status === 'error') throw new Error(job.error || '评估失败');
        }
      } catch (e) {
        this.askError = '评估失败:' + e.message;
        this.evalRunning = false;
      } finally {
        this.evalRunning = false;
        this.evalStage = '';
      }
    },

    async applyEvalCalibration(s) {
      s.busy = true;
      try {
        await this.api('/api/eval/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: s.q, addTitles: s.suggestedDocs.map((d) => d.title) }),
        });
        s.busy = false;
        await this.loadEvalState();
      } catch (e) {
        s.busy = false;
        alert('应用失败:' + e.message);
      }
    },

    async dismissEvalCalibration(s) {
      s.busy = true;
      await this.api('/api/eval/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: s.q }),
      });
      await this.loadEvalState();
    },

    // 数据存储:占用统计 + 迁移(exe 内可迁;纯浏览器只读展示)
    async loadDataInfo() {
      try {
        this.dataInfo = await this.api('/api/data');
      } catch {
        this.dataInfo = null;
      }
    },

    async moveDataDir() {
      if (!window.sbDesktop?.chooseDataDir) return;
      const target = await window.sbDesktop.chooseDataDir();
      if (!target) return;
      if (!confirm('把全部数据(主库 + 快照)复制到:\n' + target + '\n\n完成后应用会自动重启并切换到新目录。\n迁移期间请勿导入新资料。继续?')) return;
      this.migrating = true;
      this.dataMsg = '迁移中(复制主库与快照)…';
      this.dataOk = false;
      try {
        await this.api('/api/data/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        });
        this.dataMsg = '✔ 迁移完成,应用即将重启并使用新目录';
        this.dataOk = true;
        // 写指针文件并重启:重启后服务即读新目录
        await window.sbDesktop.applyDataDir(target);
      } catch (e) {
        this.dataMsg = '✘ ' + e.message;
        this.migrating = false;
      }
    },

    // 编译层:建议 + 编译
    async loadTopicSuggestions() {
      const region = this.region || 'learning';
      const r = await this.api('/api/topics/suggestions?region=' + region);
      // 建议来自哪个区域,编译就提交到哪个区域 —— 两处区域必须同源
      this.topicSuggestions = r.suggestions.map((s) => ({ ...s, region, busy: false, msg: '' }));
    },

    async compileTopic(s) {
      s.busy = true;
      s.msg = '';
      try {
        const { jobId } = await this.api('/api/topics/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region: s.region, tag: s.slug }),
        });
        s.msg = '编译中…';
        const job = await this.pollLlm(jobId);
        s.msg = `✔ 主题页已${job.result.updated ? '更新' : '生成'}:《${job.result.title}》`;
        this.loadStats();
        if (this.topics.length) this.loadTopics();
      } catch (e) {
        s.msg = '✘ ' + e.message;
      } finally {
        s.busy = false;
      }
    },

    // 规则层
    async loadRules() {
      const r = await this.api('/api/rules');
      this.rulesText = r.rules;
    },
    async saveRules() {
      try {
        await this.api('/api/rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules: this.rulesText }),
        });
        this.rulesMsg = '✔ 已保存,之后的问答/摘要会带上';
      } catch (e) {
        this.rulesMsg = '✘ ' + e.message;
      }
    },

    // 回顾
    async genReview() {
      this.reviewing = true;
      this.reviewContent = '';
      try {
        const { jobId } = await this.api('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region: this.importRegion }),
        });
        const job = await this.pollLlm(jobId, (j) => (this.reviewStage = j.stage));
        this.reviewContent = job.result.content;
      } catch (e) {
        this.reviewContent = '生成失败:' + e.message;
      } finally {
        this.reviewing = false;
      }
    },

    /** LLM 任务(编译/回顾)通用轮询 */
    async pollLlm(jobId, onStage) {
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const job = await this.api('/api/llm/' + jobId);
        if (onStage) onStage(job);
        if (job.status === 'done') return job;
        if (job.status === 'error') throw new Error(job.error || '任务失败');
      }
    },

    async loadInbox() {
      const r = await this.api('/api/inbox');
      // mergeTarget/region 是每条待办的本地选择状态,拼进条目
      this.inbox = r.items.map((it) => ({ ...it, mergeTarget: '', region: 'learning', done: '' }));
      this.resolvedRecent = r.recent;
    },

    async loadTaxonomy(region = this.taxoRegion) {
      const r = await this.api('/api/taxonomy?region=' + region);
      this.taxoByRegion[region] = r.tags;
      if (region === this.taxoRegion) this.taxonomy = r.tags.map((t) => ({ ...t, mergeTo: '' }));
    },

    /** 收件箱里"合并到"的候选:同区域已批准标签,排除自己 */
    mergeTargets(regionSlug, tagName) {
      return (this.taxoByRegion[regionSlug] ?? []).filter((t) => t.status === 'approved' && t.name !== tagName);
    },

    /** 词表管理行:该标签的可合并目标(同区域已批准、排除自己)。为空时不渲染下拉,避免"点了没反应" */
    mergeCandidates(t) {
      return this.approvedTags.filter((x) => x.id !== t.id);
    },

    async resolveInbox(it, body, doneText) {
      try {
        await this.api(`/api/inbox/${it.id}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        it.done = doneText;
        this.loadStats();
        // 兄弟待办会被一并了结;刚批准的标签也要进入"合并到"候选
        this.loadInbox();
        this.loadTaxonomy(it.p.regionSlug || this.taxoRegion);
      } catch (e) {
        it.done = '✘ ' + e.message;
      }
    },

    tagAction(it, action) {
      const names = { approve: `已批准「${it.p.tagName}」`, merge: `已合并到所选标签`, reject: `已拒绝并删除「${it.p.tagName}」` };
      this.resolveInbox(
        it,
        { action, intoTagId: it.mergeTarget ? Number(it.mergeTarget) : undefined },
        '✔ ' + names[action],
      );
    },

    decide(it, value) {
      const zh = { a_active: '以新侧为准', b_active: '以旧侧为准', both_valid: '两者并存' }[value];
      this.resolveInbox(it, { action: 'decide', value }, `✔ 已裁决:${zh}`);
    },

    async retryTagging(it) {
      it.done = '重新打标中…';
      await this.resolveInbox(it, { action: 'retry' }, '✔ 重打完成');
    },

    ignoreInbox(it) {
      this.resolveInbox(it, { action: 'ignore' }, '✔ 已忽略');
    },

    saveFromInbox(it) {
      this.resolveInbox(it, { action: 'save', region: it.region }, '✔ 已入库');
    },

    dropFromInbox(it) {
      this.resolveInbox(it, { action: 'drop' }, '✔ 已丢弃');
    },

    shortTitle(t) {
      return t.length > 14 ? t.slice(0, 14) + '…' : t;
    },
    inboxTypeZh(t) {
      return { tag_review: '标签', conflict_review: '冲突', tagging_failed: '打标', save_review: '暂存' }[t] || t;
    },

    async taxoApprove(t) {
      await this.api('/api/taxonomy/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: t.id }),
      });
      this.loadTaxonomy();
    },
    async taxoMerge(t) {
      try {
        await this.api('/api/taxonomy/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromTagId: t.id, intoTagId: Number(t.mergeTo) }),
        });
        this.loadTaxonomy();
      } catch (e) {
        alert('合并失败:' + e.message);
      }
    },
    async taxoReject(t) {
      if (t.usage && !confirm(`「${t.name}」已绑定 ${t.usage} 篇文档,拒绝会一并摘除这些绑定,确定?`)) return;
      await this.api('/api/taxonomy/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: t.id }),
      });
      this.loadTaxonomy();
    },
    async taxoAdd() {
      const name = this.newTagName.trim();
      if (!name) return;
      try {
        await this.api('/api/taxonomy/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region: this.taxoRegion, name }),
        });
        this.newTagName = '';
        this.loadTaxonomy();
      } catch (e) {
        alert('添加失败:' + e.message);
      }
    },

    async doReset() {
      if (!confirm('真的要清空整个知识库吗?所有文档、标签、待办、关系将全部删除,不可恢复!')) return;
      try {
        await this.api('/api/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: this.resetWord }),
        });
        this.resetMsg = '✔ 已清空重建';
        this.resetOk = true;
        this.resetWord = '';
        this.inbox = [];
        this.loadStats();
        this.loadDocs();
      } catch (e) {
        this.resetMsg = '✘ ' + e.message;
        this.resetOk = false;
      }
    },

    // ── 导入(拖拽 / 选择 / URL)────────────────────────────────
    onDrop(ev) {
      this.dropHover = false;
      if (ev.dataTransfer?.files?.length) this.importFiles(ev.dataTransfer.files);
    },
    onPickFiles(ev) {
      const files = ev.target.files;
      if (files?.length) this.importFiles(files);
      ev.target.value = '';
    },

    async importFiles(fileList) {
      const files = [...fileList].filter(Boolean);
      if (!files.length || this.importing) return;
      this.importing = true;
      this.importResults = [];
      this.importDone = '';
      this.importStage = '准备导入…';
      try {
        if (window.sbDesktop) {
          // 桌面客户端:拿真实路径,一次任务导全部(目录交给服务端展开)
          const paths = [...new Set(files.map((f) => window.sbDesktop.pathForFile(f)).filter(Boolean))];
          if (!paths.length) throw new Error('拿不到文件的本地路径');
          // region 必须显式传:漏传会被后端默认到学习区
          await this.runImportJob({ mode: 'paths', paths, region: this.importRegion });
        } else {
          // 纯浏览器:没有路径,把内容上传到服务端临时文件再导入
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            this.importStage = `上传中 ${i + 1}/${files.length}:${f.name}`;
            const buf = await f.arrayBuffer();
            const qs = new URLSearchParams({
              name: f.name,
              region: this.importRegion,
              tag: this.importTag ? '1' : '0',
              rel: this.importRel ? '1' : '0',
            });
            const { jobId } = await this.api('/api/import/upload?' + qs.toString(), { method: 'POST', body: buf });
            await this.pollImport(jobId);
          }
        }
      } catch (e) {
        this.importDone = '✘ ' + e.message;
      } finally {
        this.importing = false;
        this.loadStats();
        this.loadDocs();
      }
    },

    async importUrl2() {
      const url = this.importUrl.trim();
      if (!url || this.importing) return;
      this.importing = true;
      this.importResults = [];
      this.importDone = '';
      this.importStage = '准备导入…';
      try {
        await this.runImportJob({
          mode: 'url',
          url,
          region: this.importRegion,
          tag: this.importTag,
          rel: this.importRel,
        });
        this.importUrl = '';
      } catch (e) {
        this.importDone = '✘ ' + e.message;
      } finally {
        this.importing = false;
        this.loadStats();
        this.loadDocs();
      }
    },

    async runImportJob(body) {
      const { jobId } = await this.api('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await this.pollImport(jobId);
    },

    async pollImport(jobId) {
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const job = await this.api('/api/import/' + jobId);
        this.importStage = job.stage;
        this.importResults = job.items;
        if (job.status === 'done') {
          const ok = job.items.filter((x) => x.status === 'ok').length;
          const dup = job.items.filter((x) => x.status === 'duplicate').length;
          const fail = job.items.filter((x) => x.status === 'failed').length;
          this.importDone = `✔ 导入完成:成功 ${ok} · 重复跳过 ${dup} · 失败 ${fail}`;
          return;
        }
        if (job.status === 'error') throw new Error(job.error || '导入失败');
      }
    },

    /** 随手记:一条想法直接进库 */
    async importNote() {
      const content = this.noteText.trim();
      if (!content || this.importing) return;
      this.importing = true;
      this.importResults = [];
      this.importDone = '';
      this.importStage = '随手记入库中…';
      try {
        const { jobId } = await this.api('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'note',
            content,
            region: this.importRegion,
            tag: this.importTag,
            rel: this.importRel,
          }),
        });
        await this.pollImport(jobId);
        this.noteText = '';
      } catch (e) {
        this.importDone = '✘ ' + e.message;
      } finally {
        this.importing = false;
        this.loadStats();
        this.loadDocs();
      }
    },

    // ── 文档库:主题视图 + 文档管理 ────────────────────────────
    switchTopics() {
      this.docsView = 'topics';
      this.loadTopics();
    },

    async loadTopics() {
      const r = await this.api('/api/topics?region=' + (this.region || 'learning'));
      this.topics = r.topics;
    },

    topicStale(t) {
      return t.stale === true;
    },

    async openTopic(id) {
      this.activeTopic = await this.api('/api/topics/' + id);
      this.topicMsg = '';
      requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    },

    async recompileTopic() {
      if (!this.activeTopic) return;
      this.topicMsg = '重编译中…';
      try {
        const { jobId } = await this.api('/api/topics/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region: this.activeTopic.region_id === 1 ? 'learning' : 'work', tag: this.activeTopic.slug }),
        });
        const job = await this.pollLlm(jobId);
        this.topicMsg = `✔ 已重编译(基于 ${this.activeTopic.docs.length} 篇)`;
        await this.openTopic(job.result.topicId);
        this.loadTopics();
      } catch (e) {
        this.topicMsg = '✘ ' + e.message;
      }
    },

    async deleteTopic(id) {
      if (!confirm('删除这个主题页?(它是派生物,随时可重新编译,原文不受影响)')) return;
      await this.api('/api/topics/' + id + '/delete', { method: 'POST' });
      if (this.activeTopic?.id === id) this.activeTopic = null;
      this.loadTopics();
    },

    viewSnapshot(id) {
      window.open('/api/doc/' + id + '/snapshot', '_blank');
    },

    async deleteDoc(doc) {
      if (!confirm(`确定删除《${doc.title}》?\n它的分块、标签绑定、关系边会一并删除,快照文件也会删掉。`)) return;
      try {
        await this.api('/api/doc/' + doc.id + '/delete', { method: 'POST' });
        this.activeDoc = null;
        this.loadDocs();
        this.loadStats();
      } catch (e) {
        alert('删除失败:' + e.message);
      }
    },

    /** 开发场景模板(源自 09 技术思维的选型模板) */
    applyScene(kind) {
      const templates = {
        compare:
          '【选型对比】请针对下面的问题给出 2~3 个候选方案,分别说明优势、代价与风险,并各给出一个更简单的替代;最后列出仍需要我自己决定的问题。\n\n问题:',
        evaluate:
          '【方案评估】请评估以下方案:从必要性、代价、维护风险、有没有更简单的替代四个角度分析;如果结论是"根本不需要",请直说。\n\n方案:',
      };
      const t = templates[kind];
      if (!t) return;
      this.question = this.question.trim() ? t + '\n' + this.question.trim() : t + '\n';
    },

    // ── 文档库 ────────────────────────────────────────────────
    async searchDocs() {
      const q = this.docSearchQ.trim();
      if (!q) return;
      this.lastSearchQ = q;
      const r = await this.api('/api/search?q=' + encodeURIComponent(q) + (this.region ? `&region=${this.region}` : ''));
      this.searchResults = r.docs;
    },

    async openDoc(id) {
      this.activeDoc = await this.api('/api/doc/' + id);
      // 详情面板插在列表后,滚过去让用户立刻看到
      requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    },
    openDocFromCite(docId) {
      this.tab = 'docs';
      this.openDoc(docId);
    },

    jumpCite(ev, ti) {
      const sup = ev.target.closest('.cite');
      if (!sup) return;
      // 引用角标按轮次编号:在所在会话卡片范围内找对应出处
      const scope = ev.target.closest('.turn-card') || document;
      const el = scope.querySelector('#cite-' + ti + '-' + sup.dataset.n);
      if (el) {
        const fold = el.closest('details');
        if (fold) fold.setAttribute('open', ''); // 引用默认折叠,点角标自动展开
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },

    regionName(slug) {
      const r = this.regions.find((x) => x.slug === slug);
      return r ? r.name : slug;
    },
    relZh(t) {
      return { similar: '相似', conflict: '冲突', supplement: '补充' }[t] || t;
    },
    parseKp(json) {
      try {
        return JSON.parse(json);
      } catch {
        return [];
      }
    },
  },

  async mounted() {
    this.regions = (await this.api('/api/regions')).regions;
    this.taxoRegion = this.regions[0]?.slug ?? 'learning';
    await Promise.all([this.loadStats(), this.loadDocs(), this.loadInbox()]);
  },
}).mount('#app');
