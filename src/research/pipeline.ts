/**
 * Deep Research 编排:检索词计划 → 联网搜索 → 抓正文 → 要点提取 → 带引用报告。
 *
 * 与导入管线(W1)的分工:导入腿是"用户把资料递进来",研究腿是
 * "系统自己去网上找"。两腿在沉淀时汇合 —— 报告和来源走同一条
 * ingest 管线入库,与旧知识自动做关系对比。
 *
 * 失败哲学与全库一致:单页抓取失败、单篇要点提取失败都只降级
 * (少一个来源),绝不因个别页面把整个研究任务打断;
 * 唯一的整体失败点是"一个可用来源都没有"。
 */
import { config } from '../config.js';
import { callJson, expectStringArray } from '../llm/client.js';
import { fetchArticle, type FetchedArticle } from '../parse/url.js';
import { bingSearch, type SearchProvider } from './search.js';

export interface ResearchSource {
  n: number;
  url: string;
  finalUrl: string;
  title: string;
  /** 与研究问题相关的要点(要点提取失败/无关的来源为空,不参与报告材料) */
  points: string[];
  /** 沉淀入库时免二次抓取;不序列化到 Web 响应(含 rawHtml,很大) */
  article: FetchedArticle;
}

export interface FailedSource {
  url: string;
  stage: 'search' | 'fetch' | 'points';
  error: string;
}

export interface ResearchResult {
  question: string;
  report: string;
  sources: ResearchSource[];
  failed: FailedSource[];
  stats: { queries: string[]; searchHits: number; fetched: number; usedSources: number; durationMs: number };
}

export type StageReporter = (stage: string) => void;

const noop: StageReporter = () => {};

// ── 第 1 步:检索词计划 ────────────────────────────────────────────
// 让 LLM 把一个研究问题拆成多组搜索词:覆盖不同侧面、术语给英文,
// 比单查一把命中率高得多。这是研究管线里唯一"动脑"的起点。

const PLAN_SYSTEM = `为深度研究生成搜索关键词。要求:
1. 3~5 组,每组 2~24 字,中英文皆可(技术术语用英文更容易命中高质量来源);
2. 各组覆盖问题的不同侧面(定义原理/对比评测/最新进展/实际案例等),不要同义重复。
只输出 JSON:{"queries":["…"]}`;

async function planQueries(question: string): Promise<string[]> {
  const r = await callJson<{ queries: string[] }>({
    system: PLAN_SYSTEM,
    user: `研究问题:${question}`,
    validate: (v) => {
      if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
      const arr = expectStringArray((v as Record<string, unknown>).queries, 'queries');
      if (typeof arr === 'string') return arr;
      const qs = arr.map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 40);
      if (qs.length < 2) return '至少需要 2 组检索词';
      return { queries: qs.slice(0, config.researchMaxQueries) };
    },
  });
  return r.queries;
}

// ── 第 2 步:搜索合并 ─────────────────────────────────────────────
// 多组检索词的结果按 URL 去重;"被几组词同时命中"是免费的相关性信号,
// 命中组数多的排前面。

interface Candidate {
  url: string;
  title: string;
  snippet: string;
  hits: number;
}

