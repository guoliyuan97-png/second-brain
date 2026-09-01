/**
 * 启动时备份:每次服务启动用 VACUUM INTO 做一份一致性快照
 * (WAL 模式下直接拷 db 文件会漏掉 WAL 里未合并的数据,VACUUM INTO 不会),
 * 滚动保留最近 7 份。这是"不会塌"原则的兜底:库损坏/误清空时,
 * 用户最多丢最近一次启动之后的增量,而不是全部。
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './index.js';
import { DB_PATH, BACKUPS_DIR } from '../config.js';

const KEEP = 7;

export function backupOnStart(): void {
  if (!DB_PATH.endsWith('.db')) return; // 形状防御:只管 SQLite 主库
  try {
    mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    db.exec(`VACUUM INTO '${join(BACKUPS_DIR, `secondbrain-${stamp}.db`).replace(/\\/g, '/')}'`);

    // 滚动清理:只留最近 KEEP 份
    const files = readdirSync(BACKUPS_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ f, m: statSync(join(BACKUPS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const old of files.slice(KEEP)) unlinkSync(join(BACKUPS_DIR, old.f));
  } catch {
    // 备份失败不阻塞启动(比如磁盘满):主库照常用,下次启动再试
  }
}
