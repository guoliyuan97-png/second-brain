/**
 * 评估集校准(W6.4):评估集随库漂移的自动检测。
 *
 * 问题:评估用例的期望写死于某个时点;库内容持续变化后,检索可能返回
 * 真正相关的新文档,却被旧期望判为"未命中"(错杀),或真的检索失败被掩盖。
 *
 * 机制:跑完评估后,对每个未命中的用例,让 LLM 对着"实际引用的内容"判断:
 * - stale(期望过时):实际引用真的回答了问题 → 建议把实际文档加入期望名单;
 * - real-miss(真失败):实际引用确实答非所问 → 保持失败,提示修检索;
 * 判定只是建议,拍板在用户:整理台卡片上"按建议更新 / 忽略"。
 * 待拍板项持久化在 eval/pending-calibration.json,应用重启不丢。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';
import { db } from '../db/index.js';
import { callJson } from '../llm/client.js';
import { runEvalCore, loadSetRaw, saveSet, type EvalOutcome, type EvalCase } from './run.js';

export type CalibrationVerdict = 'stale' | 'real-miss' | 'unclear';

export interface CalibrationSuggestion {
  q: string;
  verdict: CalibrationVerdict;
  reason: string;
  expected: string[];
  /** 建议加入期望的文档(id + 标题,应用时按标题子串写入 set.json) */
  suggestedDocs: { id: number; title: string }[];
}

export interface EvalRunResult {
  summary: {
    runAt: string;
    total: number;
    citationHitRate: string;
    mentionedRate: string;
    usableRate: string;
    avgLatencySec: string;
  };
  suggestions: CalibrationSuggestion[];
}

const pendingFile = (): string => join(ROOT, 'eval', 'pending-calibration.json');

function loadPending(): EvalRunResult | null {
  if (!existsSync(pendingFile())) return null;
  try {
    return JSON.parse(readFileSync(pendingFile(), 'utf8')) as EvalRunResult;
  } catch {
    return null;
  }
}

function savePending(p: EvalRunResult | null): void {
  const file = pendingFile();
  if (!p) {
    if (existsSync(file)) rmSync(file);
    return;
  }
  writeFileSync(file, JSON.stringify(p, null, 2), 'utf8');
}

const CALIBRATE_SYSTEM = `你是评估集的校准助手。知识库内容会持续变化,评估用例的期望可能过时。
给你一条评估用例的判定:测试问题、期望命中的文档、以及实际检索引用的文档与摘录。
判断实际引用的内容是否真正回答了测试问题:
- stale:真的回答了 → 期望过时,给出应加入期望名单的文档标题(从实际引用中选,可多个);
- real-miss:实际引用答非所问 → 真实的检索失败;
- unclear:无法判断。
real-miss 或 unclear 时 addTitles 为空数组。
只输出 JSON:{"verdict":"stale|real-miss|unclear","reason":"一句话理由","addTitles":["实际引用中的文档标题"]}`;

/** 跑评估 + 对未命中用例做漂移判定,结果持久化为待拍板清单 */
export async function runEvalWithCalibration(onProgress?: (stage: string) => void): Promise<EvalRunResult> {
  onProgress?.('评估中(每例一次真实问答)…');
  const summary = await runEvalCore(undefined, (i, total, q) => onProgress?.(`评估中(${i}/${total}):${q.slice(0, 20)}`));

  const misses = summary.outcomes.filter((o) => !o.citationHit && !o.error);
  onProgress?.(`校准判定中(${misses.length} 条未命中)…`);
  const suggestions: CalibrationSuggestion[] = [];

  if (misses.length > 0) {
    const set = loadSetRaw();
    const caseOf = (q: string): EvalCase | undefined => set.cases.find((c) => c.q === q);

    for (const o of misses) {
      const c = caseOf(o.q);
      const expected = c
        ? Array.isArray(c.docMustInclude)
          ? c.docMustInclude
          : [c.docMustInclude]
        : [];
      const cited = o.citations
        .map((cit) => {
          const title = cit.title;
          const snippet = cit.snippet.slice(0, 150);
          return `- 《${title}》「${cit.headingPath || '正文'}」:${snippet}`;
        })
        .join('\n');
      try {
        const r = await callJson<{ verdict: string; reason: string; addTitles: string[] }>({
          system: CALIBRATE_SYSTEM,
          user: `【测试问题】${o.q}\n【期望命中的文档】${expected.join(' / ') || '(无)'}\n【实际检索引用的文档与摘录】\n${cited || '(无引用)'}\n【回答摘录】${o.answerExcerpt}`,
          validate: (v) => {
            if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
            const verdict = String((v as Record<string, unknown>).verdict ?? '');
            const reason = String((v as Record<string, unknown>).reason ?? '').trim();
            const addTitles = Array.isArray((v as Record<string, unknown>).addTitles)
              ? ((v as Record<string, unknown>).addTitles as unknown[]).map(String).filter(Boolean)
              : [];
            if (!['stale', 'real-miss', 'unclear'].includes(verdict)) return 'verdict 非法';
            if (!reason) return 'reason 不能为空';
            return { verdict: verdict as CalibrationVerdict, reason, addTitles };
          },
          maxTokens: 500,
        });
        // 把建议标题映射回引用里的文档 id
        const suggestedDocs = r.addTitles
          .map((t) => {
            const hit = o.citations.find((cit) => cit.title.includes(t) || t.includes(cit.title));
            return hit ? { id: hit.docId, title: hit.title } : null;
          })
          .filter((d): d is { id: number; title: string } => !!d);
        suggestions.push({ q: o.q, verdict: r.verdict as CalibrationVerdict, reason: r.reason, expected, suggestedDocs });
      } catch (e) {
        suggestions.push({
          q: o.q,
          verdict: 'unclear',
          reason: '校准判定失败:' + (e instanceof Error ? e.message : String(e)),
          expected,
          suggestedDocs: [],
        });
      }
    }
  }

  const result: EvalRunResult = {
    summary: {
      runAt: summary.runAt,
      total: summary.total,
      citationHitRate: summary.citationHitRate,
      mentionedRate: summary.mentionedRate,
      usableRate: summary.usableRate,
      avgLatencySec: summary.avgLatencySec,
    },
    suggestions,
  };
  savePending(result);
  return result;
}

export function getPendingCalibration(): EvalRunResult | null {
  return loadPending();
}

/** 拍板:按建议更新评估集期望(docMustInclude 追加建议文档标题子串) */
export function applyCalibration(q: string, addTitles: string[]): { applied: string[] } {
  const set = loadSetRaw();
  const c = set.cases.find((x) => x.q === q);
  if (!c) throw new Error('评估集中找不到该用例');
  const arr = Array.isArray(c.docMustInclude) ? [...c.docMustInclude] : [c.docMustInclude];
  const applied: string[] = [];
  for (const t of addTitles) {
    if (!arr.some((e) => e === t)) {
      arr.push(t);
      applied.push(t);
    }
  }
  c.docMustInclude = arr;
  saveSet(set);
  // 用例已校准:从待拍板清单移除
  const p = loadPending();
  if (p) {
    p.suggestions = p.suggestions.filter((x) => x.q !== q);
    savePending(p);
  }
  return { applied };
}

/** 拍板:忽略(确属检索失败,保持期望不变) */
export function dismissCalibration(q: string): void {
  const p = loadPending();
  if (p) {
    p.suggestions = p.suggestions.filter((x) => x.q !== q);
    savePending(p);
  }
}