function stableUrl(u: string): string {
  return u.replace(/#.*$/, '').replace(/[?&](utm_[a-z]+|spm|from)=[^&]*/g, '');
}

async function searchAll(queries: string[], onStage: StageReporter): Promise<{ candidates: Candidate[]; failed: FailedSource[] }> {
  const candidates = new Map<string, Candidate>();
  const failed: FailedSource[] = [];
  for (const q of queries) {
    onStage(`搜索:${q}`);
    try {
      for (const r of await bingSearch.search(q, config.researchResultsPerQuery)) {
        const key = stableUrl(r.url);
        const cur = candidates.get(key);
        if (cur) cur.hits++;
        else candidates.set(key, { url: r.url, title: r.title, snippet: r.snippet, hits: 1 });
      }
    } catch (e) {
      failed.push({ url: q, stage: 'search', error: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, 800)); // 组间休眠:对搜索服务礼貌一点
  }
  return { candidates: [...candidates.values()].sort((a, b) => b.hits - a.hits), failed };
}

// ── 第 3 步:抓正文(限并发) ──────────────────────────────────────

async function fetchAll(
  cands: Candidate[],
  onStage: StageReporter,
): Promise<{ ok: (Candidate & { article: FetchedArticle })[]; failed: FailedSource[] }> {
  const ok: (Candidate & { article: FetchedArticle })[] = [];
  const failed: FailedSource[] = [];
  let done = 0;
  const queue = [...cands];
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      onStage(`抓取正文(${++done}/${cands.length}):${c.title.slice(0, 30)}`);
      try {
        const article = await fetchArticle(c.url);
        ok.push({ ...c, article });
      } catch (e) {
        // 抓取失败很常见(反爬/JS 渲染/超时):记一笔继续,不拖垮整体
        failed.push({ url: c.url, stage: 'fetch', error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.researchFetchConcurrency, cands.length) }, worker));
  return { ok, failed };
}

// ── 第 4 步:要点提取 ─────────────────────────────────────────────

const POINTS_SYSTEM = `从网页内容中提取与【研究问题】直接相关的要点。规则:
1. 3~6 条,每条一句话,保留具体事实/数据/结论,不要空话套话;
2. 内容与研究问题无关时返回空数组;
3. 忠于原文,数字与结论不改写。
只输出 JSON:{"points":["…"]}`;

async function extractPoints(question: string, title: string, article: FetchedArticle): Promise<string[]> {
  const text = article.blocks.map((b) => b.text).join('\n').slice(0, config.llmMaxInputChars);
  const r = await callJson<{ points: string[] }>({
    system: POINTS_SYSTEM,
    user: `【研究问题】${question}\n【页面】《${title}》\n【正文】\n${text}`,
    validate: (v) => {
      if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
      const arr = expectStringArray((v as Record<string, unknown>).points, 'points');
      if (typeof arr === 'string') return arr;
      const pts = arr.map((s) => s.trim()).filter(Boolean);
      if (pts.length > 8) return '要点最多 8 条';
      return { points: pts };
    },
  });
  return r.points;
}

// ── 第 5 步:报告组装 ─────────────────────────────────────────────

const REPORT_SYSTEM = `你是个人知识库的研究员,基于给定网络材料撰写研究报告。规则:
1. 只依据材料作答,禁止编造;材料之间互相矛盾时,并列呈现各方说法并分别标注来源,不要替用户裁决;
2. 关键论断末尾标注来源编号,如 [2],编号只能取材料中方括号里的数字;不同论断标各自来源;
3. 用简体中文,Markdown 格式:用 2~4 个 "## 小节标题" 组织正文(如 背景与定义/核心观点/分歧与争议/小结),不要一级标题,不要输出链接、图片或表格;
4. 材料不足以回答的部分,在相应小节如实说明,不要硬凑结论。
只输出 JSON:{"report":"…"}`;

function buildMaterial(sources: ResearchSource[]): string {
  return sources
    .map(
      (s) =>
        `[${s.n}]《${s.title}》(${s.finalUrl})\n要点:\n${s.points.map((p) => `- ${p}`).join('\n') || '(未提取到相关要点)'}`,
    )
    .join('\n\n');
}

/** 报告后处理:材料外编号一律摘除(与问答同款的防幻觉引用) */
function cleanReport(report: string, validN: Set<number>): string {
  return report.replace(/\[(\d{1,2})\]/g, (whole, num) => (validN.has(Number(num)) ? whole : ''));
}

export async function runResearch(
  question: string,
  opts: { searchProvider?: SearchProvider; onStage?: StageReporter } = {},
): Promise<ResearchResult> {
  const onStage = opts.onStage ?? noop;
  const started = Date.now();
  const failed: FailedSource[] = [];

  onStage('生成检索词计划…');
  const queries = await planQueries(question);

  const { candidates, failed: searchFailed } = await searchAll(queries, onStage);
  failed.push(...searchFailed);

  // 抓取 top N(按命中组数排序);失败来源记录在案,不阻塞
  const targets = candidates.slice(0, config.researchMaxSources);
  onStage(`抓取 ${targets.length} 个页面…`);
  const { ok: fetched, failed: fetchFailed } = await fetchAll(targets, onStage);
  failed.push(...fetchFailed);

  // 要点提取:逐篇做,失败的来源退出材料(但保留在 failed 里给用户看)
  const sources: ResearchSource[] = [];
  let idx = 0;
  for (const f of fetched) {
    onStage(`提取要点(${++idx}/${fetched.length}):《${f.title.slice(0, 24)}》`);
    try {
      const points = await extractPoints(question, f.title, f.article);
      if (points.length > 0) {
        sources.push({
          n: sources.length + 1,
          url: f.url,
          finalUrl: f.article.finalUrl,
          title: f.title,
          points,
          article: f.article,
        });
      }
    } catch (e) {
      failed.push({ url: f.url, stage: 'points', error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (sources.length === 0) {
    return {
      question,
      report: `## 研究未完成\n\n没有从网络上获取到与「${question}」相关的可用材料(共尝试 ${targets.length} 个页面)。可稍后重试,或换个更具体的问法。`,
      sources: [],
      failed,
      stats: { queries, searchHits: candidates.length, fetched: fetched.length, usedSources: 0, durationMs: Date.now() - started },
    };
  }

  onStage(`汇总撰写报告(基于 ${sources.length} 个来源)…`);
  const r = await callJson<{ report: string }>({
    system: REPORT_SYSTEM,
    user: `【研究问题】${question}\n\n【材料】\n${buildMaterial(sources)}`,
    validate: (v) => {
      if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
      const report = (v as Record<string, unknown>).report;
      if (typeof report !== 'string' || report.trim().length < 50) return 'report 应为不少于 50 字的报告文本';
      return { report: report.trim() };
    },
    maxTokens: config.researchReportMaxTokens,
  });

  return {
    question,
    report: cleanReport(r.report, new Set(sources.map((s) => s.n))),
    sources,
    failed,
    stats: { queries, searchHits: candidates.length, fetched: fetched.length, usedSources: sources.length, durationMs: Date.now() - started },
  };
}
