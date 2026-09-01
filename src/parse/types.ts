/**
 * 解析器的统一产出:结构化段落列表。
 *
 * 关键设计:解析不做任何"改写",只做"结构标注" ——
 * heading_path 用来实现"引用要指出看原文哪部分",段落文本保持原文原样。
 */
export interface ParsedBlock {
  /** 如 "架构思维 > 为什么要分层";顶层/无标题段落为空串 */
  headingPath: string;
  text: string;
}

export interface ParsedDoc {
  title: string;
  blocks: ParsedBlock[];
}

/** 各解析器共用的空格规整(不改变内容本身) */
export function tidy(text: string): string {
  return text.replace(/[ \t]+/g, ' ').trim();
}
