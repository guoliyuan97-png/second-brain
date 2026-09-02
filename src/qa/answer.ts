/**
 * 归纳问答:检索 → 组装材料 → LLM 归纳 → 引用后处理。
 *
 * 成本设计(与 W1 的打标摘要呼应):摘要层是入库时花过一次钱生成的,
 * 问答时零成本复用 —— 先给模型"每篇文档讲什么"的全局图景(key_points),
 * 再给"具体在哪段"的原文片段(chunk)。检索本身零 token。
 *
 * 防幻觉靠两头夹:
 * - 提示词只允许依据材料作答 + 编号引用;
 * - 校验器 + 后处理把材料里不存在的 [n] 直接从答案里摘掉
 *   (编号是系统编的,材料外编号一律视为幻觉标记)。
 */
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getRules } from '../db/settings.js';
import { topicsForDocs } from '../topics/compile.js';
import { callJson, streamChat } from '../llm/client.js';
import { retrieveForQa, type RetrievedChunk } from '../search/retriever.js';

export interface QaCitation {
  n: number;
  chunkId: number;
  docId: number;
  title: string;
  headingPath: string;
  snippet: string;
  /** 检索来源路:词面(fts/like)/语义(vector)/混合(both)—— 混合召回的可解释性标注 */
  via?: string;
}

export interface QaResult {
  question: string;
  answer: string;
  /** false = 库里没有足够材料,answer 是"缺什么"的说明 */
  sufficient: boolean;
  citations: QaCitation[];
  /** 本次回答用到的文档及其 key_points(摘要层,前端可折叠展示) */
  usedDocs: { id: number; title: string; keyPoints: string[] }[];
  /** 命中文档之间存在未裁决冲突(产品原则:照常回答,但必须标注) */
  conflictNotes: string[];
  retrieval: { retriever: string; candidates: number };
  /** 反思自检(W7.1)。undefined = 未启用或无可校验引用 */
  reflection?: ReflectionResult;
}

/** 自检发现的一处引用疑点:n=被质疑的编号,reason=论断与片段哪里对不上 */
export interface ReflectionIssue {
  n: number;
  reason: string;
}

/** 反思自检结果:checked=首轮校验的引用数;issues=首轮发现的问题;revised=是否已带原因重试并采纳修订稿 */
export interface ReflectionResult {
  checked: number;
  issues: ReflectionIssue[];
  revised: boolean;
}

const SYSTEM_PROMPT = `你是个人知识库的问答助手,根据给定材料回答问题。规则:
1. 只依据【文档摘要】和【原文片段】作答,禁止编造材料之外的内容;
2. 关键论断末尾标注来源编号,如 [2],编号只能取【原文片段】中方括号里的数字;
3. 不同论断若来自不同片段,必须各标各的编号,严禁把多处内容都标成同一个编号;
4. 综合多篇片段时逐条标注;【文档摘要】只用来建立全局理解,不给编号;
5. 材料不足或问题时,如实说明缺少什么,不要硬答;
6. 用简体中文,纯文本分点作答(用 1. 2. 3. 或 - 开头),不要用 markdown 标题、加粗等格式语法。
直接输出回答正文(不要 JSON、不要代码块包裹)。是否"材料足以回答"由系统根据引用情况判定。`;

/** 摘录:压平空白 + 截断,控制喂给 LLM 的材料体积 */
function snippetOf(content: string, maxChars: number): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** 命中文档聚合:按"命中条数 + 最好名次"排,取 top N 篇 */
function rankDocs(hits: RetrievedChunk[], maxDocs: number): number[] {
  const stat = new Map<number, { count: number; best: number }>();
  hits.forEach((h, i) => {
    const s = stat.get(h.docId) ?? { count: 0, best: i };
    s.count++;
    stat.set(h.docId, s);
  });
  return [...stat.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].best - b[1].best)
    .slice(0, maxDocs)
    .map(([docId]) => docId);
}

