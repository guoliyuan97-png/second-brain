/**
 * Web 服务(W2 起步版):本机 Node 内置 http,零框架。
 *
 * 安全红线:只绑 127.0.0.1,绝不部署公网(产品拍板)。
 * API 只读部分直接复用 CLI 背后的同一批模块(retriever/answer/save),
 * "Web 界面"只是同一套业务的第二张皮,不存在两套逻辑。
 *
 * 路由是手写的 if/else:端点总共不到十个,引入 express 反而多一层
 * "学习成本 + 依赖",教学项目保持依赖最少。
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { config, PUBLIC_DIR, DATA_DIR, SNAPSHOTS_DIR } from '../config.js';
import { db, now } from '../db/index.js';
import { resetAll } from '../db/reset.js';
import { backupOnStart } from '../db/backup.js';
// 服务自身的首跑职责:全新数据目录(打包版首次启动)也要有区域种子 ——
// 开发态从未暴露这个坑,因为库总是 CLI 先建好的
import { ensureRegions } from '../tagging/taxonomy.js';
import {
  listRegions,
  approveTag,
  mergeTag,
  rejectTag,
  listTagsWithUsage,
  getRegionBySlug,
  addApprovedTag,
} from '../tagging/taxonomy.js';
import { tagDocument } from '../tagging/tagger.js';
import { ftsRetriever } from '../search/retriever.js';
import { answerQuestion, type QaCitation, type QaResult } from '../qa/answer.js';
import { saveQaFromInbox } from '../qa/save.js';
import { runResearch, type ResearchResult } from '../research/pipeline.js';
import { saveResearchToLibrary, deferResearchToInbox, saveResearchFromInbox } from '../research/save.js';
import { startImportJob, getImportJob, importJobView, type ImportRequest } from '../ingest/importJob.js';
import { embeddingsStatus, requestBackfill } from '../embedding/embedding.js';
import { runEvalWithCalibration, getPendingCalibration, applyCalibration, dismissCalibration } from '../eval/calibrate.js';
import { topicSuggestions, compileTopic, getTopic, listTopics, deleteTopic } from '../topics/compile.js';
import { generateReview, recentDocCount } from '../review/review.js';
import { getRules, setRules } from '../db/settings.js';

// ── LLM 任务容器(编译/回顾共用):提交返回 jobId,轮询取结果 ─────────
interface LlmJob {
  id: number;
  kind: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  result?: unknown;
  error?: string;
}
const llmJobs = new Map<number, LlmJob>();
let nextLlmJobId = 1;
let evalJobId: number | null = null; // 同一时间只跑一个评估任务

// fn 会拿到 job.id,便于任务内部实时更新自己的 stage
function startLlmJob(kind: string, stage: string, fn: (jobId: number) => Promise<unknown>): number {
  const job: LlmJob = { id: nextLlmJobId++, kind, status: 'running', stage };
  llmJobs.set(job.id, job);
  const ids = [...llmJobs.keys()];
  if (ids.length > 30) for (const id of ids.slice(0, ids.length - 30)) llmJobs.delete(id);
  void fn(job.id)
    .then((result) => {
      job.result = result;
      job.status = 'done';
      job.stage = '完成';
    })
    .catch((e: unknown) => {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
    });
  return job.id;
}

// ── 工具 ───────────────────────────────────────────────────────────

function json(res: import('node:http').ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req: import('node:http').IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>);
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 原始字节体(文件上传用):不解析 JSON,只限大小 */
function readRawBody(req: import('node:http').IncomingMessage, limit = 80_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('文件超过 80MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── 深度研究:后台任务 + 轮询 ──────────────────────────────────────
// 一次研究要 1~3 分钟(搜索/抓取/多次 LLM),HTTP 请求同步等会超时。
// 模式:POST 立刻返回 jobId,后台跑,前端轮询 GET 拿进度和结果。
// 任务存内存即可:报告才是资产,任务丢了重跑就是(个人工具的取舍)。

interface ResearchJob {
  id: number;
  status: 'running' | 'done' | 'error';
  stage: string;
  question: string;
  result?: ResearchResult;
  error?: string;
  createdAt: number;
}

const researchJobs = new Map<number, ResearchJob>();
let nextJobId = 1;

function jobView(j: ResearchJob): unknown {
  if (!j.result) return { id: j.id, status: j.status, stage: j.stage, question: j.question, error: j.error };
  // 剥掉 article(含 rawHtml):前端只要要点和链接
  return {
    id: j.id,
    status: j.status,
    stage: j.stage,
    question: j.question,
    result: {
      ...j.result,
      sources: j.result.sources.map(({ article, ...pub }) => pub),
    },
  };
}

function startResearchJob(question: string): number {
  const job: ResearchJob = { id: nextJobId++, status: 'running', stage: '准备中…', question, createdAt: Date.now() };
  researchJobs.set(job.id, job);
  // 内存封顶:留最近 20 个,过老的直接清(报告没沉淀就没了,页面有提示场景极少)
  const ids = [...researchJobs.keys()];
  if (ids.length > 20) for (const id of ids.slice(0, ids.length - 20)) researchJobs.delete(id);

  void runResearch(question, { onStage: (s) => (job.stage = s) })
    .then((result) => {
      job.result = result;
      job.status = 'done';
      job.stage = '完成';
    })
    .catch((e: unknown) => {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
    });
  return job.id;
}

function getJob(body: Record<string, unknown>): ResearchJob {
  const job = researchJobs.get(Number(body.jobId));
  if (!job) throw new Error('研究任务不存在或已被清理(服务重启会丢任务,请重新发起)');
  return job;
}

// ── API 处理器 ─────────────────────────────────────────────────────

/** 顶栏统计:各区域文档数 + 收件箱待办数(与 CLI stats 同一份数据) */
function apiStats(): unknown {
  const regions = (
    db.prepare(
      `SELECT r.slug, r.name, COUNT(d.id) AS docs
       FROM regions r LEFT JOIN documents d ON d.region_id = r.id
       GROUP BY r.id ORDER BY r.id`,
    ).all() as unknown as { slug: string; name: string; docs: number }[]
  );
  const inbox = (
    db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE status='open'").get() as unknown as { n: number }
  ).n;
  return { regions, inboxOpen: inbox };
}

// ── 整理台(W4):收件箱上下文视图 + 裁决动作 ──────────────────────
//
// 原则:裁决权在用户。这里只做"把上下文摆全 + 执行用户的决定",
// 不做任何自动修正。每类待办给足判断依据:
// - 冲突:并排展示两侧摘录 + 谁新谁旧(默认策略提示"时间新者优先");
// - 标签:来自哪篇文档 + 当前绑定数(拒绝/合并的后果可见);
// - 打标失败:原文档还在不在、错误是什么(可重试,幂等);
// - 暂存:报告/回答预览(入库是 LLM 动作,按钮上写明)。

interface InboxRow {
  id: number;
  type: string;
  payload: string;
  created_at: string;
}

function resolveInbox(id: number, resolution: string): void {
  db.prepare("UPDATE inbox SET status='resolved', resolved_at=?, resolution=? WHERE id = ? AND status='open'").run(
    now(),
    resolution,
    id,
  );
}

function viewTagReview(p: Record<string, unknown>): Record<string, unknown> | null {
  const tagName = String(p.tagName ?? '');
  const documentId = Number(p.documentId ?? 0);
  const doc = db.prepare('SELECT region_id, created_at FROM documents WHERE id = ?').get(documentId) as
    | { region_id: number; created_at: string }
    | undefined;
  // 来源文档已删 → 待审失去上下文(标签仍可在词表管理里处理),返回 null 走自动过期
  if (!doc) return null;
  let regionSlug = '';
  let usage = 0;
  let tagId: number | null = null;
  let tagStatus = '';
  {
    const region = (
      db.prepare('SELECT slug FROM regions WHERE id = ?').get(doc.region_id) as unknown as { slug: string }
    ).slug;
    regionSlug = region;
    const tag = (
      db.prepare('SELECT id, status FROM tags WHERE region_id = ? AND name = ? AND merged_into IS NULL').get(
        doc.region_id,
        tagName,
      ) as unknown as { id: number; status: string } | undefined
    );
    if (tag) {
      tagId = tag.id;
      tagStatus = tag.status;
      usage = (
        db.prepare('SELECT COUNT(*) n FROM document_tags WHERE tag_id = ?').get(tag.id) as unknown as { n: number }
      ).n;
    }
  }
  return { tagName, documentId, documentTitle: String(p.documentTitle ?? ''), regionSlug, tagId, tagStatus, usage };
}

function viewConflictReview(p: Record<string, unknown>): Record<string, unknown> | null {
  const rel = db
    .prepare(
      `SELECT re.id, re.status, re.note, re.doc_a, re.doc_b,
              ca.heading_path AS a_head, ca.content AS a_content, da.title AS a_title, da.created_at AS a_time,
              cb.heading_path AS b_head, cb.content AS b_content, db2.title AS b_title, db2.created_at AS b_time
       FROM relations re
       JOIN chunks ca ON ca.id = re.chunk_a
       JOIN chunks cb ON cb.id = re.chunk_b
       JOIN documents da ON da.id = re.doc_a
       JOIN documents db2 ON db2.id = re.doc_b
       WHERE re.id = ?`,
    )
    .get(Number(p.relationId ?? 0)) as
    | {
        id: number;
        status: string;
        note: string;
        doc_a: number;
        doc_b: number;
        a_head: string;
        a_content: string;
        a_title: string;
        a_time: string;
        b_head: string;
        b_content: string;
        b_title: string;
        b_time: string;
      }
    | undefined;
  // 关系已被删/已裁决的待办是过期项:顺手了结,不再进列表(确定性清理)
  if (!rel || rel.status !== 'undecided') {
    return null;
  }
  const newer: 'a' | 'b' = rel.a_time >= rel.b_time ? 'a' : 'b';
  const excerpt = (s: string) => s.replace(/\s+/g, ' ').slice(0, 260);
  return {
    relationId: rel.id,
    note: String(p.note ?? rel.note),
    a: { docId: rel.doc_a, title: rel.a_title, heading: rel.a_head, excerpt: excerpt(rel.a_content), time: rel.a_time },
    b: { docId: rel.doc_b, title: rel.b_title, heading: rel.b_head, excerpt: excerpt(rel.b_content), time: rel.b_time },
    newer,
  };
}

function viewSaveReview(p: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: String(p.kind ?? 'qa'),
    question: String(p.question ?? ''),
    answer: typeof p.answer === 'string' ? p.answer : undefined,
    report: typeof p.report === 'string' ? p.report : undefined,
  };
}

function apiInbox(): unknown {
  const rows = db
    .prepare("SELECT id, type, payload, created_at FROM inbox WHERE status='open' ORDER BY id")
    .all() as unknown as InboxRow[];

  const stale: number[] = [];
  const items: Record<string, unknown>[] = [];
  for (const r of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      stale.push(r.id);
      continue;
    }
    let view: Record<string, unknown> | null;
    switch (r.type) {
      case 'tag_review':
        view = viewTagReview(p);
        break;
      case 'conflict_review':
        view = viewConflictReview(p);
        break;
      case 'tagging_failed': {
        const exists = db.prepare('SELECT id FROM documents WHERE id = ?').get(Number(p.documentId ?? 0));
        view = exists ? { title: p.title, error: p.error, documentId: p.documentId } : null;
        break;
      }
      case 'save_review':
        view = viewSaveReview(p);
        break;
      default:
        view = { raw: p };
    }
    if (!view) {
      stale.push(r.id);
      continue;
    }
    items.push({ id: r.id, type: r.type, createdAt: r.created_at, p: view });
  }
  const stamp = now();
  for (const id of stale) {
    db.prepare("UPDATE inbox SET status='resolved', resolved_at=?, resolution='auto:stale' WHERE id = ?").run(stamp, id);
  }

  const recent = (
    db
      .prepare(
        "SELECT id, type, resolution, resolved_at FROM inbox WHERE status='resolved' AND resolution IS NOT NULL ORDER BY resolved_at DESC, id DESC LIMIT 15",
      )
      .all() as unknown as { id: number; type: string; resolution: string; resolved_at: string }[]
  ).filter((r) => !r.resolution.startsWith('auto:'));
  return { items, recent };
}

