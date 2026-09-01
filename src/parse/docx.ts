/** docx → HTML(mammoth)→ 结构化段落。标题样式由 Word 的"标题1/2/…"而来。 */
import mammoth from 'mammoth';
import { htmlToBlocks } from './html.js';
import type { ParsedDoc } from './types.js';

export async function parseDocx(path: string, fallbackTitle: string): Promise<ParsedDoc> {
  const { value: html } = await mammoth.convertToHtml({ path });
  const doc = htmlToBlocks(html);
  return { title: doc.title || fallbackTitle, blocks: doc.blocks };
}