/** usedDocs 之间的未裁决冲突(产品原则 4:不阻塞回答,但必须标注) */
function findUndecidedConflicts(docIds: number[]): string[] {
  const notes: string[] = [];
  for (let i = 0; i < docIds.length; i++) {
    for (let j = i + 1; j < docIds.length; j++) {
      const a = docIds[i]!;
      const b = docIds[j]!;
      const rows = db
        .prepare(
          `SELECT note, da.title AS ta, db2.title AS tb
           FROM relations re
           JOIN documents da ON da.id = re.doc_a
           JOIN documents db2 ON db2.id = re.doc_b
           WHERE re.type = 'conflict' AND re.status = 'undecided'
             AND ((re.doc_a = ? AND re.doc_b = ?) OR (re.doc_a = ? AND re.doc_b = ?))`,
        )
        .all(a, b, b, a) as unknown as { note: string; ta: string; tb: string }[];
      for (const r of rows) notes.push(`《${r.ta}》与《${r.tb}》存在未裁决冲突:${r.note}(回答按默认策略综合两者,裁决见收件箱)`);
    }
  }
  return notes;
}

/** 一轮历史:问题 + 回答(截断),用于追问的指代补全与上下文回答 */
export interface QaHistoryTurn {
  q: string;
  a: string;
}

const CONDENSE_SYSTEM = `把多轮对话中的【最新问题】改写成一句独立、自含的检索问题:补全代词(它/这个/上面说的)的指向,合并可省略的上文信息。
最新问题本身已独立完整时,原样返回。检索问题要短(80 字以内),只输出 JSON:{"question":"…"}`;

/** 追问的指代补全:用历史把"它怎么部署"改写成"MCP 协议怎么部署"。失败静默降级为原问题 */
async function condenseQuestion(question: string, history: QaHistoryTurn[]): Promise<string> {
  if (history.length === 0) return question;
  try {
    const hist = history
      .slice(-3)
      .map((h) => `问:${h.q}\n答:${h.a.slice(0, 300)}`)
      .join('\n');
    const r = await callJson<{ question: string }>({
      system: CONDENSE_SYSTEM,
      user: `【对话历史】\n${hist}\n\n【最新问题】${question}`,
      validate: (v) => {
        if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
        const q = String((v as Record<string, unknown>).question ?? '').trim();
        if (q.length < 2 || q.length > 120) return 'question 应为 2~120 字';
        return { question: q };
      },
      maxTokens: 300,
    });
    return r.question;
  } catch {
    return question; // 改写失败不阻塞:退化为原问题检索
  }
}

export interface QaStreamEvent {
  type: 'stage'; stage: string;
}

// ── 反思自检(W7.1):生成后对照引用原文逐条校验 ─────────────────────
//
// 提示词防得住"凭空编造",防不住"张冠李戴":模型可能把 A 片段的结论
// 错标成 [2](其实出自 [5]),或给片段里没有的数字安上引用。确定性校验器
// 只能查"编号存在不存在",查不了"论断与片段是否自洽" —— 这是语义判定,
// 交给一次便宜的结构化 LLM 调用。只报问题不报通过(输出面小,误判率低);
// 发现问题把清单喂回去重试一次;校验链路本身故障则原答案照常返回
// (与全库一致的失败哲学:降级,不阻塞)。

const REFLECT_SYSTEM = `你是引用校验员。对照【引用片段】逐条检查【回答】里的 [n] 标记:每个 [n] 前面的论断,是否真的被片段 n 支持?
判定为问题,只有三种:论断与片段相矛盾;数字/结论/主体对不上;片段里根本没有该内容(可能出自别的片段或凭空而来)。
同义改写不算问题 —— 片段写"质量会直线下降"、论断写"质量下降"是同一个意思;措辞不完全一致但语义等价的一律放行。
拿不准的不要报,只报你确定的问题;回答里没标 [n] 的论断不查。没有问题就输出空数组。
只输出 JSON:{"issues":[{"n":2,"reason":"片段讲的是A方案,论断说的是B方案"}]}`;

