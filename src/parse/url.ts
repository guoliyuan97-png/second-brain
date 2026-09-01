/**
 * URL 抓取:网页快照的"原文不可变"落点。
 *
 * 抓到的 HTML 原样存快照(raw.html),再抽正文 ——
 * 网页以后会改会 404,但库里的快照是死的,引用永远可回溯。
 * 非文本内容(PDF 链接等)直接拒绝,避免静默存进一个空文档。
 */
import { htmlToBlocks } from './html.js';
import type { ParsedDoc } from './types.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface FetchedArticle extends ParsedDoc {
  /** 原始 HTML(存快照用) */
  rawHtml: string;
  finalUrl: string;
}

export async function fetchArticle(url: string): Promise<FetchedArticle> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    throw new Error(`不支持的内容类型 ${contentType}(W1 只收 HTML 页面)`);
  }
  const rawHtml = await res.text();
  const doc = htmlToBlocks(rawHtml);
  const totalChars = doc.blocks.reduce((n, b) => n + b.text.length, 0);
  if (totalChars < 200) {
    throw new Error(
      `正文抽取只得到 ${totalChars} 字(页面可能是纯 JS 渲染,后续版本换 readability 方案)`,
    );
  }
  // 微信公众号等站点 <title> 常带站点后缀,保留原样即可,不去猜规则
  const title = doc.title || url;
  return { title, blocks: doc.blocks, rawHtml, finalUrl: res.url || url };
}
