/**
 * 检索层:问答与"找文档"共用的唯一入口。
 *
 * 接口可替换(教学重点):上层(QA / CLI / Web)只依赖 Retriever 接口,
 * 将来上向量检索(嵌入模型 + 余弦相似)时,新实现往这里一挂,
 * 甚至做"FTS 粗筛 + 向量精排"的混合召回 —— 上层业务一行不改。
 *
 * 当前实现是纯词面检索,零 token,共三级:
 * 1. ≥3 字探针走 FTS5 trigram 短语(见 db/index.ts 的教学注释);
 * 2. 2 字中文词 trigram 建不了索引(3 字符下限),退化 LIKE 子串匹配;
 * 3. 问答场景额外做"摘要层召回":拿问题里的 2 字关键词去匹配
 *    key_points/标题,把词面没命中 chunk、但摘要相关的文档补进来 ——
 *    摘要是入库时花过一次钱的知识蒸馏,召回时零成本复用。
 *
 * 本机单用户、万级 chunk 以内,LIKE 全表扫完全够用,不过度设计。
 */
import { db } from '../db/index.js';
import { config } from '../config.js';
import { embeddingReady, embedQuery, vectorTopK } from '../embedding/embedding.js';

export interface RetrievedChunk {
  chunkId: number;
  docId: number;
  title: string;
  headingPath: string;
  content: string;
  /** bm25 分(越小越相关);LIKE 命中没有分数,记 -1(排序按层级:FTS 恒在前) */
  score: number;
  via: 'fts' | 'like' | 'vector' | 'both';
}

export interface RetrieveOptions {
  /** 返回上限(合并去重后) */
  limit?: number;
  /** 限定区域;不传 = 全库 */
  regionSlug?: string;
}

export interface Retriever {
  readonly name: string;
  retrieve(query: string, opts?: RetrieveOptions): RetrievedChunk[];
}

// ── 查询构造:自然语言 → 检索探针 ─────────────────────────────────
//
// 用户的问题是一句自然语言,直接整句扔给 trigram MATCH 会做
// "整句短语匹配",几乎永远命不中(W1 踩过同款坑:60 字连续短语
// 在关系对比里候选为 0)。所以拆成两类探针,用 OR 连接,
// 靠 bm25 按词汇重合密度排序:
// - 英文/数字词:直接当 FTS 短语(LLM/ReAct/API 这类术语很关键);
// - 中文连续段:3 字滑窗(步长 3,覆盖所有对齐位置)+ 整段短语探针
//   (整段一旦字符级命中,必然是最强信号,bm25 会把它排前面)。
//
// 已知边界:滑窗探针会跨词边界("分层架构"切成"分层架/层架构"),
// 若语料里从未出现这种连续 3 字序列就会漏 —— 这部分交给下面的
// 2 字 gram LIKE 召回兜底(如"分层""好处"这类真正的词)。

interface QueryPlan {
  /** 交给 chunks_fts MATCH 的 OR 表达式;null 表示没有可用探针 */
  ftsMatch: string | null;
  /** 直接走 LIKE 的短词(2 字中文段、<3 字符英文词) */
  likeTerms: string[];
}

function esc(s: string): string {
  return s.replace(/"/g, '""');
}

export function buildQueryPlan(text: string): QueryPlan {
  const ftsPhrases: string[] = [];
  const likeTerms: string[] = [];

  // 英文/数字词(含驼峰、连字符):LLM、ReAct、FTS5、gpt-4o
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]+/g)) {
    const w = m[0];
    if (w.length >= 3) ftsPhrases.push(`"${esc(w)}"`);
    else likeTerms.push(w);
  }

  // 中文连续段
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0];
    if (seg.length === 2) {
      likeTerms.push(seg);
      continue;
    }
    ftsPhrases.push(`"${esc(seg)}"`); // 整段短语探针(强信号,可空手而归)
    const grams: string[] = [];
    for (let i = 0; i + 3 <= seg.length && grams.length < 16; i += 3) {
      grams.push(`"${esc(seg.slice(i, i + 3))}"`);
    }
    ftsPhrases.push(...grams);
  }

  const seen = new Set<string>();
  const uniq = ftsPhrases.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return {
    ftsMatch: uniq.length ? uniq.join(' OR ') : null,
    likeTerms: [...new Set(likeTerms)],
  };
}

