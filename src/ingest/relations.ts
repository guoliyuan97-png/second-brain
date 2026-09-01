/**
 * 关系判定:新文档入库时,与库内旧知识做一次"相似/冲突/补充"对比。
 *
 * 工程约束:
 * - 只用 FTS 检索 top-k 候选做对比,绝不做全库两两对比(O(n²) 不可行);
 * - 判定失败只降级(关系层少记一笔),绝不阻塞文档入库;
 * - conflict 会同时写一条待办,裁决权在用户 —— 系统永远不自动"修正"旧知识。
 */
import { db, now } from '../db/index.js';
import { config } from '../config.js';
import { callJson } from '../llm/client.js';

interface Pair {
  newChunkId: number;
  oldChunkId: number;
  oldDocId: number;
  oldTitle: string;
  oldHeading: string;
  oldExcerpt: string;
}

/**
 * 构造相似探针:从 chunk 里取 3 字滑窗片段(步长 6)做 OR 查询。
 *
 * 为什么不用长短语:实测 60 字连续短语在"同主题但表述不同"的文档间
 * 几乎永远无法字符级命中(trigram 短语匹配太严格),11 篇同系列文档
 * 全部"候选 0"。3 字片段命中的是"词汇重合度",由 bm25 按密度排序 ——
 * 这正是词面检索能做到的"相似"。语义级相似留给将来的向量检索层。
 */
function probeQuery(content: string): string | null {
  const compact = content.replace(/\s+/g, '');
  if (compact.length < 3) return null;
  const grams: string[] = [];
  for (let i = 0; i < compact.length && grams.length < 12; i += 6) {
    const g = compact.slice(i, i + 3);
    if (g.length === 3) grams.push(g);
  }
  return grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ');
}

function findCandidates(docId: number): Map<number, Pair> {
  const pairs = new Map<number, Pair>();
  const newChunks = db
    .prepare('SELECT id, content FROM chunks WHERE document_id = ? ORDER BY ordinal LIMIT 3')
    .all(docId) as unknown as { id: number; content: string }[];

  for (const c of newChunks) {
    const query = probeQuery(c.content);
    if (!query) continue;
    let rows: { id: number; document_id: number; heading_path: string; content: string; title: string }[] = [];
    try {
      rows = db
        .prepare(
          `SELECT ch.id, ch.document_id, ch.heading_path, ch.content, d.title
           FROM chunks_fts f JOIN chunks ch ON ch.id = f.rowid JOIN documents d ON d.id = ch.document_id
           WHERE chunks_fts MATCH ? AND ch.document_id != ?
           ORDER BY bm25(chunks_fts) LIMIT ?`,
        )
        .all(query, docId, config.relationTopK) as typeof rows;
    } catch {
      continue; // 查询异常(如特殊字符)就跳过这个探针
    }
    for (const r of rows) {
      if (!pairs.has(r.id)) {
        pairs.set(r.id, {
          newChunkId: c.id,
          oldChunkId: r.id,
          oldDocId: r.document_id,
          oldTitle: r.title,
          oldHeading: r.heading_path,
          oldExcerpt: r.content.replace(/\s+/g, ' ').slice(0, 160),
        });
      }
    }
  }
  return pairs;
}

const REL_SYSTEM = `判定两段知识内容的关系,只输出 JSON。
类型定义:
- similar:同一主题下结论一致的表述(措辞不同不算冲突);
- conflict:结论矛盾或互相排斥(版本演进导致的差异也算,请在 note 注明"疑似版本/时效差异");
- supplement:同一主题的不同侧面、互为补充;
- none:没有实质关联。
输出:{"items":[{"i":候选序号,"type":"similar|conflict|supplement|none","note":"一句话理由"}]}
每个候选都要给一项。`;

export interface RelationOutcome {
  candidates: number;
  related: number;
  conflicts: number;
  error?: string;
}

export async function buildRelations(docId: number): Promise<RelationOutcome> {
  const pairs = [...findCandidates(docId).values()];
  if (pairs.length === 0) return { candidates: 0, related: 0, conflicts: 0 };

  const newExcerpts = new Map<number, string>();
  for (const p of pairs) {
    if (!newExcerpts.has(p.newChunkId)) {
      const row = db.prepare('SELECT content FROM chunks WHERE id = ?').get(p.newChunkId) as
        | { content: string }
        | undefined;
      newExcerpts.set(p.newChunkId, (row?.content ?? '').replace(/\s+/g, ' ').slice(0, 200));
    }
  }

  const listing = pairs
    .map((p, i) => `[${i}] 旧文档《${p.oldTitle}》「${p.oldHeading || '正文'}」:${p.oldExcerpt}`)
    .join('\n');
  const newSide = [...newExcerpts.entries()]
    .map(([id, text]) => `新文档摘录(chunk ${id}):${text}`)
    .join('\n');

  let items: { i: number; type: string; note: string }[];
  try {
    items = await callJson<{ i: number; type: string; note: string }[]>({
      system: REL_SYSTEM,
      user: `${newSide}\n\n库内候选:\n${listing}`,
      validate: (v) => {
        if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
        const arr = (v as Record<string, unknown>).items;
        if (!Array.isArray(arr)) return '缺少 items 数组';
        if (arr.length !== pairs.length) return `items 应为 ${pairs.length} 项(每个候选一项)`;
        const ok = arr.every((it) => {
          const o = it as Record<string, unknown>;
          return (
            Number.isInteger(o.i) &&
            (o.i as number) >= 0 &&
            (o.i as number) < pairs.length &&
            ['similar', 'conflict', 'supplement', 'none'].includes(String(o.type))
          );
        });
        if (!ok) return 'items 中存在非法序号或 type';
        return arr.map((it) => {
          const o = it as Record<string, unknown>;
          return { i: o.i as number, type: String(o.type), note: String(o.note ?? '') };
        });
      },
    });
  } catch (e) {
    // 关系判定是增强功能:失败不影响文档,只汇报
    return {
      candidates: pairs.length,
      related: 0,
      conflicts: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const insRel = db.prepare(
    "INSERT OR IGNORE INTO relations (type, doc_a, chunk_a, doc_b, chunk_b, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insInbox = db.prepare(
    "INSERT INTO inbox (type, payload, created_at) VALUES ('conflict_review', ?, ?)",
  );
  let related = 0;
  let conflicts = 0;
  for (const it of items) {
    if (it.type === 'none') continue;
    const p = pairs[it.i]!;
    const status = it.type === 'conflict' ? 'undecided' : 'na';
    const res = insRel.run(it.type, docId, p.newChunkId, p.oldDocId, p.oldChunkId, it.note, status, now());
    if (Number(res.changes) === 0) continue; // 已存在同一条边
    related++;
    if (it.type === 'conflict') {
      conflicts++;
      insInbox.run(
        JSON.stringify({
          relationId: Number(res.lastInsertRowid),
          newDocId: docId,
          oldDocId: p.oldDocId,
          oldTitle: p.oldTitle,
          note: it.note,
        }),
        now(),
      );
    }
  }
  return { candidates: pairs.length, related, conflicts };
}
