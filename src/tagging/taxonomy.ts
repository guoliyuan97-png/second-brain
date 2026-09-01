/**
 * 受控词表:标签体系成败的关键。
 *
 * 机制:LLM 打标时只能「复用 approved 标签」或「申请新标签(pending)」,
 * pending 由用户在整理台批准/合并/拒绝 —— 词表不会自由生长成近义词沼泽。
 * merged_into 是合并指针:审标签时"改名为已有标签"不用迁移数据,
 * 旧 id 顺链解析到存活标签即可。
 */
import { db, now } from '../db/index.js';

export interface Region {
  id: number;
  slug: string;
  name: string;
  local_only: number;
}

/** 首跑种子:学习区/工作区。区域是配置对象,将来加"local_only"等开关改这里。 */
export function ensureRegions(): void {
  const seed: [string, string][] = [
    ['learning', '学习'],
    ['work', '工作'],
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO regions (slug, name, created_at) VALUES (?, ?, ?)');
  for (const [slug, name] of seed) ins.run(slug, name, now());
}

export function getRegionBySlug(slug: string): Region | undefined {
  const r = db.prepare('SELECT id, slug, name, local_only FROM regions WHERE slug = ?').get(slug);
  return r as Region | undefined;
}

export function listRegions(): Region[] {
  return db.prepare('SELECT id, slug, name, local_only FROM regions ORDER BY id').all() as unknown as Region[];
}

export interface TagRow {
  id: number;
  region_id: number;
  name: string;
  status: 'approved' | 'pending';
  merged_into: number | null;
}

export function listTags(regionId: number): TagRow[] {
  return db
    .prepare('SELECT id, region_id, name, status, merged_into FROM tags WHERE region_id = ? AND merged_into IS NULL ORDER BY status, name')
    .all(regionId) as unknown as TagRow[];
}

export function listApprovedTagNames(regionId: number): string[] {
  return (
    db
      .prepare("SELECT name FROM tags WHERE region_id = ? AND status = 'approved' AND merged_into IS NULL ORDER BY name")
      .all(regionId) as unknown as { name: string }[]
  ).map((r) => r.name);
}

/** 合并链解析:标签被改名/合并后,旧 id 沿 merged_into 找到最终存活者 */
export function resolveTag(tagId: number): TagRow | undefined {
  let cur = db.prepare('SELECT id, region_id, name, status, merged_into FROM tags WHERE id = ?').get(tagId) as
    | TagRow
    | undefined;
  const seen = new Set<number>();
  while (cur?.merged_into && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = db.prepare('SELECT id, region_id, name, status, merged_into FROM tags WHERE id = ?').get(cur.merged_into) as
      | TagRow
      | undefined;
  }
  return cur;
}

export function findTag(regionId: number, name: string): TagRow | undefined {
  return db
    .prepare('SELECT id, region_id, name, status, merged_into FROM tags WHERE region_id = ? AND name = ?')
    .get(regionId, name) as TagRow | undefined;
}

/** 打标时:词表命中 → 直接用;未命中 → 建为 pending(幂等) */
export function ensureTagForTagging(regionId: number, name: string): { row: TagRow; isNewPending: boolean } {
  const existing = findTag(regionId, name);
  if (existing) {
    return { row: existing, isNewPending: false };
  }
  db.prepare("INSERT INTO tags (region_id, name, status, created_at) VALUES (?, ?, 'pending', ?)").run(
    regionId,
    name,
    now(),
  );
  return { row: findTag(regionId, name)!, isNewPending: true };
}

/** 用户主动加词(预置词表用):直接 approved */
export function addApprovedTag(regionId: number, name: string): TagRow {
  const existing = findTag(regionId, name);
  if (existing) {
    if (existing.status === 'pending') {
      db.prepare("UPDATE tags SET status = 'approved' WHERE id = ?").run(existing.id);
      return { ...existing, status: 'approved' };
    }
    return existing;
  }
  db.prepare("INSERT INTO tags (region_id, name, status, created_at) VALUES (?, ?, 'approved', ?)").run(regionId, name, now());
  return findTag(regionId, name)!;
}

// ── 整理台动作(W4):批准 / 合并 / 拒绝 ──────────────────────────
//
// 原则呼应:词表不会自由生长,LLM 提的每个新标签都等用户在这里裁决。
// 合并的确定性重算 = 绑定迁移(document_tags 从旧 id 改挂到存活 id)+
// 旧 id 留 merged_into 指针做历史;读取路径不用改,展示天然聚合。

export function approveTag(tagId: number): TagRow | undefined {
  const t = resolveTag(tagId);
  if (!t) return undefined;
  db.prepare("UPDATE tags SET status = 'approved' WHERE id = ?").run(t.id);
  return { ...t, status: 'approved' };
}

export interface TagOpResult {
  ok: boolean;
  error?: string;
  into?: TagRow;
  migrated?: number;
}

export function mergeTag(fromTagId: number, intoTagId: number): TagOpResult {
  const from = resolveTag(fromTagId);
  const into = resolveTag(intoTagId);
  if (!from || !into) return { ok: false, error: '标签不存在' };
  if (from.id === into.id) return { ok: false, error: '不能合并到它自己' };
  if (from.region_id !== into.region_id) return { ok: false, error: '跨区域的标签不能合并' };

  // 迁移绑定:同文档同标签去重(INSERT OR IGNORE),旧的绑定行删除
  const migrate = db
    .prepare(
      `INSERT OR IGNORE INTO document_tags (document_id, tag_id, source)
       SELECT document_id, ?, source FROM document_tags WHERE tag_id = ?`,
    )
    .run(into.id, from.id);
  const removed = (
    db.prepare('DELETE FROM document_tags WHERE tag_id = ?').run(from.id) as unknown as { changes: number }
  ).changes;

  db.prepare('UPDATE tags SET merged_into = ? WHERE id = ?').run(into.id, from.id);
  resolveTagReviewInboxForTag(from.region_id, from.name, `merged:${into.name}`);
  return { ok: true, into, migrated: removed };
}

export function rejectTag(tagId: number): TagOpResult {
  const t = resolveTag(tagId);
  if (!t) return { ok: false, error: '标签不存在' };
  const removed = (
    db.prepare('DELETE FROM document_tags WHERE tag_id = ?').run(t.id) as unknown as { changes: number }
  ).changes;
  db.prepare('DELETE FROM tags WHERE id = ?').run(t.id);
  resolveTagReviewInboxForTag(t.region_id, t.name, 'rejected');
  return { ok: true, migrated: removed };
}

/** 同一标签可能有多条待审待办(多篇文档提到它):裁决动作按 名字+区域 一次了结全部 */
export function resolveTagReviewInboxForTag(regionId: number, tagName: string, resolution: string): void {
  const items = db
    .prepare("SELECT id, payload FROM inbox WHERE status='open' AND type='tag_review'")
    .all() as unknown as { id: number; payload: string }[];
  const stamp = now();
  for (const it of items) {
    try {
      const p = JSON.parse(it.payload) as { tagName?: string; documentId?: number };
      if (p.tagName !== tagName) continue;
      const doc = p.documentId
        ? (db.prepare('SELECT region_id FROM documents WHERE id = ?').get(p.documentId) as
            | { region_id: number }
            | undefined)
        : undefined;
      if (doc && doc.region_id !== regionId) continue; // 同名标签在别的区域,不牵连
      db.prepare("UPDATE inbox SET status='resolved', resolved_at=?, resolution=? WHERE id = ?").run(
        stamp,
        resolution,
        it.id,
      );
    } catch {
      /* payload 坏了就跳过,不阻塞其他条目 */
    }
  }
}

/** 词表视图:标签 + 绑定文档数(整理台展示"拒绝会摘掉几处"用) */
export function listTagsWithUsage(regionId: number): (TagRow & { usage: number })[] {
  return db
    .prepare(
      `SELECT t.id, t.region_id, t.name, t.status, t.merged_into, COUNT(dt.document_id) AS usage
       FROM tags t LEFT JOIN document_tags dt ON dt.tag_id = t.id
       WHERE t.region_id = ? AND t.merged_into IS NULL
       GROUP BY t.id ORDER BY CASE WHEN t.status = 'pending' THEN 0 ELSE 1 END, t.name`,
    )
    .all(regionId) as unknown as (TagRow & { usage: number })[];
}
