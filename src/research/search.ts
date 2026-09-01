/**
 * 联网搜索器:Deep Research 的"眼睛"。
 *
 * SearchProvider 与检索层的 Retriever 同构:接口在前、实现在后,
 * 将来换 Tavily/Brave(要 key)时,研究管线一行不改。
 *
 * 当前实现:Bing(cn.bing.com)HTML 版,零 API key。
 * - 实测 DuckDuckGo 在本项目目标网络不可达(连接超时),Bing 直连可用;
 * - 解析的是无 JS 的服务端渲染结果:li.b_algo 块 → h2 锚点(真实 URL+标题)
 *   → b_caption 段落(摘要),正则即可,不引 HTML 解析依赖;
 * - 个人本机低频使用(一次研究 3~5 组词,组间休眠),对服务足够礼貌。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit?: number): Promise<WebSearchResult[]>;
}

/** 最小实体解码:命名实体只留常见的一批,数字实体通用处理 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;|&emsp;/g, ' ')
    .replace(/&middot;|&#0183;|&#183;/g, '·')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** 单条结果块 → {url,title,snippet};块内 h2 锚点的 href 即真实目标(Bing 不包跳转壳) */
function parseBlock(block: string): WebSearchResult | null {
  const head = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  if (!head) return null;
  const url = decodeEntities(head[1]!);
  if (!/^https?:\/\//.test(url)) return null;
  const cap = block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
  const fallback = cap ? '' : (block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '');
  return { url, title: stripTags(head[2]!), snippet: stripTags(cap?.[1] ?? fallback) };
}

export const bingSearch: SearchProvider = {
  name: 'bing-web',

  async search(query: string, limit = 8): Promise<WebSearchResult[]> {
    // count 双倍申请:过滤掉非 http/重复后仍够 limit
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(limit * 2, 30)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`搜索 HTTP ${res.status}(查询:${query})`);
    const html = await res.text();

    const seen = new Set<string>();
    const out: WebSearchResult[] = [];
    for (const m of html.matchAll(/<li class="b_algo[\s\S]*?<\/li>/g)) {
      const r = parseBlock(m[0]);
      if (!r) continue;
      const key = r.url.replace(/#.*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= limit) break;
    }
    if (out.length === 0) {
      // 零结果:要么真没有,要么被弹了人机验证页 —— 统一报错让上层决定换词或终止
      throw new Error(`搜索无结果(查询:${query};若反复出现,可能是 Bing 人机验证,稍后再试)`);
    }
    return out;
  },
};
