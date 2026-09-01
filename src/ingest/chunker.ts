/**
 * 结构感知切块。
 *
 * 规则(优先级从高到低):
 * 1. heading_path 变化 → 必须开新 chunk(引用定位的最小单位是"小节");
 * 2. 同一 heading_path 下连续段落合并,累计不超过目标长度;
 * 3. 单段超长 → 按句边界切开(句号/问号/换行),不硬切词中间。
 *
 * heading_path 会存进 chunks 表,回答引用时用户看到的是
 * 「出自《xxx》"架构思维 > 为什么要分层"」这样的定位。
 */
import { config } from '../config.js';
import type { ParsedBlock } from '../parse/types.js';

export interface Chunk {
  headingPath: string;
  content: string;
}

function splitLong(text: string, target: number): string[] {
  if (text.length <= target) return [text];
  // 在标点后断句,保留标点;单句超过 target 时整句保留(宁可长不可断义)
  const sentences = text.split(/(?<=[。!?!?;;\n])/);
  const parts: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && buf.length + s.length > target) {
      parts.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

export function chunkBlocks(blocks: ParsedBlock[], target = config.chunkTargetChars): Chunk[] {
  const chunks: Chunk[] = [];
  let curPath = '';
  let buf: string[] = [];
  let bufLen = 0;

  const push = () => {
    const content = buf.join('\n\n').trim();
    if (content) chunks.push({ headingPath: curPath, content });
    buf = [];
    bufLen = 0;
  };

  for (const b of blocks) {
    const pieces = splitLong(b.text, target);
    for (const piece of pieces) {
      if (b.headingPath !== curPath) push();
      curPath = b.headingPath;
      if (bufLen > 0 && bufLen + piece.length > target) push();
      buf.push(piece);
      bufLen += piece.length;
    }
  }
  push();
  return chunks;
}
