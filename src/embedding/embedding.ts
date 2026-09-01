/**
 * 向量嵌入(W6.3):混合召回的"语义路"。
 *
 * 设计要点(每个都有明确的取舍理由):
 * - 双 Provider:本地 onnx(bge-small-zh,离线零成本,模型缓存进数据目录)
 *   / OpenAI 兼容 API(硅基流动 bge-m3 等需 key)。auto = 本地失败自动退 API。
 * - 惰性加载:transformers.js 很重,只在第一次真正嵌入时动态 import;
 *   Provider 为 off 或加载失败时,应用其余功能完全不受影响。
 * - 存储就是 SQLite BLOB:归一化后的 Float32Array,查询时整体载入内存
 *   做暴力余弦 —— 千级 chunk 毫秒级,不需要向量数据库服务。
 * - provider+dim 是向量的一部分:换模型后旧向量自动失效,按新模型重算。
 */
import { join } from 'node:path';
import { db } from '../db/index.js';
import { DATA_DIR, config } from '../config.js';

export type EmbeddingKind = 'local' | 'api' | 'off';

export interface EmbeddingStatus {
  provider: EmbeddingKind;
  dims: number;
  embedded: number;
  total: number;
  running: boolean;
  stage: string;
}

let resolvedKind: EmbeddingKind | null = null;
let localFailed = false; // 本地模型加载/推理失败过 → auto 场景退 API,并避免反复重试
type LocalExtractor = (texts: string[], opts: { pooling: string; normalize: boolean }) => Promise<{ dims: number[]; data: Float32Array }>;
let extractorPromise: Promise<LocalExtractor> | null = null;

function resolveKind(): EmbeddingKind {
  if (resolvedKind) return resolvedKind;
  const cfg = config.embeddingProvider;
  if (cfg === 'off') resolvedKind = 'off';
  else if (cfg === 'api') resolvedKind = config.embeddingApiKey ? 'api' : 'off';
  else resolvedKind = 'local'; // 'local' 与 'auto' 都先尝试本地
  return resolvedKind;
}

async function getLocalExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const tf = await import('@huggingface/transformers');
      tf.env.remoteHost = config.embeddingMirror;
      tf.env.cacheDir = join(DATA_DIR, 'models');
      tf.env.allowLocalModels = true;
      return tf.pipeline('feature-extraction', config.embeddingLocalModel) as unknown as Promise<LocalExtractor>;
    })();
    // 失败允许重试(比如网络恢复),但不要让同一个失败 promise 被反复 await
    extractorPromise.catch(() => {
      extractorPromise = null;
    });
  }
  return extractorPromise;
}

async function embedLocal(texts: string[]): Promise<Float32Array[]> {
  const extractor = await getLocalExtractor();
  const out = await extractor(texts, { pooling: 'cls', normalize: true });
  // 注意:v4 的 Tensor 是 Proxy,不能用 .map(回调里 .data 为 undefined);
  // 用 dims 把平铺数据按 batch 切片
  const shape = out.dims as unknown as number[];
  const flat = Float32Array.from(out.data as Float32Array);
  const dim = (shape[shape.length - 1] as number) ?? 512;
  const batch = shape.length > 1 ? (shape[0] as number) : 1;
  const result: Float32Array[] = [];
  for (let i = 0; i < batch; i++) result.push(flat.slice(i * dim, (i + 1) * dim));
  return result;
}