async function apiInboxResolve(id: number, body: Record<string, unknown>): Promise<unknown> {
  const row = db.prepare("SELECT id, type, payload FROM inbox WHERE id = ? AND status='open'").get(id) as
    | { id: number; type: string; payload: string }
    | undefined;
  if (!row) throw new Error(`待办 #${id} 不存在或已处理`);
  const p = JSON.parse(row.payload) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (row.type === 'tag_review') {
    const v = viewTagReview(p);
    // 兜底:来源文档已删/标签已消失的僵尸待办,任何动作都直接了结而不是报错
    if (!v || !Number(v.tagId ?? 0)) {
      resolveInbox(id, 'auto:stale');
      return { ok: true, note: '来源文档已删除,该待办已自动过期' };
    }
    const tagId = Number(v.tagId ?? 0);
    if (action === 'approve') {
      approveTag(tagId);
      resolveInbox(id, `approved:${v.tagName}`);
    } else if (action === 'reject') {
      rejectTag(tagId);
    } else if (action === 'merge') {
      const r = mergeTag(tagId, Number(body.intoTagId ?? 0));
      if (!r.ok) throw new Error(r.error ?? '合并失败');
    } else {
      throw new Error(`不支持的动作:${action}`);
    }
    return { ok: true };
  }

  if (row.type === 'conflict_review') {
    if (action !== 'decide') throw new Error(`不支持的动作:${action}`);
    const value = String(body.value ?? '');
    if (!['a_active', 'b_active', 'both_valid'].includes(value)) throw new Error(`非法的裁决:${value}`);
    db.prepare("UPDATE relations SET status = ? WHERE id = ? AND status = 'undecided'").run(value, Number(p.relationId));
    resolveInbox(id, `decided:${value}`);
    return { ok: true };
  }

  if (row.type === 'tagging_failed') {
    if (action === 'retry') {
      const out = await tagDocument(Number(p.documentId));
      if (!out.ok) throw new Error(`重试仍失败:${out.error}(待办保留,可再试或忽略)`);
      resolveInbox(id, 'retagged');
      return { ok: true, tags: out.tags };
    }
    if (action === 'ignore') {
      resolveInbox(id, 'ignored');
      return { ok: true };
    }
    throw new Error(`不支持的动作:${action}`);
  }

  if (row.type === 'save_review') {
    if (action === 'save') {
      const regionSlug = String(body.region ?? 'learning');
      if (String(p.kind ?? 'qa') === 'research') {
        const r = await saveResearchFromInbox(
          p as { question: string; report: string; sources?: { n: number; title: string; url: string }[] },
          regionSlug,
        );
        resolveInbox(id, `saved:doc${r.docId}`);
        return { ok: true, docId: r.docId, title: r.title };
      }
      const r = await saveQaFromInbox(p as { question: string; answer: string; citations?: QaCitation[] }, regionSlug);
      resolveInbox(id, `saved:doc${r.docId}`);
      return { ok: true, docId: r.docId, title: r.title };
    }
    if (action === 'drop') {
      resolveInbox(id, 'dropped');
      return { ok: true };
    }
    throw new Error(`不支持的动作:${action}`);
  }

  throw new Error(`未知待办类型:${row.type}`);
}

