/**
 * 配置中心:所有"环境差异"(路径、端口、密钥)收敛在这一个文件,
 * 业务代码永远不直接碰 process.env / 相对路径。
 *
 * .env 加载是自己实现的(十行):学习项目依赖越少越好,
 * dotenv 的本质也就是"读文件 → 按行 split → 写进 process.env"。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录(不依赖 cwd,从任何地方跑 CLI 都能找到 data/)。
 *  打包态(Electron exe)由主进程注入 SB_ROOT=应用资源目录(public/.env 所在),
 *  并注入 SB_DATA_DIR=系统用户数据目录(data 所在)——
 *  数据必须住在应用文件夹之外:electron-builder 重打包会整个重建应用目录,
 *  数据放里面等于每次升级/修 bug 都清空用户知识库(W6 血的教训)。 */
export const ROOT = process.env.SB_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.SB_DATA_DIR ?? join(ROOT, 'data');
export const DB_PATH = join(DATA_DIR, 'secondbrain.db');
export const SNAPSHOTS_DIR = join(DATA_DIR, 'snapshots');
/** 一致性备份目录(VACUUM INTO 快照,启动时滚动保留 7 份) */
export const BACKUPS_DIR = join(DATA_DIR, 'backups');
/** Web 静态资源目录(W2):Vue3 不走构建链,直接本地 vendor 引入 */
export const PUBLIC_DIR = join(ROOT, 'public');

function loadEnv(): void {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (process.env[key] === undefined) {
      // 去掉可选的成对引号
      process.env[key] = raw.replace(/^["'](.*)["']$/, '$1');
    }
  }
}
loadEnv();

export const config = {
  port: Number(process.env.PORT ?? 8790),
  llm: {
    apiKey: process.env.LLM_API_KEY ?? '',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
  },
  /** chunk 目标长度(字符)。中文按字算,800 字约是"半屏到一屏"的信息密度,
   *  太碎会让引用定位啰嗦,太粗会让"看哪部分"失去指向性。 */
  chunkTargetChars: 800,
  /** 单次喂给 LLM 的正文上限(字符),防止长文把上下文和费用撑爆 */
  llmMaxInputChars: 6000,
  /** 入库时找相似旧文的最大候选数。top-k 限定对比范围,
   *  避免"新文档 vs 全库两两对比"的 O(n²) 成本。 */
  relationTopK: 6,
  // ── 问答(W2)─────────────────────────────────────────────────
  /** 检索候选上限(粗排)。之后按文档聚合精选,给 LLM 的材料远小于这个数 */
  qaTopK: 24,
  /** 材料里最多带几篇文档(摘要层)。太多会让回答失焦、成本上升 */
  qaMaxDocs: 4,
  /** 编号引用的原文片段上限。8 段 × 500 字 ≈ 4000 字,加摘要控制在一次调用的舒适区 */
  qaMaxChunks: 8,
  /** 每个引用片段的摘录长度(字符) */
  qaChunkSnippetChars: 500,
  /** 反思自检(W7.1):回答生成后 LLM 对照引用原文逐条校验 [n] 论断,
   *  不自洽带原因重试一次。QA_REFLECT=off 可关(每答省一次调用);
   *  评估跑分走同一条管线,同受此开关控制 */
  qaReflect: process.env.QA_REFLECT !== 'off',
  // ── 深度研究(W3)─────────────────────────────────────────────
  /** LLM 生成的检索词组数上限 */
  researchMaxQueries: 4,
  /** 每组检索词取多少条搜索结果(去重前) */
  researchResultsPerQuery: 8,
  /** 实际抓取正文的最大页面数。抓太多费时费钱,先小步走 */
  researchMaxSources: 8,
  /** 抓取并发:礼貌抓取,不打疼对方服务器 */
  researchFetchConcurrency: 3,
  /** 报告生成的 max_tokens(报告比问答长,默认 2000 不够写) */
  researchReportMaxTokens: 4000,
  // ── 向量检索(W6.3)────────────────────────────────────────────
  /** auto=优先本地模型(失败退 API);off=纯词面检索。API 走 OpenAI 兼容 /embeddings */
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? 'auto') as 'auto' | 'local' | 'api' | 'off',
  embeddingApiKey: process.env.EMBEDDING_API_KEY ?? '',
  embeddingApiBase: process.env.EMBEDDING_API_BASE ?? 'https://api.siliconflow.cn/v1',
  embeddingApiModel: process.env.EMBEDDING_API_MODEL ?? 'BAAI/bge-m3',
  embeddingLocalModel: process.env.EMBEDDING_LOCAL_MODEL ?? 'Xenova/bge-small-zh-v1.5',
  embeddingMirror: process.env.EMBEDDING_MIRROR ?? 'https://hf-mirror.com',
  /** bge 中文检索指令:加在查询前提升命中(bge 官方建议) */
  embeddingQueryPrefix: '为这个句子生成表示以用于检索相关文章：',
  /** 混合召回:向量路取多少候选 */
  vectorTopK: 12,
};
