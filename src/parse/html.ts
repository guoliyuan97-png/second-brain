/**
 * HTML → 结构化段落(docx 与 URL 两个来源共用)。
 *
 * 启发式简版:剥掉脚本/导航等噪声标签后,按 <h1-6>/<p>/<li>/<pre>/<blockquote>
 * 的出现顺序提取文本。教学项目先不引入 @mozilla/readability,
 * 哪些站点抽不好(重度 JS 渲染页)由调用方用"正文过短则报错"兜住,
 * 后续需要再换成熟库 —— 检索器、解析器都是同样的"可替换接口"思路。
 */
import type { ParsedBlock, ParsedDoc } from './types.js';
import { tidy } from './types.js';

const NOISE = /<(script|style|nav|header|footer|aside|noscript|svg|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi;

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return tidy(decodeEntities(html.replace(/<[^>]+>/g, ' ')));
}

export function htmlToBlocks(html: string): ParsedDoc {
  const cleaned = html.replace(NOISE, '');
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');

  const blocks: ParsedBlock[] = [];
  const stack: { level: number; text: string }[] = [];
  // 逐个匹配块级标签,exec 的推进顺序 = 文档出现顺序
  const re = /<(h[1-6]|p|li|blockquote|pre)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const tag = m[1]!.toLowerCase();
    const text = stripTags(m[2]!);
    if (!text) continue;
    if (tag.startsWith('h')) {
      const level = Number(tag[1]);
      stack.length = level - 1;
      stack.push({ level, text });
      continue;
    }
    const headingPath = stack.map((s) => s.text).join(' > ');
    // 连续同类段落不合并:保持"一段一块",chunker 负责合并
    blocks.push({ headingPath, text });
  }
  return { title: tidy(title), blocks };
}
