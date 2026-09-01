/**
 * Markdown 结构解析(极简版)。
 *
 * 只做三件事:标题堆栈(→ heading_path)、空行分段、代码块独立成段。
 * 不渲染任何语法 —— **加粗、链接等标记原样保留**,遵守"原文忠实"原则:
 * 引用回原文时用户看到的就是他写的字。
 */
import type { ParsedBlock, ParsedDoc } from './types.js';
import { tidy } from './types.js';

export function parseMarkdown(text: string): ParsedDoc {
  const lines = text.split(/\r?\n/);
  const stack: { level: number; text: string }[] = [];
  const blocks: ParsedBlock[] = [];
  let title = '';
  let buf: string[] = [];
  let inCode = false;

  const headingPath = () => stack.map((s) => s.text).join(' > ');
  const flush = () => {
    const content = tidy(buf.join('\n'));
    if (content) blocks.push({ headingPath: headingPath(), text: content });
    buf = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      // 代码块整块独立成段:含首尾 fence 行,保持原样
      if (!inCode) {
        flush();
        inCode = true;
        buf.push(line);
      } else {
        buf.push(line);
        flush();
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      buf.push(line);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) {
      flush();
      const level = h[1]!.length;
      const text = tidy(h[2]!);
      // 层级回退:遇到 # 一级标题时,清掉栈里更深/同级的旧标题
      stack.length = level - 1;
      stack.push({ level, text });
      if (!title && level === 1) title = text;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();

  if (!title && blocks[0]) title = blocks[0].text.slice(0, 60);
  return { title, blocks };
}
