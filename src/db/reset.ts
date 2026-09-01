/**
 * 清空重置:CLI 与 Web(危险操作卡)共用的同一个函数 ——
 * 两边语义必须严格一致,不许有"界面重置"和"命令重置"两种行为。
 * 调用方负责自己的确认交互(CLI 是 --yes,Web 是输入确认词)。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { db } from './index.js';
import { SCHEMA_SQL } from './schema.js';
import { SNAPSHOTS_DIR } from '../config.js';
import { ensureRegions } from '../tagging/taxonomy.js';

export function resetAll(): void {
  for (const t of ['chunks_fts', 'chunks', 'document_tags', 'summaries', 'relations', 'inbox', 'tags', 'documents', 'topics', 'settings', 'regions']) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  db.exec(SCHEMA_SQL);
  rmSync(SNAPSHOTS_DIR, { recursive: true, force: true });
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  ensureRegions();
}
