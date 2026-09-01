/**
 * 问答入库(显式 opt-in)。
 *
 * 产品拍板(W5 后):问答不询问入库 —— 回答本身源于库内检索,
 * 只有深度研究(外部新知识)才在完成后询问沉淀。
 * 保留的能力:
 * - CLI `ask --save`:用户显式要求时照常入库(source_type='research');
 * - saveQaFromInbox:处理历史遗留的 save_review 条目(W4 时期暂存的),
 *   直到整理台把它们处理完毕。
 *
 * 正文末尾附"引用来源"清单:入库后的 QA 文档仍能追溯"结论从哪几段来",
 * 这是"引用到段落"原则在沉淀环节的延续。
 */
import { now } from '../db/index.js';
import { ingestText, type IngestResult } from '../ingest/pipeline.js';
import type { QaCitation, QaResult } from './answer.js';

function composeBody(qa: QaResult): string {
  const sources = qa.citations
    .map((c) => `- [${c.n}]《${c.title}》「${c.headingPath || '正文'}」(文档 #${c.docId})`)
    .join('\n');
  return `${qa.answer}\n\n---\n引用来源:\n${sources || '(无编号引用)'}`;
}

export async function saveQaToLibrary(qa: QaResult, regionSlug: string): Promise<IngestResult> {
  return ingestText(`问答:${qa.question}`, composeBody(qa), {
    regionSlug,
    sourceRef: `qa:${now().slice(0, 10)}`,
  });
}

/** 历史遗留:整理台"稍后"的问答从收件箱 payload 重建并入库 */
export function saveQaFromInbox(
  payload: { question: string; answer: string; citations?: QaCitation[] },
  regionSlug: string,
): Promise<IngestResult> {
  const qa: QaResult = {
    question: payload.question,
    answer: payload.answer,
    sufficient: true,
    citations: payload.citations ?? [],
    usedDocs: [],
    conflictNotes: [],
    retrieval: { retriever: 'from-inbox', candidates: 0 },
  };
  return saveQaToLibrary(qa, regionSlug);
}
