/**
 * 去重指纹:规范化文本的 sha256。
 *
 * 规范化 = 去掉所有空白字符。中文文档的空白几乎不影响语义,
 * 同一篇内容因导出方式不同(多几个空行/空格)也能判重。
 * 注意这是"完全相同"级别的去重;改了一个字就算新文档 ——
 * "相似"交给关系层,不混在指纹里。
 */
import { createHash } from 'node:crypto';

export function contentHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, '')).digest('hex');
}
