/**
 * 规则层:个人化规则的存取(文档 06"规则层"的落地)。
 *
 * 规则是几句自然语言(技术栈、在学什么、偏好),不搞结构化表单 ——
 * 它的消费者是 LLM prompt(问答/摘要/编译),自然语言就是它的原生格式。
 * 全局一份:单机单人,区域分化暂时没有真实需求。
 */
import { db } from './index.js';

const KEY_RULES = 'rules';

export function getRules(): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY_RULES) as { value: string } | undefined;
  return row?.value ?? '';
}

export function setRules(text: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(KEY_RULES, text.trim());
}