/** 校验回答的 [n] 引用;返回发现的问题(编号已对照材料过滤)。校验调用失败由调用方兜底 */
export async function reflectCitations(question: string, answer: string, citations: QaCitation[]): Promise<ReflectionIssue[]> {
  const validN = new Set(citations.map((c) => c.n));
  const r = await callJson<{ issues: ReflectionIssue[] }>({
    system: REFLECT_SYSTEM,
    user: `【问题】${question}\n\n【回答】\n${answer}\n\n【引用片段】\n${citations
      .map((c) => `[${c.n}]《${c.title}》:${c.snippet}`)
      .join('\n\n')}`,
    validate: (v) => {
      if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
      const raw = (v as Record<string, unknown>).issues;
      if (!Array.isArray(raw)) return 'issues 应为数组';
      const issues: ReflectionIssue[] = [];
      for (const it of raw) {
        if (!it || typeof it !== 'object') continue;
        const o = it as Record<string, unknown>;
        const n = Number(o.n);
        const reason = String(o.reason ?? '').trim();
        if (validN.has(n) && reason) issues.push({ n, reason: reason.slice(0, 60) });
      }
      return { issues: issues.slice(0, 5) }; // 问题清单只用来指导一次重试,罗列太多反而失焦
    },
    maxTokens: 600,
  });
  return r.issues;
}

