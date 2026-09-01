/**
 * 反思自检单测(真实 LLM,两次便宜调用):验证 reflectCitations 双路行为 ——
 * 张冠李戴的误引必须抓到,忠实原文的引用不能误报。
 * 跑法:SB_DATA_DIR=E:/second-brain-data npx tsx scripts/test-reflect.ts
 */
import { reflectCitations } from '../src/qa/answer.js';

const citations = [
  {
    n: 1,
    chunkId: 1,
    docId: 1,
    title: 'MCP 协议入门',
    headingPath: '传输层',
    snippet: 'MCP 的消息格式基于 JSON-RPC 2.0,客户端与服务端之间的所有通信都封装为 JSON-RPC 请求与响应。',
    via: 'fts',
  },
  {
    n: 2,
    chunkId: 2,
    docId: 2,
    title: 'second-brain 部署说明',
    headingPath: '服务端口',
    snippet: '服务默认监听 8790 端口,只绑定 127.0.0.1 回环地址,绝不部署公网。',
    via: 'fts',
  },
];

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

// 用例 1:论断内容出自片段 [2],却标了 [1](张冠李戴)→ 必须抓到
const bad = await reflectCitations(
  'second-brain 服务监听哪个端口?',
  'second-brain 服务默认监听 8790 端口,只绑定本机回环地址,不对公网开放 [1]。',
  citations,
);
check('误引能抓到', bad.length > 0, JSON.stringify(bad));

// 用例 2:论断与 [1] 原文一致 → 不能误报
const good = await reflectCitations('MCP 的消息格式是什么?', 'MCP 的消息格式基于 JSON-RPC 2.0,通信封装为请求与响应 [1]。', citations);
check('正确引用不误报', good.length === 0, JSON.stringify(good));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
