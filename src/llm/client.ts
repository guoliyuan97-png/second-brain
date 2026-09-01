/**
 * LLM 客户端:只封装"结构化 JSON 调用"这一种能力。
 *
 * 设计原则(与狼人杀同源):LLM 只做"理解和写作",所有输出的"合法性"
 * 由确定性校验器把关 —— validate 返回错误字符串时,把错误喂回模型重试,
 * 重试仍失败则交给调用方的兜底逻辑,管线永不因模型抽风而中断。
 */
import { config } from '../config.js';

export class LlmError extends Error {}

/** validate(data) 返回解析后的 T;返回 string 视为"不合法,附上原因" */
type Validator<T> = (data: unknown) => T | string;

export async function callJson<T>(opts: {
  system: string;
  user: string;
  validate: Validator<T>;
  maxTokens?: number;
  temperature?: number;
}): Promise<T> {
  const { apiKey, baseUrl, model } = config.llm;
  if (!apiKey) throw new LlmError('LLM_API_KEY 未配置(检查 .env)');

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const userMsg =
      attempt === 1
        ? opts.user
        : `${opts.user}\n\n【上次输出不合法,原因:${lastError}\n请修正后重新输出,只输出 JSON。】`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 2000,
        response_format: { type: 'json_object' }, // 强制 JSON,减少解析失败
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: userMsg },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      lastError = `输出不是合法 JSON(前 100 字:${text.slice(0, 100)})`;
      continue;
    }
    const validated = opts.validate(parsed);
    if (typeof validated === 'string') {
      lastError = validated;
      continue;
    }
    return validated;
  }
  throw new LlmError(`LLM 输出连续 3 次不合法:${lastError}`);
}

/** 通用 JSON 数组字段提取:保证是 string[],多余项去掉 */
export function expectStringArray(v: unknown, field: string): string[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return `字段 ${field} 应为数组`;
  return v.map((x) => String(x));
}

/**
 * 流式对话:纯文本输出,边生成边通过 onDelta 回调(参数是全量文本)。
 * 用于问答正文 —— 回答是带 [n] 引用的自由文本,不需要 JSON 校验重试;
 * 打标/关系/编译这类结构化输出仍走 callJson。
 * 返回完整回答(已 trim)。SSE 解析:DeepSeek 返回 OpenAI 兼容格式(data: {...} / [DONE])。
 */
export async function streamChat(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  onDelta?: (full: string) => void;
}): Promise<string> {
  const { apiKey, baseUrl, model } = config.llm;
  if (!apiKey) throw new LlmError('LLM_API_KEY 未配置(检查 .env)');
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 2000,
      stream: true,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new LlmError('LLM HTTP ' + res.status + ': ' + body.slice(0, 300));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          full += delta;
          opts.onDelta?.(full);
        }
      } catch {
        /* 忽略无法解析的行(心跳/注释) */
      }
    }
  }
  if (!full.trim()) throw new LlmError('LLM 流式返回为空');
  return full.trim();
}
