/**
 * 导入管线编排:解析 → 指纹 → 快照 → 落库 → 切块 → 打标/摘要 → 关系对比。
 *
 * 两个"原文不可变"的落点:
 * 1. 快照按内容寻址(文件名 = hash 前缀):同一内容只存一份,天然幂等;
 * 2. 指纹覆盖 title + heading_path + 正文:标题或结构变了也算新文档。
 *
 * 跨区重复不做硬拦截:同内容允许同时存在于学习区/工作区(分区语义优先),
 * 但 CLI 会明确提示,让用户知情。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { db, now } from '../db/index.js';
import { SNAPSHOTS_DIR } from '../config.js';
import { parseFile } from '../parse/index.js';
import { parseMarkdown } from '../parse/markdown.js';
import { fetchArticle, type FetchedArticle } from '../parse/url.js';
import type { ParsedDoc } from '../parse/types.js';
import { chunkBlocks } from './chunker.js';
import { contentHash } from './dedup.js';
import { getRegionBySlug } from '../tagging/taxonomy.js';
import { tagDocument, type TagOutcome } from '../tagging/tagger.js';
import { buildRelations, type RelationOutcome } from './relations.js';

export interface IngestResult {
  docId: number;
  title: string;
  chunks: number;
  /** 同区重复被跳过时给出,docId 指向已存在的记录 */
  skipped?: 'duplicate';
  duplicateOf?: number;
  crossRegionWarning?: string;
  tagging?: TagOutcome;
  relations?: RelationOutcome;
}

export interface IngestOptions {
  regionSlug: string;
  tag?: boolean;
  relations?: boolean;
}

async function persist(
  sourceType: 'file' | 'url' | 'research',
  sourceRef: string,
  parsed: ParsedDoc,
  snapshotContent: string | Buffer,
  snapshotExt: string,
  opts: IngestOptions,
): Promise<IngestResult> {
  const region = getRegionBySlug(opts.regionSlug);
  if (!region) {
    throw new Error(`区域「${opts.regionSlug}」不存在(可用:learning / work)`);
  }

  const fullText = parsed.blocks.map((b) => b.text).join('\n\n');
  const hash = contentHash(parsed.title + '\n' + parsed.blocks.map((b) => `${b.headingPath}\n${b.text}`).join('\n\n'));

  const dup = db.prepare('SELECT id, region_id FROM documents WHERE content_hash = ?').get(hash) as
    | { id: number; region_id: number }
    | undefined;
  if (dup && dup.region_id === region.id) {
    return { docId: dup.id, title: parsed.title, chunks: 0, skipped: 'duplicate', duplicateOf: dup.id };
  }

  // 内容寻址快照:写之前就确定路径,先落盘再进库(库里的引用永远有效)
  const snapPath = join(SNAPSHOTS_DIR, `${hash.slice(0, 16)}${snapshotExt}`);
  writeFileSync(snapPath, snapshotContent);

  const docRes = db
    .prepare(
      "INSERT INTO documents (region_id, source_type, source_ref, title, snapshot_path, content_hash, char_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(region.id, sourceType, sourceRef, parsed.title, snapPath, hash, fullText.length, now());
  const docId = Number(docRes.lastInsertRowid);

  const chunks = chunkBlocks(parsed.blocks);
  const insChunk = db.prepare('INSERT INTO chunks (document_id, ordinal, heading_path, content) VALUES (?, ?, ?, ?)');
  chunks.forEach((c, i) => insChunk.run(docId, i, c.headingPath, c.content));

  return {
    docId,
    title: parsed.title,
    chunks: chunks.length,
    crossRegionWarning: dup
      ? `注意:该内容已存在于其他区域(文档 #${dup.id}),本次按要求仍在「${region.name}」区入库`
      : undefined,
  };
}

export async function ingestFile(filePath: string, opts: IngestOptions): Promise<IngestResult> {
  const parsed = await parseFile(filePath);
  const raw = readFileSync(filePath); // 快照存原文件字节,原文件再被修改也不影响库内版本
  const result = await persist('file', filePath, parsed, raw, extname(filePath).toLowerCase() || '.bin', opts);
  if (!result.skipped) {
    if (opts.tag !== false) result.tagging = await tagDocument(result.docId);
    if (opts.relations !== false) result.relations = await buildRelations(result.docId);
  }
  return result;
}

export async function ingestUrl(url: string, opts: IngestOptions): Promise<IngestResult> {
  const article = await fetchArticle(url);
  return ingestFetched(article, opts);
}

/**
 * 已抓取的网页直接入库(W3 研究沉淀用):研究时抓过的页面在内存里留着
 * rawHtml,沉淀时不再二次抓取 —— 网页可能已变/已 404,而且省一半时间。
 * ingestUrl 现在只是"抓 + 本函数"的糖。
 */
export async function ingestFetched(article: FetchedArticle, opts: IngestOptions): Promise<IngestResult> {
  const result = await persist('url', article.finalUrl, article, article.rawHtml, '.html', opts);
  if (!result.skipped) {
    if (opts.tag !== false) result.tagging = await tagDocument(result.docId);
    if (opts.relations !== false) result.relations = await buildRelations(result.docId);
  }
  return result;
}

/**
 * 文本直接入库(问答沉淀 / 研究报告)。
 *
 * 文本按 Markdown 解析再切块(标题→heading_path):报告几千字若糊成
 * 单个 chunk,"引用定位到报告第几节"就失效了。source_type='research'
 * 让研究产物在文档列表里与导入文档可区分。
 */
export async function ingestText(
  title: string,
  text: string,
  opts: IngestOptions & { sourceRef?: string },
): Promise<IngestResult> {
  const parsed: ParsedDoc = { title, blocks: parseMarkdown(text).blocks };
  const result = await persist('research', opts.sourceRef ?? 'ad-hoc', parsed, text, '.md', opts);
  if (!result.skipped) {
    if (opts.tag !== false) result.tagging = await tagDocument(result.docId);
    if (opts.relations !== false) result.relations = await buildRelations(result.docId);
  }
  return result;
}
