/**
 * MCP Server(W7):把 second-brain 的四项核心能力通过 stdio 暴露给任意 MCP 客户端
 * (Claude Desktop / 其它 agent)。业务逻辑零重写 —— 直接复用 Web/CLI 背后的
 * 同一批模块(retriever / answer / research / topics),"同一套业务的第三张皮"。
 *
 * stdio 纪律(教学重点):MCP stdio 传输里,stdout 是 JSON-RPC 协议通道,
 * 任何业务日志混进 stdout 都会让客户端解析失败甚至断连。所以入口第一件事
 * 就是把 console.log/warn 重定向到 stderr;transformers.js 等第三方库的杂音
 * 同理被这道闸拦住。
 *
 * 与 Web 版的运行差异:
 * - 不起 HTTP、不做启动备份(备份是桌面端的首跑职责;WAL 模式下两个进程
 *   并行打开同一个库是安全的,桌面端开着时 MCP 也能读);
 * - 向量缓存是进程内存 —— 本进程启动后别处新入库的资料,重启 MCP 会话可见;
 * - 启动后照常触发一次向量补全(缺什么补什么;已齐时只查一次库就退出,
 *   不会加载嵌入模型,开销近乎为零)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DATA_DIR, config } from '../config.js';
import { db } from '../db/index.js';
import { ensureRegions, listRegions, getRegionBySlug } from '../tagging/taxonomy.js';
import { retrieveForQa } from '../search/retriever.js';
import { answerQuestion } from '../qa/answer.js';
import { runResearch } from '../research/pipeline.js';
import { listTopics, getTopic } from '../topics/compile.js';
import { embeddingsStatus, requestBackfill } from '../embedding/embedding.js';

// ── stdio 纪律:stdout 只允许协议帧 ─────────────────────────────────
console.log = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** 文本结果(MCP 的 CallToolResult);isError=true 时客户端把内容当错误呈现 */
function text(t: string, isError = false): { content: [{ type: 'text'; text: string }]; isError: boolean } {
  return { content: [{ type: 'text', text: t }], isError };
}

/** 阶段 → progress 通知:客户端带了 progressToken 才发,没有就静默 */
function progressSender(extra: ToolExtra): (stage: string) => Promise<void> {
  const token = extra._meta?.progressToken;
  let step = 0;
  return async (stage) => {
    if (token === undefined) return;
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: ++step, message: stage.slice(0, 120) },
      });
    } catch {
      /* 客户端可能已断开:进度发不出去不重要,别打断研究 */
    }
  };
}

/** 统一错误呈现:给客户端的 LLM 一句可读的原因(如 LLM key 未配置),而不是裸栈 */
function errText(e: unknown): ReturnType<typeof text> {
  const msg = e instanceof Error ? e.message : String(e);
  return text(`执行失败:${msg}`, true);
}

/** region 参数 → 区域校验。返回错误文案或 undefined */
function regionError(region?: string): string | undefined {
  if (!region) return undefined;
  return getRegionBySlug(region) ? undefined : `区域「${region}」不存在(可选:${listRegions().map((r) => r.slug).join('/')})`;
}

const server = new McpServer({ name: 'second-brain', version: '0.1.0' });

