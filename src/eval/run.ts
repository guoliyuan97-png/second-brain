/**
 * 评估集跑分器(W5):个人知识系统的"体温计"。
 *
 * 量三个硬指标,全部可确定性判定,不靠感觉:
 * 1. 引用命中(citationHit):回答的编号引用是否落在了期望文档上
 *    —— "引用到段落"是本系统的立身之本,引错文档等于答错;
 * 2. 要点覆盖(mentioned):预设的关键事实词(同义词组任一命中)是否出现在回答里;
 * 3. 回答可用(usable):有引用、且模型自认材料充分。
 *
 * 不做 LLM-as-judge 给分数:三项硬指标全部确定性判定;
 * LLM 只在"校准"环节判断期望是否随库漂移(见 calibrate.ts),拍板权在用户。
 * 跑分直接走 ask 同一条管线,测的就是用户拿到的。
 *
 * W6.4:runEvalCore 从 CLI 拆出(服务端评估任务复用);
 * docMustInclude 数组化(任一命中即算)—— 校准按数组追加期望。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db } from '../db/index.js';
import { ROOT } from '../config.js';
import { answerQuestion, type QaCitation } from '../qa/answer.js';

export interface EvalCase {
  q: string;
  /** 期望命中的文档标题子串(数组任一命中即算;兼容旧的单一字符串) */
  docMustInclude: string | string[];
  answerMustInclude: string[];
  note?: string;
}

export interface EvalOutcome {
  q: string;
  citationHit: boolean;
  mentioned: boolean;
  usable: boolean;
  citedDocs: string[];
  citedDocIds: number[];
  /** 完整引用(校准用:判断"实际引用是否真的回答了问题") */
  citations: QaCitation[];
  answerExcerpt: string;
  missingKeywords: string[];
  latencyMs: number;
  error?: string;
}

export interface EvalSummary {
  runAt: string;
  total: number;
  citationHitRate: string;
  mentionedRate: string;
  usableRate: string;
  avgLatencySec: string;
  outcomes: EvalOutcome[];
}

function docTitleOf(docId: number): string {
  const d = db.prepare('SELECT title FROM documents WHERE id = ?').get(docId) as { title: string } | undefined;
  return d?.title ?? `#${docId}`;
}

function setFile(setPath?: string): string {
  return setPath ?? join(ROOT, 'eval', 'set.json');
}

export function loadSetRaw(setPath?: string): { cases: EvalCase[] } {
  return JSON.parse(readFileSync(setFile(setPath), 'utf8'));
}

export function saveSet(set: { cases: EvalCase[] }, setPath?: string): void {
  writeFileSync(setFile(setPath), JSON.stringify(set, null, 2) + '\n', 'utf8');
}

/** 期望数组化(兼容旧单一字符串) */
function expectationsOf(c: EvalCase): string[] {
  return Array.isArray(c.docMustInclude) ? c.docMustInclude : [c.docMustInclude];
}

/** 纯函数化的一轮评估:不打印,返回结构化结果(CLI 与服务端任务共用) */
export async function runEvalCore(
  setPath: string | undefined,
  onProgress?: (i: number, total: number, q: string) => void,
): Promise<EvalSummary> {
  const set = loadSetRaw(setPath);
  const outcomes: EvalOutcome[] = [];

  for (const [i, c] of set.cases.entries()) {
    onProgress?.(i + 1, set.cases.length, c.q);
    const t0 = Date.now();
    const row: EvalOutcome = {
      q: c.q,
      citationHit: false,
      mentioned: false,
      usable: false,
      citedDocs: [],
      citedDocIds: [],
      citations: [],
      answerExcerpt: '',
      missingKeywords: [],
      latencyMs: 0,
    };
    try {
      const qa = await answerQuestion(c.q);
      row.latencyMs = Date.now() - t0;
      row.citations = qa.citations;
      row.answerExcerpt = qa.answer.slice(0, 240);
      row.citedDocIds = [...new Set(qa.citations.map((x) => x.docId))];
      row.citedDocs = row.citedDocIds.map(docTitleOf);
      const expectations = expectationsOf(c);
      // 引用命中:实际引用(或摘要层参考)的文档命中期望名单中任一子串
      row.citationHit = expectations.some(
        (e) => row.citedDocs.some((t) => t.includes(e)) || qa.usedDocs.some((d) => d.title.includes(e)),
      );
      row.missingKeywords = c.answerMustInclude.filter((k) => !qa.answer.includes(k));
      // 同义词组语义:任一关键词命中即算覆盖(如 版权/侵权/商用 是同一要点的不同说法)
      row.mentioned = c.answerMustInclude.some((k) => qa.answer.includes(k));
      row.usable = qa.sufficient && qa.citations.length > 0;
    } catch (e) {
      row.latencyMs = Date.now() - t0;
      row.error = e instanceof Error ? e.message : String(e);
    }
    outcomes.push(row);
  }

  const n = outcomes.length;
  const rate = (k: 'citationHit' | 'mentioned' | 'usable') =>
    ((outcomes.filter((o) => o[k] === true).length / n) * 100).toFixed(0);
  const avgLatency = (outcomes.reduce((s, o) => s + o.latencyMs, 0) / n / 1000).toFixed(1);

  return {
    runAt: new Date().toLocaleString('zh-CN'),
    total: n,
    citationHitRate: rate('citationHit') + '%',
    mentionedRate: rate('mentioned') + '%',
    usableRate: rate('usable') + '%',
    avgLatencySec: avgLatency,
    outcomes,
  };
}

/** CLI 入口:跑分 + 控制台报告 + 写明细 */
export async function runEval(setPath?: string): Promise<void> {
  const summary = await runEvalCore(setPath, (i, total, q) => {
    if (i === 1) console.log(`评估集 ${total} 例,逐一作答中(每例一次真实问答)…\n`);
  });

  for (const row of summary.outcomes) {
    const mark = (ok: boolean) => (ok ? '✔' : '✘');
    console.log(
      `${mark(row.citationHit)}引 ${mark(row.mentioned)}点 ${mark(row.usable)}用 ` +
        `${(row.latencyMs / 1000).toFixed(1)}s ${row.q}`,
    );
    if (row.error) console.log(`    错误:${row.error}`);
    if (!row.citationHit) console.log(`    引用落在:[${row.citedDocs.join(' / ') || '无'}]`);
    if (!row.mentioned) console.log(`    缺关键词:${row.missingKeywords.join('、')}`);
  }

  console.log(`\n===== 汇总(${summary.total} 例) =====`);
  console.log(
    `引用命中:${summary.citationHitRate}  要点覆盖:${summary.mentionedRate}  回答可用:${summary.usableRate}  平均耗时:${summary.avgLatencySec}s`,
  );

  const outPath = join(ROOT, 'eval', 'results.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('明细已写入 eval/results.json');
}
