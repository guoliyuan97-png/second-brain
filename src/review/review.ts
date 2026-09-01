/**
 * 回顾(文档 06"定期回顾"的学习版):总结本周新增 + 提示待重编译的主题
 * + 给出下一步深入建议 —— 选题层"结论→动作"精髓的改造形态。
 *
 * 刻意做成整理台里手动触发的按钮,而不是后台定时任务:
 * 桌面应用不常驻、LLM 调用不该无感烧钱、产出由用户决定何时要。
 */
import { db } from '../db/index.js';
import { config } from '../config.js';
import { callJson } from '../llm/client.js';
import { getRules } from '../db/settings.js';
import { topicSuggestions } from '../topics/compile.js';

export interface ReviewOutcome {
  content: string;
  newDocs: number;
  staleTopics: number;
}

export async function generateReview(regionId: number, days = 7): Promise<ReviewOutcome> {
  const since = new Date(Date.now() - days * 86400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const sinceStr = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`;

  const newDocs = db
    .prepare(
      `SELECT d.id, d.title, s.key_points FROM documents d
       LEFT JOIN summaries s ON s.document_id = d.id
       WHERE d.region_id = ? AND d.created_at >= ? ORDER BY d.created_at DESC LIMIT 15`,
    )
    .all(regionId, sinceStr) as unknown as { id: number; title: string; key_points: string | null }[];

  const stale = topicSuggestions(regionId).filter((s) => s.stale);

  if (newDocs.length === 0 && stale.length === 0) {
    return {
      content: `## 回顾\n\n最近 ${days} 天没有新增文档,也没有待重编译的主题。该进来料了 —— 知识库的编译层等着原料。`,
      newDocs: 0,
      staleTopics: 0,
    };
  }

  const docBlock = newDocs
    .map((d) => {
      let kp: string[] = [];
      try {
        kp = d.key_points ? (JSON.parse(d.key_points) as string[]) : [];
      } catch {
        /* 忽略 */
      }
      return `- 《${d.title}》\n${kp.map((k) => `  · ${k}`).join('\n') || '  · (无摘要)'}`;
    })
    .join('\n');

  const staleBlock = stale.map((s) => `- 「${s.slug}」(${s.docCount} 篇,已有主题页但来了新资料)`).join('\n');

  const rules = getRules();
  const r = await callJson<{ content: string }>({
    system: `你是个人知识库的回顾助手。基于本周新增资料和待重编译的主题,写一份简短的回顾。
结构(## 开头的小节):
## 本周新增要点 —— 每篇一行,提炼最值得记住的 1 个点;
## 待重编译的主题 —— 列出主题名和原因;
## 下一步建议 —— 结合个人规则,给出 2~3 条具体的学习/深入方向(每条一句话,可执行)。
规则:只依据材料;简体中文;Markdown;不要一级标题;总共不超过 400 字。
只输出 JSON:{"content":"…"}`,
    user: `【回顾范围】最近 ${days} 天\n\n【本周新增(${newDocs.length} 篇)】\n${docBlock || '(无)'}\n\n【待重编译主题】\n${staleBlock || '(无)'}${rules ? `\n\n【主人画像与规则】\n${rules}` : ''}`,
    validate: (v) => {
      if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
      const content = String((v as Record<string, unknown>).content ?? '').trim();
      if (content.length < 50) return 'content 应为不少于 50 字的回顾';
      return { content };
    },
    maxTokens: 1500,
  });

  return { content: r.content, newDocs: newDocs.length, staleTopics: stale.length };
}

export function recentDocCount(regionId: number, days = 7): number {
  const since = new Date(Date.now() - days * 86400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const sinceStr = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`;
  return (
    db.prepare('SELECT COUNT(*) AS n FROM documents WHERE region_id = ? AND created_at >= ?').get(regionId, sinceStr) as unknown as { n: number }
  ).n;
}
