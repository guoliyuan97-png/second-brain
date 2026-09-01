/**
 * 四层数据模型(方案定稿版):
 *
 *   原文层   documents + chunks        不可变,唯一可信源
 *   元数据层 tags / document_tags /    入库时由 LLM 生成,可随时全量重算
 *            summaries / relations
 *   流程层   inbox / regions(配置)   待办收件箱 + 区域即配置对象
 *
 * 设计约束(来自与用户的约定,改动前先确认):
 * 1. 原文不可变:任何"更新"只发生在元数据层;
 * 2. 标签 1~5 个,不许硬凑,新标签必须走 pending 审批;
 * 3. 关系层只记录"相似/冲突/补充",冲突的裁决权在用户。
 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS regions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE NOT NULL,            -- 'learning' | 'work' | ...
  name        TEXT NOT NULL,
  -- 区域是配置对象:将来 local_only=1 的区域可切换为本地嵌入/本地模型
  local_only  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- ── 原文层 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id     INTEGER NOT NULL REFERENCES regions(id),
  source_type   TEXT NOT NULL,                 -- 'file' | 'url' | 'research'
  source_ref    TEXT NOT NULL,                 -- 原始文件路径或 URL(追溯用)
  title         TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,                 -- 原文快照(原文件可能被移动/修改,库内只认快照)
  content_hash  TEXT NOT NULL,                 -- 规范化文本的 sha256,去重指纹
  char_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE(region_id, content_hash)              -- 同区域内去重;跨区允许(分区语义优先)
);

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,               -- 在文档内的顺序
  heading_path TEXT NOT NULL,                  -- "第3节 > 第2小节",引用定位("看哪部分")的落点
  content      TEXT NOT NULL,
  UNIQUE(document_id, ordinal)
);

-- FTS5 外部内容表:索引存于独立影子表,靠下面的触发器与 chunks 保持同步
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, content='chunks', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- ── 元数据层 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id   INTEGER NOT NULL REFERENCES regions(id),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'approved', -- 'approved' | 'pending'
  merged_into INTEGER REFERENCES tags(id),      -- 改名/合并指针:旧标签解析时顺链找到存活标签
  created_at  TEXT NOT NULL,
  UNIQUE(region_id, name)
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id),
  source      TEXT NOT NULL DEFAULT 'llm',      -- 'llm' | 'human'(人裁决后重打)
  PRIMARY KEY (document_id, tag_id)
);

CREATE TABLE IF NOT EXISTS summaries (
  document_id   INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  key_points    TEXT NOT NULL,                  -- JSON string[]
  prerequisites TEXT,                           -- JSON string[] | NULL
  version_notes TEXT,                           -- 适用版本/时效说明 | NULL
  value_note    TEXT,                           -- "对我的价值":有立场的摘要(W5+,受规则层影响)
  created_at    TEXT NOT NULL
);

-- ── 编译层:主题结论页(W5+,文档 06/08 的"编译"思想) ──────────────
-- 主题页是派生数据:可重算、可更新、可删除,不违反"原文不可变"。
-- slug 即编译主题(现阶段 = 标签名),同 slug 重编译 = 更新而非新建。
CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id  INTEGER NOT NULL REFERENCES regions(id),
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,                     -- Markdown 结论页
  doc_ids    TEXT NOT NULL,                     -- JSON number[],参与编译的文档
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(region_id, slug)
);

-- ── 规则层:个人化规则(key-value,W5+) ───────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 向量索引(W6.3):chunk 语义向量,混合召回的"语义路" ──────────────
-- 向量存普通 BLOB(归一化 Float32Array),查询时载入内存做余弦 ——
-- 个人规模(千级 chunk)暴力检索毫秒级,不需要向量数据库服务。
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                 -- 生成模型标识(切换模型后按 provider+dim 重算)
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL
);

-- 关系层:相似/冲突/补充,永远是"一对 chunk"之间的边
CREATE TABLE IF NOT EXISTS relations (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  type     TEXT NOT NULL,                       -- 'similar' | 'conflict' | 'supplement'
  doc_a    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_a  INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  doc_b    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_b  INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  note     TEXT NOT NULL,                       -- LLM 判定理由(人审时看这个)
  -- 冲突裁决状态;similar/supplement 固定 'na'
  status   TEXT NOT NULL DEFAULT 'undecided',   -- 'undecided'|'a_active'|'b_active'|'both_valid'|'na'
  created_at TEXT NOT NULL,
  UNIQUE(chunk_a, chunk_b, type)
);

-- ── 流程层:待办收件箱 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,                    -- 'tag_review' | 'conflict_review' | 'tagging_failed' | 'save_review'
  payload     TEXT NOT NULL,                    -- JSON,内容视 type 而定
  status      TEXT NOT NULL DEFAULT 'open',     -- 'open' | 'resolved'
  -- 用户在整理台做了什么(批准/合并到X/裁决为新版为准…):审计用,不改 payload
  resolution  TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
`;