function apiTaxonomy(url: URL): unknown {
  const region = getRegionBySlug(url.searchParams.get('region') ?? 'learning');
  if (!region) throw new Error('区域不存在');
  return { region: region.slug, tags: listTagsWithUsage(region.id) };
}

/** 找文档模式:检索结果按文档聚合,前端零 token 直接渲染 */
function apiSearch(url: URL): unknown {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return { docs: [] };
  const hits = ftsRetriever.retrieve(q, {
    limit: 30,
    regionSlug: url.searchParams.get('region') ?? undefined,
  });
  const docs = new Map<number, { id: number; title: string; hits: { headingPath: string; snippet: string }[] }>();
  for (const h of hits) {
    let d = docs.get(h.docId);
    if (!d) {
      d = { id: h.docId, title: h.title, hits: [] };
      docs.set(h.docId, d);
    }
    if (d.hits.length < 3) {
      d.hits.push({ headingPath: h.headingPath, snippet: h.content.replace(/\s+/g, ' ').slice(0, 120) });
    }
  }
  return { docs: [...docs.values()] };
}

interface AskBody {
  question?: unknown;
  region?: unknown;
}

async function apiAsk(
  body: Record<string, unknown>,
  onEvent?: (e: { type: 'stage'; stage: string } | { type: 'delta'; full: string }) => void,
): Promise<QaResult> {
  const { question, region } = body as AskBody;
  if (typeof question !== 'string' || !question.trim()) throw new Error('缺少 question');
  // 多轮上下文:客户端带来最近几轮(不信任客户端,形状与长度都收紧)
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history = rawHistory
    .slice(-4)
    .map((h) => h as { q?: unknown; a?: unknown })
    .filter((h) => typeof h.q === 'string' && typeof h.a === 'string')
    .map((h) => ({ q: (h.q as string).slice(0, 200), a: (h.a as string).slice(0, 2000) }));
  return answerQuestion(question.trim(), {
    regionSlug: typeof region === 'string' && region ? region : undefined,
    history,
    onEvent,
  });
}


