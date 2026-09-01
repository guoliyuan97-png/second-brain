/**
 * 数据库打开与初始化。
 *
 * 为什么用 node:sqlite(Node 24 内置)而不是 better-sqlite3:
 * - 零原生依赖,Windows 下不需要 node-gyp 编译,换机器即装即用;
 * - 同步 API 更贴近"脚本管线"的心智模型(没有并发写竞争——本机单用户)。
 *
 * FTS5 分词器的坑(教学重点):
 * - unicode61 对中文"整句成词",检索基本不可用;
 * - trigram(三元组)按每 3 个字符切索引,中文子串检索可用,
 *   但代价是查询词至少要 3 个字符 —— 所以 2 字中文词要走 LIKE 兜底,
 *   这个逻辑在 search.ts 里实现。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from '../config.js';
import { SCHEMA_SQL } from './schema.js';

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(join(DATA_DIR, 'snapshots'), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// WAL 模式:读写不互斥,崩溃后也不容易留下一个损坏的库
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(SCHEMA_SQL);

// 轻量迁移:老库补列。已存在时 ALTER 报错,静默忽略
// (本项目数据可随时 reset 重建,不引入正式迁移框架 —— 依赖最少原则)
for (const ddl of [
  'ALTER TABLE inbox ADD COLUMN resolution TEXT', // W4:裁决审计
  'ALTER TABLE summaries ADD COLUMN value_note TEXT', // W5:有立场的摘要
]) {
  try {
    db.exec(ddl);
  } catch {
    /* 列已存在 */
  }
}

/** 统一的 now():SQLite datetime('now') 是 UTC,这里统一存本地时间字符串方便人读 */
export function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
