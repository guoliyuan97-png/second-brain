/**
 * 打标器:入库管线的"理解"环节。
 *
 * 一次 LLM 调用同时产出:标签(1~5,不许硬凑)+ 结构化摘要。
 * "不够别硬凑"不是提示词祈祷,而是校验器里的硬规则:
 * 违规输出会连同原因被喂回模型重试,3 次仍失败则走兜底
 * (文档照常入库、进 tagging_failed 待办),管线永不中断。
 */
import { db, now } from '../db/index.js';
import { config } from '../config.js';
import { getRules } from '../db/settings.js';
import { callJson, expectStringArray } from '../llm/client.js';
import { ensureTagForTagging, listApprovedTagNames } from './taxonomy.js';

/** 零信息量泛词黑名单:宁可没标签,不要这种标签 */
const GENERIC_TAGS = ['资料', '文档', '笔记', '其他', '学习', '杂项', '收藏', '知识', '文章', '内容', '整理'];

export interface TaggingResult {
  tags: string[];
  keyPoints: string[];
  prerequisites: string[];
  versionNotes?: string;
  valueNote?: string;
}

const SYSTEM_PROMPT = `你是个人知识库的编目员,为一份文档打标签并写结构化摘要。规则:
1. 标签 1~5 个:按内容真实信息密度给,撑不满 5 个就少给,严禁硬凑。
2. 优先从【已有词表】选;确实没有合适的才提新标签(中文短语,2~12 字)。
3. 这些零信息量标签禁止使用:${GENERIC_TAGS.join('、')}。
4. key_points 是 1~8 条"这篇内容讲了什么",每条一句话,写给未来忘了这篇内容的自己。
5. 内容若有版本/时效约束(如"仅适用于某软件 2.x"),写进 version_notes;没有就省略该字段。
6. value_note 是一句话"这篇内容对我的价值"(有立场的摘要):结合【主人画像】说明它对本人学习/开发有什么用;没有实质价值就省略。
只输出 JSON:
{"tags":["…"],"summary":{"key_points":["…"],"prerequisites":["…"],"version_notes":"…","value_note":"…"}}
其中 prerequisites、version_notes、value_note 可省略。`;

function validateTagging(v: unknown): TaggingResult | string {
  if (!v || typeof v !== 'object') return '顶层应为 JSON 对象';
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.tags)) return 'tags 应为字符串数组';
  const tags = [...new Set(o.tags.map((t) => String(t).trim()).filter(Boolean))];
  if (tags.length < 1) return '至少需要 1 个标签(不许硬凑,但也不能没有)';
  if (tags.length > 5) return '标签最多 5 个';
  for (const t of tags) {
    if (t.length < 2 || t.length > 16) return `标签「${t}」长度需在 2~16 字之间`;
    if (GENERIC_TAGS.includes(t)) return `「${t}」是零信息量泛词,请换一个具体标签`;
  }
  if (!o.summary || typeof o.summary !== 'object') return '缺少 summary 对象';
  const kp = expectStringArray((o.summary as Record<string, unknown>).key_points, 'key_points');
  if (typeof kp === 'string') return kp;
  if (kp.length < 1 || kp.length > 8) return 'key_points 应为 1~8 条';
  const pre = expectStringArray((o.summary as Record<string, unknown>).prerequisites, 'prerequisites');
  if (typeof pre === 'string') return pre;
  const vn = (o.summary as Record<string, unknown>).version_notes;
  const vnote = (o.summary as Record<string, unknown>).value_note;
  return {
    tags,
    keyPoints: kp,
    prerequisites: pre,
    versionNotes: typeof vn === 'string' && vn.trim() ? vn.trim() : undefined,
    valueNote: typeof vnote === 'string' && vnote.trim() ? vnote.trim() : undefined,
  };
}

export interface TagOutcome {
  ok: boolean;
  error?: string;
  tags?: string[];
  pendingTags?: string[];
}

export async function tagDocument(docId: number): Promise<TagOutcome> {
  const doc = db
    .prepare('SELECT d.*, r.name AS region_name FROM documents d JOIN regions r ON r.id = d.region_id WHERE d.id = ?')
    .get(docId) as
    | { id: number; region_id: number; title: string; region_name: string }
    | undefined;
  if (!doc) throw new Error(`文档 ${docId} 不存在`);

  const fullText = (
    db.prepare('SELECT content FROM chunks WHERE document_id = ? ORDER BY ordinal').all(docId) as unknown as {
      content: string;
    }[]
  )
    .map((c) => c.content)
    .join('\n\n');

  const approved = listApprovedTagNames(doc.region_id);
  const taxonomyHint = approved.length
    ? `【已有词表】${approved.join('、')}`
    : '【已有词表】(空,可自由申请新标签,第一批待审通过后就固定下来)';
  const rulesHint = getRules() ? `\n【主人画像与规则】value_note 要贴合这些个人约束:\n${getRules()}` : '';

  let result: TaggingResult;
  try {
    result = await callJson<TaggingResult>({
      system: SYSTEM_PROMPT,
      user: `区域:${doc.region_name}\n${taxonomyHint}${rulesHint}\n\n《${doc.title}》\n\n${fullText.slice(0, config.llmMaxInputChars)}`,
      validate: validateTagging,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    db.prepare("INSERT INTO inbox (type, payload, created_at) VALUES ('tagging_failed', ?, ?)").run(
      JSON.stringify({ documentId: docId, title: doc.title, error }),
      now(),
    );
    return { ok: false, error };
  }

  const pendingTags: string[] = [];
  const bind = db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id, source) VALUES (?, ?, ?)');
  for (const name of result.tags) {
    const { row, isNewPending } = ensureTagForTagging(doc.region_id, name);
    bind.run(docId, row.id, 'llm');
    if (row.status === 'pending') {
      pendingTags.push(name);
      if (isNewPending) {
        db.prepare("INSERT INTO inbox (type, payload, created_at) VALUES ('tag_review', ?, ?)").run(
          JSON.stringify({ tagName: name, documentId: docId, documentTitle: doc.title }),
          now(),
        );
      }
    }
  }

  // OR REPLACE:整理台可对打标失败的文档"重新打标"(元数据层可全量重算),
  // 重试成功时新摘要整体替换旧的,不会撞主键
  db.prepare(
    'INSERT OR REPLACE INTO summaries (document_id, model, key_points, prerequisites, version_notes, value_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    docId,
    config.llm.model,
    JSON.stringify(result.keyPoints),
    JSON.stringify(result.prerequisites),
    result.versionNotes ?? null,
    result.valueNote ?? null,
    now(),
  );

  return { ok: true, tags: result.tags, pendingTags };
}