// ── 2 字关键词:跨词边界的召回兜底 ────────────────────────────────

/** 零信息量 2 字组合黑名单:切出来的若是虚词组合,查了也是噪音 */
const CN_STOPGRAMS = new Set([
  '什么', '怎么', '怎样', '如何', '哪些', '哪个', '为何', '多少',
  '可以', '应该', '需要', '能够', '使用', '进行', '关于', '通过',
  '还是', '以及', '但是', '然后', '如果', '虽然', '因为', '所以',
  '这个', '那个', '一个', '一些', '就是', '自己', '我们', '他们',
  '是否', '或者', '并且', '比如', '例如', '你的', '我的', '里出',
]);

/** 从中文连续段切 2 字关键词(步长 3 采样,限量,去停用词) */
export function extractLikeGrams(text: string): string[] {
  const terms: string[] = [];
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0];
    if (seg.length === 2) {
      terms.push(seg);
      continue;
    }
    for (let i = 0; i + 2 <= seg.length && terms.length < 12; i += 3) {
      const g = seg.slice(i, i + 2);
      if (!CN_STOPGRAMS.has(g)) terms.push(g);
    }
  }
  return [...new Set(terms)];
}

function likeEscape(w: string): string {
  return `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function regionFilter(regionSlug?: string): { join: string; where: string; param?: string } {
  if (!regionSlug) return { join: '', where: '', param: undefined };
  return { join: 'JOIN regions rg ON rg.id = d.region_id', where: 'AND rg.slug = ?', param: regionSlug };
}

// ── FTS 检索器(默认实现) ─────────────────────────────────────────

export const ftsRetriever: Retriever = {
  name: 'fts-trigram',

  retrieve(query: string, opts: RetrieveOptions = {}): RetrievedChunk[] {
    const limit = opts.limit ?? 20;
    const plan = buildQueryPlan(query);
    if (!plan.ftsMatch && plan.likeTerms.length === 0) return [];
    const rf = regionFilter(opts.regionSlug);
    const hits = new Map<number, RetrievedChunk>();
    const matchCount = new Map<number, number>();

    if (plan.ftsMatch) {
      const rows = db
        .prepare(
          `SELECT ch.id AS chunkId, ch.document_id AS docId, d.title, ch.heading_path AS headingPath, ch.content,
                  bm25(chunks_fts) AS score
           FROM chunks_fts f
           JOIN chunks ch ON ch.id = f.rowid
           JOIN documents d ON d.id = ch.document_id
           ${rf.join}
           WHERE chunks_fts MATCH ? ${rf.where}
           ORDER BY score LIMIT ?`,
        )
        .all(plan.ftsMatch, ...(rf.param ? [rf.param] : []), limit * 3) as unknown as (Omit<RetrievedChunk, 'via'>)[];
      for (const r of rows) hits.set(r.chunkId, { ...r, via: 'fts' });
    }

    // LIKE 兜底:2 字词与跨边界 gram。两个已知坑(都在实测里炸过):
    // 1. 按行序 LIMIT 逐词取候选,排在库后面的文档永远进不了候选
    //    ("MV"的命中被前面文档的"MVP"占满) → 改成单次加权 OR 扫描,
    //    权重 = 1/log(2+df),SQL 里按总分排序,全表无偏;
    // 2. 子串碰撞:%MV% 匹配 MVP → ASCII 词在 JS 侧做词边界校验
    //    (前后必须是非字母数字),碰词的贡献清零后重排。
    const likeTerms = [...new Set([...plan.likeTerms, ...extractLikeGrams(query)])];
    if (likeTerms.length) {
      const isAscii = (t: string) => /^[A-Za-z0-9]/.test(t);
      // 1) 每词文档频率(COUNT 全表扫,不取行)→ 稀有度权重
      const terms = likeTerms.map((t) => {
        const df = (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM chunks ch
               JOIN documents d ON d.id = ch.document_id
               ${rf.join}
               WHERE ch.content LIKE ? ESCAPE '\\' ${rf.where}`,
            )
            .get(likeEscape(t)) as unknown as { n: number }
        ).n;
        return {
          term: t,
          like: likeEscape(t),
          weight: 1 / Math.log(2 + df),
          re: isAscii(t) ? new RegExp(`(^|[^A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i') : null,
        };
      });
      // 2) 单次扫描:OR 命中全部候选,SQL 按"稀有度加权和"排序
      const where = terms.map(() => `ch.content LIKE ? ESCAPE '\\'`).join(' OR ');
      const scoreExpr = terms.map(() => `CASE WHEN ch.content LIKE ? ESCAPE '\\' THEN ? ELSE 0 END`).join(' + ');
      const rows = db
        .prepare(
          `SELECT ch.id AS chunkId, ch.document_id AS docId, d.title, ch.heading_path AS headingPath, ch.content,
                  ${scoreExpr} AS w
           FROM chunks ch
           JOIN documents d ON d.id = ch.document_id
           ${rf.join}
           WHERE ${where} ${rf.where}
           ORDER BY w DESC
           LIMIT 25`,
        )
        .all(
          // 占位符按 SQL 文本出现顺序绑定:scoreExpr(like,weight 交替)在前,WHERE 的 like 在后
          ...terms.flatMap((t) => [t.like, t.weight]),
          ...terms.map((t) => t.like),
          ...(rf.param ? [rf.param] : []),
        ) as unknown as (Omit<RetrievedChunk, 'via' | 'score'> & { w: number })[];
      // 3) JS 精排:ASCII 词做词边界校验,贡献清零;总分归零的整条剔除
      for (const r of rows) {
        let w = 0;
        for (const t of terms) {
          const hit = t.re ? t.re.test(r.content) : r.content.includes(t.term);
          if (hit) w += t.weight;
        }
        if (w <= 0) continue;
        if (!hits.has(r.chunkId)) hits.set(r.chunkId, { ...r, score: -1, via: 'like' });
        matchCount.set(r.chunkId, w);
      }
      // LIKE 层最多补 10 条,给 FTS 层让位(它们只是兜底,不该淹没精排)
      const likeKeep = [...hits.values()]
        .filter((h) => h.via === 'like')
        .sort((a, b) => (matchCount.get(b.chunkId) ?? 0) - (matchCount.get(a.chunkId) ?? 0))
        .slice(10);
      for (const h of likeKeep) {
        hits.delete(h.chunkId);
        matchCount.delete(h.chunkId);
      }
    }

    // 排序:FTS 层恒在前(按 bm25),LIKE 层在后(按命中关键词数)
    return [...hits.values()].sort((a, b) => {
      if (a.via !== b.via) return a.via === 'fts' ? -1 : 1;
      if (a.via === 'fts') return a.score - b.score;
      return (matchCount.get(b.chunkId) ?? 0) - (matchCount.get(a.chunkId) ?? 0);
    }).slice(0, limit);
  },
};

// ── 问答专用:chunk 检索 + 摘要层文档召回 ─────────────────────────

export interface QaRecall {
  chunks: RetrievedChunk[];
  /** 词面没召回、但摘要命中的文档(只有 key_points 可用,无编号引用) */
  summaryDocIds: number[];
}

/**
 * 问答的召回入口(异步,因为语义路要算查询向量):
 * 1. 词面路:chunk 三级检索(FTS/2字gram/摘要) + 2 字关键词扫摘要层;
 * 2. 语义路:查询向量 vs chunk 向量,余弦 top-K(向量索引可用时);
 * 3. RRF(倒数排名融合)合并两路 —— 词面保精确命中,语义补"同义不同词"。
 */
export async function retrieveForQa(question: string, opts: RetrieveOptions = {}): Promise<QaRecall> {
  const limit = opts.limit ?? config.qaTopK;
  const chunks = ftsRetriever.retrieve(question, { ...opts, limit });

  // ── 语义路:查询向量 + 余弦 topK(不可用/失败都静默退词面)────────
  let vecHits: { hit: RetrievedChunk; score: number }[] = [];
  let vectorUsed = false;
  try {
    if (embeddingReady()) {
      const qv = await embedQuery(question);
      if (qv) {
        const top = vectorTopK(qv, config.vectorTopK, opts.regionSlug);
        vectorUsed = top.length > 0;
        const titleStmt = db.prepare('SELECT title FROM documents WHERE id = ?');
        for (const v of top) {
          const row = db
            .prepare(
              `SELECT ch.document_id AS docId, d.title, ch.heading_path AS headingPath, ch.content
               FROM chunks ch JOIN documents d ON d.id = ch.document_id WHERE ch.id = ?`,
            )
            .get(v.chunkId) as unknown as { docId: number; title: string; headingPath: string; content: string } | undefined;
          if (row) {
            vecHits.push({
              hit: { chunkId: v.chunkId, docId: row.docId, title: row.title, headingPath: row.headingPath, content: row.content, score: v.score, via: 'vector' },
              score: v.score,
            });
          }
          void titleStmt;
        }
      }
    }
  } catch {
    vectorUsed = false; // 语义路失败不阻塞,词面结果照常返回
  }

  // ── RRF 融合:score = Σ 1/(K + rank),K=60(业界标准常数)──────────
  let fused: RetrievedChunk[];
  if (vectorUsed) {
    const K = 60;
    const fuse = new Map<number, { chunk: RetrievedChunk; score: number; lanes: Set<string> }>();
    const add = (chunk: RetrievedChunk, rank: number): void => {
      const cur = fuse.get(chunk.chunkId);
      if (cur) {
        cur.score += 1 / (K + rank + 1);
        cur.lanes.add(chunk.via);
        cur.chunk.via = cur.lanes.size > 1 ? 'both' : cur.chunk.via;
      } else {
        fuse.set(chunk.chunkId, { chunk: { ...chunk }, score: 1 / (K + rank + 1), lanes: new Set([chunk.via]) });
      }
    };
    chunks.forEach((h, r) => add(h, r));
    vecHits.forEach(({ hit }, r) => add(hit, r));
    fused = [...fuse.values()].sort((a, b) => b.score - a.score).map((f) => f.chunk);
  } else {
    fused = chunks;
  }

  const grams = extractLikeGrams(question);
  const seenDocs = new Set(fused.map((c) => c.docId));
  const summaryDocIds: number[] = [];
  if (grams.length === 0 || seenDocs.size >= config.qaMaxDocs) return { chunks: fused, summaryDocIds };

  const rf = regionFilter(opts.regionSlug);
  const conds = grams.map(() => `(s.key_points LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')`).join(' OR ');
  const params: (string | number)[] = grams.flatMap((g) => [likeEscape(g), likeEscape(g)]);
  if (rf.param) params.unshift(rf.param);
  const rows = db
    .prepare(
      `SELECT s.document_id AS id, s.key_points, d.title,
              (SELECT COUNT(*) FROM chunks ch WHERE ch.document_id = s.document_id) AS chunk_total
       FROM summaries s
       JOIN documents d ON d.id = s.document_id
       ${rf.join}
       WHERE ${conds} ${rf.where}`,
    )
    .all(...params) as unknown as { id: number; key_points: string; title: string; chunk_total: number }[];

  // 按命中关键词数排;已出现在 chunk 命中的文档不重复召回。
  // 阈值自适应:多词问题要求 ≥2 词命中压噪音,单词问题放宽到 1
  const need = Math.min(2, grams.length);
  const docScore = new Map<number, number>();
  for (const r of rows) {
    if (!seenDocs.has(r.id)) docScore.set(r.id, (docScore.get(r.id) ?? 0) + 1);
  }
  const room = config.qaMaxDocs - seenDocs.size;
  const recalled = [...docScore.entries()]
    .filter(([, n]) => n >= need)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(room, 0))
    .map(([id]) => id);

  for (const docId of recalled) {
    summaryDocIds.push(docId);
    // 该文档里拿 1~2 个 gram 命中的 chunk 当编号引用材料;一个都没有就只给摘要
    const inner = grams.map(() => 'content LIKE ? ESCAPE \'\\\'').join(' OR ');
    const crows = db
      .prepare(`SELECT id AS chunkId, document_id AS docId, heading_path AS headingPath, content FROM chunks WHERE document_id = ? AND (${inner}) LIMIT 2`)
      .all(docId, ...grams.map(likeEscape)) as unknown as (Omit<RetrievedChunk, 'via' | 'score' | 'title'>)[];
    for (const c of crows) {
      const title = (db.prepare('SELECT title FROM documents WHERE id = ?').get(docId) as unknown as { title: string }).title;
      fused.push({ ...c, title, score: -1, via: 'like' });
    }
  }
  return { chunks: fused, summaryDocIds };
}
