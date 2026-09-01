/**
 * 研究沉淀:报告 + 来源快照一键入库 —— A 腿与知识库的汇合点。
 *
 * 关键点:
 * - 报告走 ingestText(source_type='research'),按 Markdown 标题切块;
 * - 来源走 ingestFetched(研究时抓的 rawHtml 直接落快照,不二次抓取),
 *   于是每个来源都获得标签/摘要,并与库内旧知识(包括报告本身)做关系对比
 *   —— "报告引用了哪些文档"从文本约定升级成了库内的 relation 边;
 * - withSources=false 时只沉淀报告,报告正文仍附来源清单(URL 可追溯)。
 */
import { db, now } from '../db/index.js';
import { ingestFetched, ingestText, type IngestResult } from '../ingest/pipeline.js';
import type { ResearchResult } from './pipeline.js';

export interface ResearchSaveOutcome {
  report: IngestResult;
  sources: { n: number; url: string; result?: IngestResult; error?: string }[];
}

function reportBody(result: ResearchResult): string {
  const list = result.sources.map((s) => `- [${s.n}] 《${s.title}》 ${s.finalUrl}`).join('\n');
  return `${result.report}\n\n---\n来源清单:\n${list || '(无)'}`;
}

export async function saveResearchToLibrary(
  result: ResearchResult,
  opts: { regionSlug: string; withSources: boolean },
): Promise<ResearchSaveOutcome> {
  const report = await ingestText(`研究:${result.question}`, reportBody(result), {
    regionSlug: opts.regionSlug,
    sourceRef: 'deep-research',
  });

  const sources: ResearchSaveOutcome['sources'] = [];
  if (opts.withSources) {
    for (const s of result.sources) {
      try {
        sources.push({ n: s.n, url: s.url, result: await ingestFetched(s.article, { regionSlug: opts.regionSlug }) });
      } catch (e) {
        // 单个来源入库失败(如打标异常)不影响其余来源与报告
        sources.push({ n: s.n, url: s.url, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { report, sources };
}

/** 稍后处理:整份研究进收件箱,W4 整理台统一裁决(与问答的 save_review 同型) */
export function deferResearchToInbox(result: ResearchResult): number {
  const res = db
    .prepare("INSERT INTO inbox (type, payload, created_at) VALUES ('save_review', ?, ?)")
    .run(
      JSON.stringify({
        question: result.question,
        report: result.report,
        sources: result.sources.map((s) => ({ n: s.n, title: s.title, url: s.finalUrl })),
        kind: 'research',
      }),
      now(),
    );
  return Number(res.lastInsertRowid);
}

/**
 * 整理台"稍后"的研究从收件箱 payload 恢复,只入库报告本身 ——
 * payload 里没有 rawHtml,来源若还要入库得重新抓取,那是用户的主动选择
 * (重新 import URL 即可),默认不做,保持"稍后处理"轻量。
 */
export function saveResearchFromInbox(
  payload: { question: string; report: string; sources?: { n: number; title: string; url: string }[] },
  regionSlug: string,
): Promise<IngestResult> {
  const list = (payload.sources ?? []).map((s) => `- [${s.n}] 《${s.title}》 ${s.url}`).join('\n');
  const body = `${payload.report}\n\n---\n来源清单:\n${list || '(无)'}`;
  return ingestText(`研究:${payload.question}`, body, { regionSlug, sourceRef: 'deep-research' });
}