async function embedApi(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch(`${config.embeddingApiBase}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.embeddingApiKey}` },
    body: JSON.stringify({ model: config.embeddingApiModel, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`嵌入 API HTTP ${res.status}`);
  const j = (await res.json()) as { data: { embedding: number[] }[] };
  return j.data.map((d) => Float32Array.from(d.embedding));
}

/** 嵌入一组文本;provider 不可用返回 null。查询文本加 bge 检索指令。 */
export async function embedTexts(texts: string[], kind: 'local' | 'api', isQuery = false): Promise<Float32Array[]> {
  const input = isQuery
    ? texts.map((t) => config.embeddingQueryPrefix + t)
    : texts;
  if (kind === 'api') return embedApi(input);
  try {
    return await embedLocal(input);
  } catch (e) {
    localFailed = true;
    resolvedKind = null; // 触发重新解析(auto 可能退到 api)
    if (resolveKind() === 'api' && config.embeddingApiKey) return embedApi(input);
    throw e;
  }
}

/** 当前是否可用(用于检索路由决策)。provider off / 本地已失败且无 API key → false */
export function embeddingReady(): boolean {
  const k = resolveKind();
  if (k === 'off') return false;
  if (k === 'api') return true;
  return !localFailed;
}

export function embeddingKind(): EmbeddingKind {
  return resolveKind();
}

export function markLocalFailed(): void {
  localFailed = true;
  resolvedKind = null;
}

// ── 存储 + 检索 ───────────────────────────────────────────────────

const PROVIDER_ID = () => `${config.embeddingLocalModel}@${resolveKind()}`;
let dims = 512;

export function embeddingsStatus(): EmbeddingStatus {
  const k = resolveKind();
  const total = (db.prepare('SELECT COUNT(*) n FROM chunks').get() as unknown as { n: number }).n;
  const embedded =
    k === 'off'
      ? 0
      : (
          db
            .prepare('SELECT COUNT(*) n FROM embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.provider = ? AND e.dim = ?')
            .get(PROVIDER_ID(), dims) as unknown as { n: number }
        ).n;
  return { provider: k, dims, embedded, total, running: backfillRunning, stage: backfillStage };
}

function toBlob(f: Float32Array): Buffer {
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function fromBlob(b: Uint8Array | Buffer, dim: number): Float32Array {
  const ab = new ArrayBuffer(dim * 4);
  new Uint8Array(ab).set(b.slice(0, dim * 4));
  return new Float32Array(ab);
}

let backfillRunning = false;
let backfillStage = '';

/** 后台补全:为还没有向量的 chunk 计算 embedding(单飞,重复调用安全) */
export function requestBackfill(): void {
  if (backfillRunning || resolveKind() === 'off' || localFailed) return;
  backfillRunning = true;
  void (async () => {
    try {
      const kind = resolveKind();
      const provider = PROVIDER_ID();
      for (;;) {
        const rows = db
          .prepare(
            `SELECT c.id, c.content FROM chunks c
             LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.provider = ? AND e.dim = ?
             WHERE e.chunk_id IS NULL LIMIT 16`,
          )
          .all(provider, dims) as unknown as { id: number; content: string }[];
        if (rows.length === 0) break;
        backfillStage = `嵌入 ${rows.length} 个片段…`;
        const vecs = await embedTexts(
          rows.map((r) => r.content),
          kind === 'api' ? 'api' : 'local',
        );
        const ins = db.prepare('INSERT OR REPLACE INTO embeddings (chunk_id, provider, dim, vec) VALUES (?, ?, ?, ?)');
        for (let i = 0; i < rows.length; i++) {
          ins.run(rows[i]!.id, provider, dims, toBlob(vecs[i]!));
        }
        vecCacheDirty = true;
      }
      backfillStage = '完成';
    } catch (e) {
      backfillStage = '失败:' + (e instanceof Error ? e.message : String(e));
      if (resolveKind() === 'local') markLocalFailed();
    } finally {
      backfillRunning = false;
    }
  })();
}

// 向量缓存:整表载入内存(千级 chunk 约 10MB),回填后失效重载
let vecCache: Map<number, Float32Array> | null = null;
let vecCacheDirty = true;

function loadVecCache(): Map<number, Float32Array> {
  if (!vecCache || vecCacheDirty) {
    const rows = db
      .prepare('SELECT chunk_id, vec FROM embeddings WHERE provider = ? AND dim = ?')
      .all(PROVIDER_ID(), dims) as unknown as { chunk_id: number; vec: Buffer }[];
    vecCache = new Map(rows.map((r) => [r.chunk_id, fromBlob(r.vec, dims)]));
    vecCacheDirty = false;
  }
  return vecCache;
}

export interface VectorHit {
  chunkId: number;
  score: number;
}

/** 余弦检索(向量已归一化,点积即相似度)。返回 topK 个 {chunkId, 相似度} */
export function vectorTopK(queryVec: Float32Array, k: number, regionSlug?: string): VectorHit[] {
  const cache = loadVecCache();
  if (cache.size === 0) return [];
  // 只对区域内 chunk 打分:先取区域内的 chunk 集合
  let candidates: { id: number; vec: Float32Array }[];
  if (regionSlug) {
    const rows = db
      .prepare(
        `SELECT e.chunk_id, e.vec FROM embeddings e
         JOIN chunks ch ON ch.id = e.chunk_id
         JOIN documents d ON d.id = ch.document_id
         JOIN regions r ON r.id = d.region_id
         WHERE e.provider = ? AND e.dim = ? AND r.slug = ?`,
      )
      .all(PROVIDER_ID(), dims, regionSlug) as unknown as { chunk_id: number; vec: Buffer }[];
    candidates = rows.map((r) => ({ id: r.chunk_id, vec: fromBlob(r.vec, dims) }));
  } else {
    candidates = [...cache.entries()].map(([id, vec]) => ({ id, vec }));
  }
  const scored = candidates
    .map((c) => {
      let dot = 0;
      for (let i = 0; i < queryVec.length && i < c.vec.length; i++) dot += queryVec[i]! * c.vec[i]!;
      return { chunkId: c.id, score: dot };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

/** 查询向量:带 bge 检索指令 */
export async function embedQuery(query: string): Promise<Float32Array | null> {
  const k = resolveKind();
  if (k === 'off') return null;
  try {
    const [v] = await embedTexts([query], k === 'api' ? 'api' : 'local', true);
    return v ?? null;
  } catch {
    markLocalFailed();
    return null;
  }
}