function apiDocs(url: URL): unknown {
  const region = url.searchParams.get('region');
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.source_type, d.source_ref, d.char_count, d.created_at, r.slug AS region
       FROM documents d JOIN regions r ON r.id = d.region_id
       ${region ? 'WHERE r.slug = ?' : ''}
       ORDER BY d.created_at DESC, d.id DESC`,
    )
    .all(...(region ? [region] : [])) as unknown as Record<string, unknown>[];

  const tagStmt = db.prepare(
    `SELECT t.name, t.status FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = ?`,
  );
  for (const row of rows) {
    row.tags = (tagStmt.all(row.id as number) as unknown as { name: string; status: string }[]).map((t) =>
      t.status === 'approved' ? t.name : `${t.name}*`,
    );
  }
  return { docs: rows };
}

// ── Step1 能存补全:文档删除 + 原文快照查看 ────────────────────────

function apiDocDelete(id: number): unknown {
  const doc = db.prepare('SELECT id, snapshot_path FROM documents WHERE id = ?').get(id) as
    | { id: number; snapshot_path: string }
    | undefined;
  if (!doc) throw new Error(`文档 ${id} 不存在`);
  // 级联:chunks/document_tags/summaries/relations 均带 ON DELETE CASCADE,
  // FTS 由触发器同步;收件箱里的悬挂引用由 apiInbox 的过期清理兜底
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  try {
    if (doc.snapshot_path && existsSync(doc.snapshot_path)) statSync(doc.snapshot_path); // 确认可访问
    unlinkSync(doc.snapshot_path);
  } catch {
    /* 快照文件不存在或被占用:库内引用已删,不阻塞 */
  }
  return { ok: true };
}

const SNAP_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function apiDocSnapshot(id: number, res: import('node:http').ServerResponse): void {
  const doc = db.prepare('SELECT snapshot_path FROM documents WHERE id = ?').get(id) as
    | { snapshot_path: string }
    | undefined;
  if (!doc || !existsSync(doc.snapshot_path)) {
    json(res, 404, { error: '快照文件不存在' });
    return;
  }
  const ext = extname(doc.snapshot_path).toLowerCase();
  const mime = SNAP_MIME[ext] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'Content-Type': mime };
  if (mime === 'application/octet-stream') headers['Content-Disposition'] = `attachment; filename="snapshot${ext}"`;
  res.writeHead(200, headers);
  res.end(readFileSync(doc.snapshot_path));
}

function apiDocDetail(id: number): unknown {
  const doc = db
    .prepare(
      `SELECT d.*, r.slug AS region, r.name AS region_name
       FROM documents d JOIN regions r ON r.id = d.region_id WHERE d.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!doc) throw new Error(`文档 ${id} 不存在`);

  doc.tags = db
    .prepare(
      `SELECT t.name, t.status FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = ?`,
    )
    .all(id);
  doc.summary = db
    .prepare('SELECT key_points, prerequisites, version_notes, value_note FROM summaries WHERE document_id = ?')
    .get(id);
  doc.relations = db
    .prepare(
      `SELECT re.type, re.status, re.note,
              CASE WHEN re.doc_a = ? THEN re.doc_b ELSE re.doc_a END AS other_id,
              d.title AS other_title
       FROM relations re JOIN documents d ON d.id = CASE WHEN re.doc_a = ? THEN re.doc_b ELSE re.doc_a END
       WHERE re.doc_a = ? OR re.doc_b = ?`,
    )
    .all(id, id, id, id);
  doc.chunks = db
    .prepare('SELECT ordinal, heading_path, content FROM chunks WHERE document_id = ? ORDER BY ordinal')
    .all(id);
  return doc;
}