export async function answerQuestion(
  question: string,
  opts: {
    regionSlug?: string;
    history?: QaHistoryTurn[];
    /** 传入则走流式:阶段与增量通过回调推给调用方(SSE/CLI 均可消费) */
    onEvent?: (e: { type: 'stage'; stage: string } | { type: 'delta'; full: string }) => void;
  } = {},
): Promise<QaResult> {
  opts.onEvent?.({ type: 'stage', stage: opts.history?.length ? '整理问题上下文…' : '理解问题…' });
  // 追问:先补全指代再检索,否则"它怎么部署"按字面检索必然落空
  const standalone = await condenseQuestion(question, opts.history ?? []);
  opts.onEvent?.({ type: 'stage', stage: '检索知识库…' });
  const recall = await retrieveForQa(standalone, { limit: config.qaTopK, regionSlug: opts.regionSlug });
  const hits = recall.chunks;

  const base: QaResult = {
    question,
    answer: '',
    sufficient: false,
    citations: [],
    usedDocs: [],
    conflictNotes: [],
    retrieval: { retriever: 'fts+like2gram+summary', candidates: hits.length },
  };
  if (hits.length === 0 && recall.summaryDocIds.length === 0) {
    return {
      ...base,
      answer: '知识库中没有检索到与该问题相关的内容。可以先确认关键词,或把相关资料导入后再试。',
      sufficient: false,
    };
  }

  const docIds = rankDocs(hits, config.qaMaxDocs);
  // 摘要层召回的文档排在词面命中文档之后(它们只有摘要有据)
  for (const id of recall.summaryDocIds) {
    if (!docIds.includes(id) && docIds.length < config.qaMaxDocs) docIds.push(id);
  }

  // 摘要层:入库时已生成的 key_points,给模型全局图景
  const usedDocs = docIds.map((docId) => {
    const d = db.prepare('SELECT id, title FROM documents WHERE id = ?').get(docId) as
      | { id: number; title: string }
      | undefined;
    const s = db.prepare('SELECT key_points FROM summaries WHERE document_id = ?').get(docId) as
      | { key_points: string }
      | undefined;
    return {
      id: docId,
      title: d?.title ?? `#${docId}`,
      keyPoints: s ? (JSON.parse(s.key_points) as string[]) : [],
    };
  });

  // 原文层:只取属于 top 文档的命中 chunk,编号 [1..N] 连续。
  // 按文档配额轮转选取(而不是全序取前 N):否则一篇文档的高分 chunk
  // 会挤占整个材料,模型就退化成"单文档摘要机",失去归纳的价值。
  const perDocCap = Math.max(2, Math.ceil(config.qaMaxChunks / Math.max(docIds.length, 1)));
  const perDocCount = new Map<number, number>();
  const selected: RetrievedChunk[] = [];
  for (const h of hits) {
    if (!docIds.includes(h.docId) || selected.length >= config.qaMaxChunks) continue;
    const used = perDocCount.get(h.docId) ?? 0;
    if (used >= perDocCap) continue;
    perDocCount.set(h.docId, used + 1);
    selected.push(h);
  }
  const citations: QaCitation[] = selected.map((h, i) => ({
    n: i + 1,
    chunkId: h.chunkId,
    docId: h.docId,
    title: h.title,
    headingPath: h.headingPath,
    snippet: snippetOf(h.content, config.qaChunkSnippetChars),
    via: h.via,
  }));

  const conflictNotes = findUndecidedConflicts(docIds);

  // 编译层注入:命中文档已有主题结论页时,结论作为"成品"放在材料最前 ——
  // 文档 06 的"查询时先看索引,再读知识页,复用已有结论"
  const compiled = topicsForDocs(docIds);
  const compiledBlock = compiled.length
    ? `\n\n【编译结论】(系统已综合的主题页,结论可直接复用;引用编号仍只标原文片段)\n${compiled
        .map((t) => `《${t.title}》:\n${t.content}`)
        .join('\n\n')}`
    : '';
  const rules = getRules();
  const rulesBlock = rules ? `\n\n【主人画像与规则】回答请贴合这些个人约束:\n${rules}` : '';
  // 追问上下文:让回答接得住"那第 2 点展开说说"这类话
  const historyBlock =
    opts.history && opts.history.length > 0
      ? `\n\n【对话上下文】(回答要与前文衔接;用户说"上面/刚才/第几点"时指这里)\n${opts.history
          .slice(-3)
          .map((h) => `问:${h.q}\n答:${h.a.slice(0, 400)}`)
          .join('\n---\n')}`
      : '';

  const summaryBlock = usedDocs
    .map((d) => `#${d.id}《${d.title}》要点:\n${d.keyPoints.map((k) => `- ${k}`).join('\n') || '(无摘要)'}`)
    .join('\n\n');
  const chunkBlock = citations
    .map((c) => `[${c.n}]《${c.title}》「${c.headingPath || '正文'}」:\n${c.snippet}`)
    .join('\n\n');
  const conflictBlock = conflictNotes.length ? `\n\n【未裁决冲突提示】\n${conflictNotes.join('\n')}` : '';
  const noChunkNote =
    citations.length === 0 ? '\n\n注意:本次没有原文片段,只凭摘要回答,不要输出任何引用编号。' : '';

  // 提示词组装与 JSON 校验器提出来:反思自检的重试要用同一份材料再生成一次
  const buildUserPrompt = (extra: string): string =>
    `【问题】${question}${rulesBlock}${historyBlock}\n\n【文档摘要】\n${summaryBlock}${compiledBlock}\n\n【原文片段】\n${chunkBlock || '(无)'}${conflictBlock}${noChunkNote}${extra}`;
  const validateAnswerJson = (v: unknown): { answer: string; sufficient: boolean } | string => {
    if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
    const o = v as Record<string, unknown>;
    if (typeof o.answer !== 'string' || !o.answer.trim()) return 'answer 应为非空字符串';
    if (typeof o.sufficient !== 'boolean') return 'sufficient 应为 boolean';
    // 引用编号合法性不在校验器里卡重试:后处理摘除即可,省一次往返
    return { answer: o.answer.trim(), sufficient: o.sufficient };
  };

  let llmAnswer: string;
  let sufficient: boolean;
  try {
    // 流式:纯文本回答 + [n] 引用标记,后处理统一做引用清洗。
    // 结构化输出的校验重试只在"有明确 JSON 契约"的场景才有意义,问答正文是自由文本,
    // 由 onDelta 实时推给前端;失败走下方兜底(把检索片段直接给用户)。
    if (opts.onEvent) {
      opts.onEvent({ type: 'stage', stage: '生成回答…' });
      llmAnswer = await streamChat({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(''),
        maxTokens: 2000,
        onDelta: (full) => opts.onEvent?.({ type: 'delta', full }),
      });
      // sufficient 由系统判定:回答里带有合法引用编号即视为有据可答
      const probe = new Set(citations.map((c) => c.n));
      sufficient = [...llmAnswer.matchAll(/\[(\d{1,2})\]/g)].some((m) => probe.has(Number(m[1])));
    } else {
      const r = await callJson<{ answer: string; sufficient: boolean }>({
        system: SYSTEM_PROMPT + '\n只输出 JSON:{"answer":"…","sufficient":true}(sufficient 表示材料是否足以回答)',
        user: buildUserPrompt(''),
        validate: validateAnswerJson,
        maxTokens: 2000,
      });
      llmAnswer = r.answer;
      sufficient = r.sufficient;
    }
  } catch (e) {
    // 问答失败不吞掉检索成果:把命中的片段直接给用户,用户自己看原文也是价值
    const error = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      usedDocs,
      citations,
      conflictNotes,
      answer: `⚠ 归纳失败:${error}\n以下为检索到的原文片段,可直接参考:\n\n${citations
        .map((c) => `[${c.n}]《${c.title}》「${c.headingPath || '正文'}」:${c.snippet}`)
        .join('\n\n')}`,
      sufficient: false,
    };
  }

  // 后处理:摘掉材料外编号(幻觉标记),保留有效编号并按出现顺序排引用
  const validN = new Set(citations.map((c) => c.n));
  const cleanOf = (answer: string): { text: string; finalCitations: QaCitation[] } => {
    const used = new Set<number>();
    const text = answer.replace(/\[(\d{1,2})\]/g, (whole, num) => {
      const n = Number(num);
      if (!validN.has(n)) return ''; // [99] 这种材料外编号 → 摘除
      used.add(n);
      return whole;
    });
    return { text, finalCitations: [...used].sort((a, b) => a - b).map((n) => citations[n - 1]!) };
  };
  let final = cleanOf(llmAnswer);

  // 反思自检(W7.1):对照引用原文逐条校验 [n] 论断,不自洽带原因重试一次。
  // 只校"真的用了引用"的回答 —— 无编号(材料不足/纯摘要)没有可校验对象;
  // 修订稿必须还保住 ≥1 个合法引用才采纳(把引用全删光的"修订"不如保留原稿亮出问题);
  // 自检链路本身故障则原答案照常返回(降级不阻塞)。
  let reflection: ReflectionResult | null = null;
  if (config.qaReflect && final.finalCitations.length > 0) {
    try {
      const issues = await reflectCitations(
        question,
        final.text,
        // 校验对照的是 chunk 原文而不是 500 字摘录:摘录截断之外的合法支撑
        // 会被误判"片段里没有"(实测首日就误报过),自检要对齐"原文"这个标准
        citations.map((c) => {
          const row = db.prepare('SELECT content FROM chunks WHERE id = ?').get(c.chunkId) as
            | { content: string }
            | undefined;
          return row ? { ...c, snippet: row.content } : c;
        }),
      );
      reflection = { checked: final.finalCitations.length, issues, revised: false };
      if (issues.length > 0) {
        opts.onEvent?.({ type: 'stage', stage: `自检发现 ${issues.length} 处引用不自洽,重新作答…` });
        const fix =
          `\n\n【上次回答的自检问题】下列引用被判定与原文不自洽,修正方式:改论断、改标正确的编号、或删掉该论断` +
          `(其余未点名的内容保持原样):\n${issues.map((i) => `- [${i.n}] ${i.reason}`).join('\n')}`;
        if (opts.onEvent) {
          // 流式路径同步重流:前端 delta 是整段替换,修订稿自然覆盖已显示的回答
          const retry = await streamChat({
            system: SYSTEM_PROMPT,
            user: buildUserPrompt(fix),
            maxTokens: 2000,
            onDelta: (full) => opts.onEvent?.({ type: 'delta', full }),
          });
          const r = cleanOf(retry);
          if (r.text.trim() && r.finalCitations.length > 0) {
            final = r;
            sufficient = true; // 修订稿保住合法引用,与流式"有据可答"判定一致
            reflection.revised = true;
          }
        } else {
          const retry = await callJson<{ answer: string; sufficient: boolean }>({
            system: SYSTEM_PROMPT + '\n只输出 JSON:{"answer":"…","sufficient":true}(sufficient 表示材料是否足以回答)',
            user: buildUserPrompt(fix),
            validate: validateAnswerJson,
            maxTokens: 2000,
          });
          const r = cleanOf(retry.answer);
          if (r.text.trim() && r.finalCitations.length > 0) {
            final = r;
            sufficient = retry.sufficient;
            reflection.revised = true;
          }
        }
      }
    } catch {
      reflection = null; // 校验调用挂了:不持有半截信息,原答案照常
    }
  }

  return {
    ...base,
    answer: final.text,
    sufficient,
    citations: final.finalCitations,
    usedDocs,
    conflictNotes,
    ...(reflection ? { reflection } : {}),
  };
}