// ── 工具 1:search_knowledge(零 token 混合检索) ────────────────────
server.registerTool(
  'search_knowledge',
  {
    title: '知识库检索',
    description:
      '在主人的个人知识库里做混合检索(FTS 词面 + 本地向量语义,RRF 融合),不调用 LLM、零成本。' +
      '返回按文档聚合的命中片段(带标题/小节/摘录/命中路径),适合先摸清库里有什么、找原文出处。',
    inputSchema: {
      query: z.string().min(1).describe('检索词或自然语言问题'),
      region: z.string().optional().describe('限定区域 slug(learning/work),不传则查全库'),
      limit: z.number().int().min(1).max(20).optional().describe('返回文档数上限,默认 5'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, region, limit }) => {
    try {
      const rErr = regionError(region);
      if (rErr) return text(rErr, true);
      const recall = await retrieveForQa(query, { limit: 24, regionSlug: region });
      const maxDocs = limit ?? 5;
      const docs = new Map<number, { title: string; hits: string[] }>();
      for (const h of recall.chunks) {
        let d = docs.get(h.docId);
        if (!d) {
          d = { title: h.title, hits: [] };
          docs.set(h.docId, d);
        }
        if (d.hits.length < 3) {
          d.hits.push(`「${h.headingPath || '正文'}」(${h.via}):${h.content.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
      }
      const lines = [...docs.entries()].slice(0, maxDocs).map(
        ([docId, d], i) => `## ${i + 1}.《${d.title}》(docId=${docId})\n${d.hits.map((h) => `- ${h}`).join('\n')}`,
      );
      const summaryOnly = recall.summaryDocIds
        .map((id) => {
          const d = db.prepare('SELECT title FROM documents WHERE id = ?').get(id) as { title: string } | undefined;
          return d?.title ?? `#${id}`;
        })
        .filter(Boolean);
      const head = `检索「${query}」:${lines.length} 篇文档命中` +
        (summaryOnly.length ? `;另有仅摘要层命中的 ${summaryOnly.length} 篇:${summaryOnly.join('、')}(无编号片段,只有要点)` : '');
      if (lines.length === 0 && summaryOnly.length === 0) return text(`检索「${query}」:知识库中没有命中内容。可换关键词,或确认相关资料是否已导入。`);
      return text(`${head}\n\n${lines.join('\n\n')}`);
    } catch (e) {
      return errText(e);
    }
  },
);

// ── 工具 2:ask_knowledge(带引用的归纳问答) ────────────────────────
server.registerTool(
  'ask_knowledge',
  {
    title: '知识库问答',
    description:
      '归纳问答:检索知识库 → LLM 综合作答,关键论断带 [n] 编号引用,引用与来源原文片段强绑定(防幻觉)。' +
      '耗时约 5~20 秒。追问时可传 history 帮助指代补全("它怎么部署"里的"它")。',
    inputSchema: {
      question: z.string().min(1).describe('要问的问题'),
      region: z.string().optional().describe('限定区域 slug(learning/work),不传则查全库'),
      history: z
        .array(z.object({ q: z.string(), a: z.string() }))
        .max(4)
        .optional()
        .describe('最近几轮对话(问/答),多轮追问时提供'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ question, region, history }) => {
    try {
      const rErr = regionError(region);
      if (rErr) return text(rErr, true);
      const qa = await answerQuestion(question, { regionSlug: region, history });
      const cites = qa.citations
        .map((c) => `[${c.n}]《${c.title}》「${c.headingPath || '正文'}」(${c.via ?? 'fts'}):${c.snippet}`)
        .join('\n');
      const parts = [qa.answer];
      if (cites) parts.push(`—— 来源引用 ——\n${cites}`);
      // 自检修订过的事实对 agent 消费方有价值:它该知道这份回答是第二稿
      if (qa.reflection?.revised)
        parts.push(
          `(注:引用自检发现首稿 ${qa.reflection.issues.length} 处论断与原文不自洽,已修正重答:${qa.reflection.issues.map((i) => `[${i.n}] ${i.reason}`).join(';')})`,
        );
      if (qa.conflictNotes.length) parts.push(`⚠ 未裁决冲突(回答按默认策略综合,裁决见整理台):\n${qa.conflictNotes.join('\n')}`);
      if (!qa.sufficient) parts.push('(注:系统判定材料不足以充分回答,以上为现有知识库能给出的部分)');
      return text(parts.join('\n\n'));
    } catch (e) {
      return errText(e);
    }
  },
);

// ── 工具 3:run_research(深度研究,长任务 + 进度通知) ───────────────
server.registerTool(
  'run_research',
  {
    title: '深度研究',
    description:
      'Deep Research:LLM 生成检索词计划 → 联网搜索 → 抓正文 → 要点提取 → 带引用报告。' +
      '全程联网、多次 LLM 调用,耗时约 1~3 分钟,阶段进度通过 progress 通知推送。' +
      '报告只返回不自动入库 —— 沉淀进知识库请用桌面端的整理台(裁决权在主人)。',
    inputSchema: {
      question: z.string().min(1).describe('研究问题,越具体越好'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ question }, extra) => {
    try {
      const onStage = progressSender(extra);
      const r = await runResearch(question, { onStage: (s) => void onStage(s) });
      const sources = r.sources.map((s) => `[${s.n}]《${s.title}》 ${s.finalUrl}`).join('\n');
      const secs = Math.round(r.stats.durationMs / 1000);
      const parts = [r.report];
      if (sources) parts.push(`—— 来源 ——\n${sources}`);
      parts.push(
        `—— 统计 —— 检索词:${r.stats.queries.join(' / ')} | 搜索命中 ${r.stats.searchHits} | 抓取 ${r.stats.fetched} | 采用 ${r.stats.usedSources} | 耗时 ${secs}s` +
          (r.failed.length ? `(失败来源 ${r.failed.length} 个,已跳过)` : ''),
      );
      return text(parts.join('\n\n'));
    } catch (e) {
      return errText(e);
    }
  },
);

// ── 工具 4:list_topics(编译层主题结论页) ──────────────────────────
server.registerTool(
  'list_topics',
  {
    title: '主题结论页',
    description:
      '查看知识库编译层产出的主题结论页(同主题多篇文档经 LLM 综合的一页 Markdown 结论,引用回来源文档)。' +
      '不带参数=列全部主题;带 topic_id=取该主题页全文。',
    inputSchema: {
      region: z.string().optional().describe('限定区域 slug(learning/work),不传则列全部区域'),
      topicId: z.number().int().optional().describe('传入主题 id 则返回该主题页全文'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ region, topicId }) => {
    try {
      const rErr = regionError(region);
      if (rErr) return text(rErr, true);
      if (topicId !== undefined) {
        const t = getTopic(topicId);
        if (!t) return text(`主题 #${topicId} 不存在`, true);
        return text(
          `《${t.title}》(topicId=${t.id},slug=${t.slug},更新于 ${t.updated_at})\n来源文档:${t.docs.map((d) => `《${d.title}》(#${d.id})`).join('、') || '(无)'}\n\n${t.content}`,
        );
      }
      const regions = region ? [getRegionBySlug(region)!] : listRegions();
      const lines: string[] = [];
      for (const r of regions) {
        for (const t of listTopics(r.id)) {
          lines.push(`- topicId=${t.id} [${r.slug}] ${t.title}(${t.docCount} 篇文档,更新于 ${t.updated_at})`);
        }
      }
      if (lines.length === 0) return text('知识库还没有编译出任何主题结论页。可以在桌面端整理台对同标签 ≥2 篇文档的主题做编译。');
      return text(`共 ${lines.length} 个主题结论页:\n${lines.join('\n')}\n\n用 topicId 参数可取某一页的全文。`);
    } catch (e) {
      return errText(e);
    }
  },
);

// ── 入口:与 Web 版同款的初始化序列(减去 HTTP/备份) ─────────────────
ensureRegions(); // 幂等:全新数据目录也有区域种子
setTimeout(() => requestBackfill(), 3000); // 向量补全(已齐时只查一次库,不加载模型)

const transport = new StdioServerTransport();
await server.connect(transport);
const docCount = (db.prepare('SELECT COUNT(*) n FROM documents').get() as unknown as { n: number }).n;
const emb = embeddingsStatus();
console.error(
  `[second-brain] MCP 已启动(stdio):4 个工具 | 数据目录:${DATA_DIR}(${docCount} 篇文档) | ` +
    `向量:${emb.provider} ${emb.embedded}/${emb.total} | LLM:${config.llm.model}`,
);
