/**
 * MCP stdio 端到端冒烟测试:拉起 build/mcp.mjs,按 JSON-RPC 走完
 * initialize → tools/list → tools/call,校验协议形状与业务返回。
 * 用法:node scripts/test-mcp.mjs [quick|full](full 追加 ask/research 两个 LLM 工具)
 */
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'quick';
const child = spawn(process.execPath, ['build/mcp.mjs'], {
  env: { ...process.env, SB_DATA_DIR: process.env.SB_DATA_DIR ?? 'E:/second-brain-data' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 1;
const pending = new Map();
let buf = '';

child.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('!! stdout 出现非协议行(会污染 stdio 通道):', line.slice(0, 120));
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      console.log(`<- 通知 ${msg.method}`, msg.params?.message ? `(${String(msg.params.message).slice(0, 40)}…)` : '');
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c}`));
child.on('exit', (code) => console.log(`server exited: ${code}`));

function request(method, params, timeoutMs = 240_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时(${timeoutMs}ms)`)), timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const trunc = (s, n = 260) => String(s).replace(/\s+/g, ' ').slice(0, n);
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

// ── 1. initialize 握手 ─────────────────────────────────────────────
const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '0.0.0' },
});
check('initialize', init.result?.serverInfo?.name === 'second-brain', `serverInfo=${JSON.stringify(init.result?.serverInfo)}`);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// ── 2. tools/list:恰好 4 个工具 ────────────────────────────────────
const list = await request('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
check(
  'tools/list = 4 个工具',
  JSON.stringify(names) === JSON.stringify(['ask_knowledge', 'list_topics', 'run_research', 'search_knowledge']),
  names.join(', '),
);

// ── 3. search_knowledge:真实库检索(零 LLM) ────────────────────────
const search = await request('tools/call', {
  name: 'search_knowledge',
  arguments: { query: 'MCP 协议 是什么', limit: 3 },
});
const searchText = search.result?.content?.[0]?.text ?? '';
check('search_knowledge 有结果', !search.result?.isError && searchText.length > 50, trunc(searchText, 180));
check('search_knowledge 带 via 标注', /via|vector|fts|both/.test(searchText) || searchText.includes('('), '');

// 区域校错路径
const badRegion = await request('tools/call', {
  name: 'search_knowledge',
  arguments: { query: '测试', region: 'nope' },
});
check('非法 region 报错可读', badRegion.result?.isError === true, trunc(badRegion.result?.content?.[0]?.text ?? '', 100));

// ── 4. list_topics:列表 + 单页全文 ─────────────────────────────────
const topics = await request('tools/call', { name: 'list_topics', arguments: {} });
const topicsText = topics.result?.content?.[0]?.text ?? '';
const tid = (topicsText.match(/topicId=(\d+)/) ?? [])[1];
check('list_topics 有列表', !topics.result?.isError && /topicId=\d+/.test(topicsText), trunc(topicsText, 160));
if (tid) {
  const one = await request('tools/call', { name: 'list_topics', arguments: { topicId: Number(tid) } });
  const oneText = one.result?.content?.[0]?.text ?? '';
  check(`list_topics(topicId=${tid}) 返回全文`, !one.result?.isError && oneText.length > 200, `正文 ${oneText.length} 字`);
} else {
  check('list_topics 单页', false, '列表为空,无法测单页');
}

if (mode === 'full') {
  // ── 5. ask_knowledge:真实 LLM 归纳问答(问库里真实覆盖的主题) ─────
  const ask = await request('tools/call', {
    name: 'ask_knowledge',
    arguments: { question: '我想搭建个人知识库,库里有哪些相关要点和经验?' },
  });
  const askText = ask.result?.content?.[0]?.text ?? '';
  check('ask_knowledge 有回答', !ask.result?.isError && askText.length > 80, trunc(askText, 200));
  check('ask_knowledge 带来源引用', /来源引用/.test(askText) && /\[1\]/.test(askText), '');

  // ── 6. run_research:长任务(1~3 分钟,带 progressToken 验进度通知) ─
  const t0 = Date.now();
  let progressCount = 0;
  const counter = (c) => {
    progressCount += (c.toString('utf8').match(/notifications\/progress/g) ?? []).length;
  };
  child.stdout.on('data', counter);
  const res = await request('tools/call', {
    name: 'run_research',
    arguments: { question: '2026 年 MCP 协议的最新进展有哪些' },
    _meta: { progressToken: 'research-1' },
  });
  child.stdout.removeListener('data', counter);
  const rText = res.result?.content?.[0]?.text ?? '';
  check('run_research 出报告', !res.result?.isError && rText.length > 300, `${Math.round((Date.now() - t0) / 1000)}s,${trunc(rText, 160)}`);
  check('run_research 推送了进度通知', progressCount > 0, `${progressCount} 条 progress`);
}

child.stdin.end();
setTimeout(() => child.kill(), 500);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
