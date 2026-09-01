/** 按扩展名分发到对应解析器。新格式(PDF…)在这里加一行分支即可。 */
import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { parseMarkdown } from './markdown.js';
import { parseDocx } from './docx.js';
import type { ParsedDoc } from './types.js';

export type { ParsedDoc, ParsedBlock } from './types.js';

export const SUPPORTED_EXT = ['.md', '.markdown', '.txt', '.docx'];

export async function parseFile(filePath: string): Promise<ParsedDoc> {
  const ext = extname(filePath).toLowerCase();
  const fallbackTitle = basename(filePath, ext);
  switch (ext) {
    case '.md':
    case '.markdown':
      return parseMarkdown(readFileSync(filePath, 'utf8'));
    case '.txt': {
      const text = readFileSync(filePath, 'utf8');
      // 纯文本没有标题结构:整篇当一段,标题取文件名
      return { title: fallbackTitle, blocks: [{ headingPath: '', text: text.trim() }] };
    }
    case '.docx':
      return parseDocx(filePath, fallbackTitle);
    default:
      throw new Error(`暂不支持的格式:${ext}(当前支持 ${SUPPORTED_EXT.join(' / ')})`);
  }
}
