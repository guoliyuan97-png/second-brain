/**
 * 编译层:主题结论页(文档 06/08 的"编译"思想,本项目的核心增量)。
 *
 * 三件事:
 * 1. 主题发现:某个标签下聚了 ≥3 篇文档,且尚未编译(或编译后有新文档)
 *    → 成为整理台的"建议编译"候选。候选靠标签+关系这些已有资产,
 *    不引入任何聚类算法 —— 个人规模,简单启发式就是最好的算法。
 * 2. 编译:一次 LLM 调用,把同主题文档的摘要(含"对我的价值")综合成
 *    一页 Markdown 结论,引用回来源文档。同 slug 重编译 = 更新主题页
 *    (派生数据可重算,不违反原文不可变)。
 * 3. 往回织:新资料入库命中已有主题的标签后,主题页标记"待重编译",
 *    进整理台待办,由用户决定何时重编译。
 */
import { db, now } from '../db/index.js';
import { config } from '../config.js';
import { callJson } from '../llm/client.js';
import { getRules } from '../db/settings.js';

export interface TopicRow {
  id: number;
  region_id: number;
  slug: string;
  title: string;
  content: string;
  doc_ids: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface TopicSuggestion {
  slug: string;
  tagName: string;
  docCount: number;
  docs: { id: number; title: string }[];
  topicId: number | null;
  stale: boolean;
}

const MIN_DOCS = 2;

function parseDocIds(topic: TopicRow): number[] {
  try {
    return JSON.parse(topic.doc_ids) as number[];
  } catch {
    return [];
  }
}

/** 某区域下:标签 → 打了该标签的文档列表(排除零信息泛词由词表保证,这里不重复过滤) */
function docsByTag(regionId: number): Map<string, { id: number; title: string }[]> {
  const rows = db
    .prepare(
      `SELECT t.name AS tag, d.id, d.title
       FROM tags t
       JOIN document_tags dt ON dt.tag_id = t.id
       JOIN documents d ON d.id = dt.document_id
       WHERE t.region_id = ? AND t.merged_into IS NULL
       ORDER BY d.id`,
    )
    .all(regionId) as unknown as { tag: string; id: number; title: string }[];
  const map = new Map<string, { id: number; title: string }[]>();
  for (const r of rows) {
    const list = map.get(r.tag) ?? [];
    if (!list.some((d) => d.id === r.id)) list.push({ id: r.id, title: r.title });
    map.set(r.tag, list);
  }
  return map;
}

/** 建议编译的候选:文档数达标、且"有活可干"的标签(未编译,或编译后来了新资料)。
 *  已编译且无更新的主题不进建议队列 —— 整理台是待办,办完的事不留;看它们去文档库的"主题"视图。 */
export function topicSuggestions(regionId: number): TopicSuggestion[] {
  const byTag = docsByTag(regionId);
  const out: TopicSuggestion[] = [];
  for (const [tag, docs] of byTag) {
    if (docs.length < MIN_DOCS) continue;
    const existing = db
      .prepare('SELECT id, doc_ids FROM topics WHERE region_id = ? AND slug = ?')
      .get(regionId, tag) as { id: number; doc_ids: string } | undefined;
    let stale = false;
    if (existing) {
      const compiled = new Set(parseDocIds({ doc_ids: existing.doc_ids } as TopicRow));
      stale = docs.some((d) => !compiled.has(d.id)); // 有标签内文档未参与编译 → 待重编译
      if (!stale) continue; // 编译过且没新资料:办完了,不留整理台
    }
    out.push({ slug: tag, tagName: tag, docCount: docs.length, docs, topicId: existing?.id ?? null, stale });
  }
  return out.sort((a, b) => Number(b.stale) - Number(a.stale) || b.docCount - a.docCount);
}

/** 编译材料:每篇文档的摘要 key_points + 价值备注(编译层消费笔记层) */
function buildMaterial(docs: { id: number; title: string }[]): string {
  const parts: string[] = [];
  for (const [i, d] of docs.entries()) {
    const s = db
      .prepare('SELECT key_points, value_note FROM summaries WHERE document_id = ?')
      .get(d.id) as { key_points: string; value_note: string | null } | undefined;
    const kp = s ? (JSON.parse(s.key_points) as string[]) : [];
    const body = db
      .prepare("SELECT content FROM chunks WHERE document_id = ? ORDER BY ordinal LIMIT 2")
      .all(d.id) as unknown as { content: string }[];
    parts.push(
      `[${i + 1}]《${d.title}》\n要点:\n${kp.map((k) => `- ${k}`).join('\n') || '(无摘要)'}\n开头摘录:${(body[0]?.content ?? '').replace(/\s+/g, ' ').slice(0, 200)}`,
    );
  }
  return parts.join('\n\n');
}
const COMPILE_SYSTEM = `你是个人知识库的编译器:把同一主题下的多篇文档笔记,综合成一页"主题结论"。
规则:
1. 只依据给定材料;材料间结论冲突时,分点并列呈现各方说法,不要裁决;
2. 提炼共识与差异,按"这个词是什么/核心观点/分歧与争议/还没答案的问题"等小节组织(## 开头,2~4 节);
3. 引用来源文档用 [n](n 为材料方括号里的编号),关键结论都要能溯源;
4. 简体中文,Markdown,不要一级标题,不要链接图片;
5. 材料不足以形成的结论,放在"还没答案的问题"里,不要编造。
只输出 JSON:{"title":"主题页标题","content":"…Markdown 正文…"}`;

export interface CompileOutcome {
  topicId: number;
  slug: string;
  title: string;
  updated: boolean;
}

/** 编译(或重编译)一个主题页。slug 现阶段 = 标签名。 */
export async function compileTopic(regionId: number, tag: string): Promise<CompileOutcome> {
  const byTag = docsByTag(regionId);
  const docs = byTag.get(tag) ?? [];
  if (docs.length < 2) throw new Error(`标签「${tag}」下文档不足`);

  const existing = db
    .prepare('SELECT id, created_at FROM topics WHERE region_id = ? AND slug = ?')
    .get(regionId, tag) as { id: number; created_at: string } | undefined;

  const rules = getRules();
  const r = await callJson<{ title: string; content: string }>({
    system: COMPILE_SYSTEM + (rules ? `\n【主人画像与规则】结论要对以下个人约束有用:\n${rules}` : ''),
    user: `【主题】${tag}\n\n【材料】\n${buildMaterial(docs)}`,
    validate: (v) => {
      if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
      const title = String((v as Record<string, unknown>).title ?? '').trim();
      const content = String((v as Record<string, unknown>).content ?? '').trim();
      if (!title || title.length > 40) return 'title 应为 40 字以内的主题标题';
      if (content.length < 100) return 'content 应为不少于 100 字的结论页';
      return { title, content };
    },
    maxTokens: 3000,
  });

  const docIds = JSON.stringify(docs.map((d) => d.id));
  const stamp = now();
  let topicId: number;
  if (existing) {
    db.prepare('UPDATE topics SET title=?, content=?, doc_ids=?, model=?, updated_at=? WHERE id=?').run(
      r.title,
      r.content,
      docIds,
      config.llm.model,
      stamp,
      existing.id,
    );
    topicId = existing.id;
  } else {
    const res = db
      .prepare(
        'INSERT INTO topics (region_id, slug, title, content, doc_ids, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(regionId, tag, r.title, r.content, docIds, config.llm.model, stamp, stamp);
    topicId = Number(res.lastInsertRowid);
  }
  return { topicId, slug: tag, title: r.title, updated: !!existing };
}

export function getTopic(id: number): (TopicRow & { docs: { id: number; title: string }[] }) | undefined {
  const t = db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined;
  if (!t) return undefined;
  const ids = parseDocIds(t);
  const docs = ids
    .map((id) => db.prepare('SELECT id, title FROM documents WHERE id = ?').get(id) as { id: number; title: string } | undefined)
    .filter((d): d is { id: number; title: string } => !!d);
  return { ...t, docs };
}

export function listTopics(regionId: number): (Omit<TopicRow, 'content'> & { docCount: number })[] {
  return db
    .prepare(
      `SELECT id, region_id, slug, title, doc_ids, model, created_at, updated_at FROM topics WHERE region_id = ? ORDER BY updated_at DESC`,
    )
    .all(regionId)
    .map((t) => {
      const row = t as unknown as TopicRow;
      let n = 0;
      try {
        n = (JSON.parse(row.doc_ids) as number[]).length;
      } catch {
        /* 忽略坏数据 */
      }
      const { content: _c, ...rest } = row;
      return { ...rest, docCount: n };
    });
}

export function deleteTopic(id: number): void {
  db.prepare('DELETE FROM topics WHERE id = ?').run(id);
}

/** 问答的材料注入:命中文档已编译过的主题结论,作为"可直接复用的成品"放在最前 */
export function topicsForDocs(docIds: number[], maxChars = 1600): { title: string; content: string }[] {
  if (docIds.length === 0) return [];
  const rows = db
    .prepare(`SELECT id, title, content, doc_ids FROM topics WHERE doc_ids IS NOT NULL`)
    .all() as unknown as unknown as TopicRow[];
  const want = new Set(docIds);
  const out: { title: string; content: string }[] = [];
  for (const t of rows) {
    const ids = parseDocIds(t);
    if (ids.some((id) => want.has(id))) {
      out.push({ title: t.title, content: t.content.slice(0, maxChars) });
      if (out.length >= 2) break; // 最多带 2 页,防材料爆炸
    }
  }
  return out;
}