// ── 导入(W5+:拖拽/选文件/URL 全进客户端)───────────────────────
// 三种入口共用一个后台任务:
// - paths:Electron 拖拽/选择,渲染进程经 preload 拿到绝对路径
// - url:粘贴的网页地址
// - upload:纯浏览器态没有路径,内容先落临时文件再走 paths

function importReqFromBody(body: Record<string, unknown>): ImportRequest {
  const mode = body.mode === 'url' ? 'url' : body.mode === 'note' ? 'note' : 'paths';
  if (mode === 'url') {
    return {
      mode,
      url: String(body.url ?? ''),
      regionSlug: String(body.region ?? 'learning'),
      tag: body.tag !== false,
      relations: body.rel !== false,
    };
  }
  if (mode === 'note') {
    return {
      mode,
      content: String(body.content ?? ''),
      regionSlug: String(body.region ?? 'learning'),
      tag: body.tag !== false,
      relations: body.rel !== false,
    };
  }
  const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : [];
  if (paths.length === 0) throw new Error('没有可导入的路径');
  return { mode, paths, regionSlug: String(body.region ?? 'learning'), tag: body.tag !== false, relations: body.rel !== false };
}

async function apiImportUpload(req: import('node:http').IncomingMessage, url: URL): Promise<number> {
  const name = (url.searchParams.get('name') ?? 'upload.md').split(/[\\/]/).pop() || 'upload.md';
  const safe = name.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_');
  const buf = await readRawBody(req);
  if (buf.length === 0) throw new Error('上传内容为空');
  // 临时文件由任务异步消费,不主动删(OS 会清理临时目录);
  // 导入完成后从任务结果里也拿不到它,不产生任何库内痕迹
  const tmp = join(tmpdir(), `sb-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  writeFileSync(tmp, buf);
  return startImportJob({
    mode: 'paths',
    paths: [tmp],
    regionSlug: url.searchParams.get('region') ?? 'learning',
    tag: url.searchParams.get('tag') !== '0',
    relations: url.searchParams.get('rel') !== '0',
  });
}

function apiTaxonomyAdd(body: Record<string, unknown>): unknown {
  const region = getRegionBySlug(String(body.region ?? 'learning'));
  if (!region) throw new Error('区域不存在');
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('标签名不能为空');
  const t = addApprovedTag(region.id, name);
  return { ok: true, tag: t };
}

// ── 数据存储(W6.1):占用统计 + 迁移 ─────────────────────────────
// 迁移原理:VACUUM INTO 做一致性主库副本(WAL 下直接拷文件会漏数据)
// 再逐文件复制快照。写指针与重启由 Electron 主进程负责(preload IPC),
// 服务保持无 Electron 依赖。

function fileSizeMB(p: string): number {
  return existsSync(p) ? Math.round((statSync(p).size / 1048576) * 10) / 10 : 0;
}

function dirSizeMB(p: string): number {
  let total = 0;
  if (!existsSync(p)) return 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  walk(p);
  return Math.round((total / 1048576) * 10) / 10;
}

function apiDataInfo(): unknown {
  return {
    dir: DATA_DIR,
    totalMB: dirSizeMB(DATA_DIR),
    dbMB: fileSizeMB(join(DATA_DIR, 'secondbrain.db')),
    snapshotsMB: dirSizeMB(join(DATA_DIR, 'snapshots')),
    backupsMB: dirSizeMB(join(DATA_DIR, 'backups')),
  };
}

async function apiDataMove(target: string): Promise<unknown> {
  const clean = target.trim();
  if (!/^[a-zA-Z]:[\/]/.test(clean)) throw new Error('请选择一个盘符开头的绝对路径');
  const normalized = normalize(clean);
  if (normalized === DATA_DIR) throw new Error('目标与当前数据目录相同');
  if (DATA_DIR.startsWith(normalized)) throw new Error('目标目录不能是当前数据目录的上级');
  if (existsSync(normalized) && readdirSync(normalized).length > 0) throw new Error('目标目录不是空的,请选一个空目录(或新建一个)');
  mkdirSync(normalized, { recursive: true });
  // 主库:VACUUM INTO 做一致性副本(WAL 下直接拷文件会漏数据)
  await new Promise<void>((resolve, reject) => {
    try {
      db.exec('VACUUM INTO "' + normalized + '"');
      resolve();
    } catch (err) {
      reject(err as Error);
    }
  });
  // 快照:逐文件复制(快照文件不被服务常开,复制期间安全)
  if (existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(join(normalized, 'snapshots'), { recursive: true });
    for (const f of readdirSync(SNAPSHOTS_DIR)) {
      copyFileSync(join(SNAPSHOTS_DIR, f), join(normalized, 'snapshots', f));
    }
  }
  return { ok: true, target: normalized };
}

// ── 静态文件 ───────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(pathname: string, res: import('node:http').ServerResponse): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  // 路径穿越防线:normalize 后必须仍在 public/ 内
  if (!file.startsWith(PUBLIC_DIR + sep) && file !== PUBLIC_DIR) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const ext = extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

// ── 服务入口 ───────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  try {
    if (req.method === 'GET') {
      if (path === '/api/health') return json(res, 200, { ok: true, name: 'second-brain', week: 2 });
      if (path === '/api/regions') return json(res, 200, { regions: listRegions() });
      if (path === '/api/stats') return json(res, 200, apiStats());
      if (path === '/api/search') return json(res, 200, apiSearch(url));
      if (path === '/api/docs') return json(res, 200, apiDocs(url));
      const docMatch = path.match(/^\/api\/doc\/(\d+)$/);
      if (docMatch) return json(res, 200, apiDocDetail(Number(docMatch[1])));
      const snapMatch = path.match(/^\/api\/doc\/(\d+)\/snapshot$/);
      if (snapMatch) return apiDocSnapshot(Number(snapMatch[1]), res);
      if (path === '/api/inbox') return json(res, 200, apiInbox());
      if (path === '/api/taxonomy') return json(res, 200, apiTaxonomy(url));
      const importJobMatch = path.match(/^\/api\/import\/(\d+)$/);
      if (importJobMatch) {
        const job = getImportJob(Number(importJobMatch[1]));
        if (!job) return json(res, 404, { error: '导入任务不存在' });
        return json(res, 200, importJobView(job));
      }
      // 编译层 + 规则层 + 回顾(W5+)
      if (path === '/api/topics') return json(res, 200, { topics: listTopics(getRegionBySlug(url.searchParams.get('region') ?? 'learning')!.id) });
      if (path === '/api/topics/suggestions') {
        const region = getRegionBySlug(url.searchParams.get('region') ?? 'learning');
        if (!region) throw new Error('区域不存在');
        return json(res, 200, { suggestions: topicSuggestions(region.id) });
      }
      const topicMatch = path.match(/^\/api\/topics\/(\d+)$/);
      if (topicMatch) {
        const t = getTopic(Number(topicMatch[1]));
        if (!t) return json(res, 404, { error: '主题不存在' });
        return json(res, 200, t);
      }
      if (path === '/api/rules') return json(res, 200, { rules: getRules() });
      if (path === '/api/data') return json(res, 200, apiDataInfo());
      if (path === '/api/embeddings/status') return json(res, 200, embeddingsStatus());
      if (path === '/api/eval') {
        const running = evalJobId !== null && llmJobs.get(evalJobId)?.status === 'running';
        return json(res, 200, { pending: getPendingCalibration(), running, jobId: evalJobId });
      }
      const llmJobMatch = path.match(/^\/api\/llm\/(\d+)$/);
      if (llmJobMatch) {
        const job = llmJobs.get(Number(llmJobMatch[1]));
        if (!job) return json(res, 404, { error: '任务不存在' });
        return json(res, 200, job);
      }
    }
    if (req.method === 'POST') {
      // 上传导入是原始字节体,必须在 JSON 解析之前接走
      if (path === '/api/import/upload') return json(res, 200, { jobId: await apiImportUpload(req, url) });
      const body = await readBody(req);
      // 流式问答:SSE。stage(阶段提示)→ delta(回答增量)→ done(完整 QaResult)
      if (path === '/api/ask/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const send = (event: string, data: unknown): void => {
          res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
        };
        try {
          const qa = await apiAsk(body, (e) => {
            if (e.type === 'stage') send('stage', { stage: e.stage });
            else send('delta', { full: e.full });
          });
          send('done', qa);
        } catch (e) {
          send('error', { error: e instanceof Error ? e.message : String(e) });
        }
        res.end();
        return;
      }
      if (path === '/api/ask') return json(res, 200, await apiAsk(body));
      // 注:问答不再提供入库/暂存端点 —— 产品拍板,问答源于库内,不反哺询问
      if (path === '/api/research') {
        const q = typeof body.question === 'string' ? body.question.trim() : '';
        if (!q) throw new Error('缺少 question');
        return json(res, 200, { jobId: startResearchJob(q) });
      }
      if (path === '/api/research/save') {
        const job = getJob(body);
        if (job.status !== 'done' || !job.result) throw new Error('任务尚未完成,不能沉淀');
        const out = await saveResearchToLibrary(job.result, {
          regionSlug: String(body.region ?? 'learning'),
          withSources: body.withSources === true,
        });
        return json(res, 200, out);
      }
      if (path === '/api/research/defer') {
        const job = getJob(body);
        if (job.status !== 'done' || !job.result) throw new Error('任务尚未完成,不能暂存');
        return json(res, 200, { inboxId: deferResearchToInbox(job.result) });
      }
      const resolveMatch = path.match(/^\/api\/inbox\/(\d+)\/resolve$/);
      if (resolveMatch) return json(res, 200, await apiInboxResolve(Number(resolveMatch[1]), body));
      const docDelMatch = path.match(/^\/api\/doc\/(\d+)\/delete$/);
      if (docDelMatch) return json(res, 200, apiDocDelete(Number(docDelMatch[1])));
      if (path === '/api/import') {
        const jobId = startImportJob(importReqFromBody(body));
        return json(res, 200, { jobId });
      }
      if (path === '/api/reset') {
        // 危险操作:确认词必须一字不差;前端还有输入解锁 + confirm 双保险
        if (body.confirm !== '重置') throw new Error('确认词不正确,未执行重置');
        resetAll();
        return json(res, 200, { ok: true });
      }
      if (path === '/api/taxonomy/add') return json(res, 200, apiTaxonomyAdd(body));
      // 编译层 + 规则层 + 回顾(W5+)
      if (path === '/api/topics/compile') {
        const region = getRegionBySlug(String(body.region ?? 'learning'));
        if (!region) throw new Error('区域不存在');
        const tag = String(body.tag ?? '').trim();
        if (!tag) throw new Error('缺少 tag');
        const jobId = startLlmJob('compile', `编译主题「${tag}」…`, () => compileTopic(region.id, tag));
        return json(res, 200, { jobId });
      }
      const topicDelMatch = path.match(/^\/api\/topics\/(\d+)\/delete$/);
      if (topicDelMatch) {
        deleteTopic(Number(topicDelMatch[1]));
        return json(res, 200, { ok: true });
      }
      if (path === '/api/rules') {
        const text = String(body.rules ?? '').trim();
        setRules(text);
        return json(res, 200, { ok: true });
      }
      // 评估 + 自动校准:任务完成后建议落在 eval/pending-calibration.json,由用户拍板
      if (path === '/api/eval/run') {
        if (evalJobId !== null && llmJobs.get(evalJobId)?.status === 'running') {
          return json(res, 200, { jobId: evalJobId, running: true });
        }
        const jobId = startLlmJob('eval', '评估中(每例一次真实问答)…', async (jobIdForStage) => {
          const r = await runEvalWithCalibration((stage) => {
            const j = llmJobs.get(jobIdForStage);
            if (j) j.stage = stage;
          });
          return { summary: r.summary, suggestions: r.suggestions.length };
        });
        evalJobId = jobId;
        return json(res, 200, { jobId });
      }
      if (path === '/api/eval/apply') {
        const applied = applyCalibration(String(body.q ?? ''), Array.isArray(body.addTitles) ? body.addTitles.map(String) : []);
        return json(res, 200, { ok: true, applied: applied.applied });
      }
      if (path === '/api/eval/dismiss') {
        dismissCalibration(String(body.q ?? ''));
        return json(res, 200, { ok: true });
      }
      if (path === '/api/embeddings/backfill') {
        requestBackfill();
        return json(res, 200, embeddingsStatus());
      }
      if (path === '/api/data/move') {
        const target = String(body.target ?? '');
        return json(res, 200, await apiDataMove(target));
      }
      if (path === '/api/review') {
        const region = getRegionBySlug(String(body.region ?? 'learning'));
        if (!region) throw new Error('区域不存在');
        const jobId = startLlmJob('review', '生成回顾…', () => generateReview(region.id));
        return json(res, 200, { jobId });
      }
      if (path === '/api/taxonomy/approve') {
        const t = approveTag(Number(body.tagId ?? 0));
        if (!t) throw new Error('标签不存在');
        return json(res, 200, { ok: true, tag: t });
      }
      if (path === '/api/taxonomy/reject') {
        const r = rejectTag(Number(body.tagId ?? 0));
        if (!r.ok) throw new Error(r.error ?? '拒绝失败');
        return json(res, 200, r);
      }
      if (path === '/api/taxonomy/merge') {
        const r = mergeTag(Number(body.fromTagId ?? 0), Number(body.intoTagId ?? 0));
        if (!r.ok) throw new Error(r.error ?? '合并失败');
        return json(res, 200, r);
      }
    }
    if (req.method === 'GET') {
      const jobMatch = path.match(/^\/api\/research\/(\d+)$/);
      if (jobMatch) {
        const job = researchJobs.get(Number(jobMatch[1]));
        if (!job) return json(res, 404, { error: '研究任务不存在' });
        return json(res, 200, jobView(job));
      }
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: '未知接口' });
    if (serveStatic(path, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

ensureRegions(); // 幂等:全新库补 learning/work 种子,已有库无副作用
backupOnStart(); // 滚动备份:每次启动留一份一致性快照,兜"不会塌"的底
setTimeout(() => requestBackfill(), 5000); // 向量索引自动补全(provider off 时为空操作)

server.listen(config.port, '127.0.0.1', () => {
  console.log(`second-brain Web 已启动:http://127.0.0.1:${config.port}(仅本机可访问)`);
});
