/**
 * W1 的 CLI:先用命令行把整条导入管线跑通、验稳(W4 再做整理台 UI)。
 *
 * 检索的中文坑(教学重点):FTS5 trigram 分词要求查询词 ≥3 字符,
 * 所以 2 字中文词(如"分层")退化为 LIKE 子串匹配 ——
 * 本机单用户、万级 chunk 以内,LIKE 全表扫完全够用,不过度设计。
 * 检索器是可替换接口,将来上向量检索只动 search 这一层。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { db, now } from './db/index.js';
import { resetAll } from './db/reset.js';
import { ensureRegions, getRegionBySlug, listTags, addApprovedTag } from './tagging/taxonomy.js';
import { ingestFile, ingestUrl, type IngestResult } from './ingest/pipeline.js';
import { SUPPORTED_EXT } from './parse/index.js';
import { ftsRetriever } from './search/retriever.js';
import { answerQuestion } from './qa/answer.js';
import { saveQaToLibrary } from './qa/save.js';
import { runResearch, type ResearchResult } from './research/pipeline.js';
import { saveResearchToLibrary, deferResearchToInbox } from './research/save.js';
import { runEval } from './eval/run.js';

// ── 小工具 ─────────────────────────────────────────────────────────

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | boolean> } {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printIngest(label: string, r: IngestResult): void {
  if (r.skipped === 'duplicate') {
    console.log(`⊘ ${label}《${r.title}》与文档 #${r.duplicateOf} 内容重复,已跳过`);
    return;
  }
  const tags = r.tagging?.ok ? (r.tagging.tags ?? []).join('、') : r.tagging ? '⚠ 打标失败(已进待办)' : '(未打标)';
  const pending = r.tagging?.pendingTags?.length ? `  新标签待审:${r.tagging.pendingTags.join('、')}` : '';
  const rel = r.relations
    ? `  关系:候选 ${r.relations.candidates},相关 ${r.relations.related},冲突 ${r.relations.conflicts}`
    : '';
  console.log(`✔ ${label}《${r.title}》(id=${r.docId},${r.chunks} chunks)  标签:${tags}${pending}${rel}`);
  if (r.crossRegionWarning) console.log(`  ${r.crossRegionWarning}`);
  if (r.relations?.error) console.log(`  ⚠ 关系判定失败(已跳过,不影响入库):${r.relations.error}`);
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else if (SUPPORTED_EXT.includes(extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

// ── 命令实现 ───────────────────────────────────────────────────────

async function cmdImport(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const target = positional[0];
  if (!target) throw new Error('用法:import <文件|目录|URL> [--region learning|work] [--no-tag] [--no-relations]');
  const opts = {
    regionSlug: String(flags.get('region') ?? 'learning'),
    tag: flags.get('no-tag') !== true,
    relations: flags.get('no-relations') !== true,
  };

  if (/^https?:\/\//i.test(target)) {
    console.log(`抓取网页:${target}`);
    printIngest('网页', await ingestUrl(target, opts));
    return;
  }
  if (!existsSync(target)) throw new Error(`路径不存在:${target}`);

  const files = statSync(target).isDirectory() ? collectFiles(target) : [target];
  if (files.length === 0) throw new Error(`目录中没有可导入的文件(支持 ${SUPPORTED_EXT.join(' / ')})`);
  console.log(`共 ${files.length} 个文件,区域:${opts.regionSlug}`);
  let ok = 0;
  for (const f of files) {
    try {
      printIngest('文件', await ingestFile(f, opts));
      ok++;
    } catch (e) {
      console.log(`✘ ${f}:${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`完成:${ok}/${files.length}`);
}

async function cmdSearch(args: string[]): Promise<void> {
  const words = args.filter((w) => !w.startsWith('--'));
  if (words.length === 0) throw new Error('用法:search <关键词...>(多词任一命中即返回,靠评分排序)');
  const hits = ftsRetriever.retrieve(words.join(' '), { limit: 15 });
  if (hits.length === 0) {
    console.log('没有命中。');
    return;
  }
  for (const [i, h] of hits.entries()) {
    const loc = h.headingPath ? `「${h.headingPath}」` : '';
    console.log(`${i + 1}. [${h.via}] 《${h.title}》${loc}(doc=${h.docId}, chunk=${h.chunkId})`);
    console.log(`   ${h.content.replace(/\s+/g, ' ').slice(0, 80)}…`);
  }
}

/**
 * 归纳问答(零 token 检索 + 一次 LLM 归纳)。
 *
 * 产品拍板(W5 后):问答不询问入库 —— 回答本身源于库内检索,
 * 只有深度研究(外部新知识)才询问沉淀。--save 保留为显式 opt-in。
 */
async function cmdAsk(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const question = positional.join(' ').trim();
  if (!question) throw new Error('用法:ask "<问题>" [--region learning|work] [--save]');
  const regionSlug = String(flags.get('region') ?? 'learning');

  console.log('检索中…');
  const qa = await answerQuestion(question, { regionSlug });

  if (qa.citations.length > 0) {
    console.log('\n引用:');
    for (const c of qa.citations) {
      console.log(`  [${c.n}] 《${c.title}》「${c.headingPath || '正文'}」(doc=${c.docId})`);
    }
  }
  if (qa.conflictNotes.length > 0) {
    for (const n of qa.conflictNotes) console.log(`⚠ 未裁决冲突:${n}`);
  }
  if (qa.reflection) {
    if (qa.reflection.revised) {
      console.log(
        `🔍 引用自检:发现 ${qa.reflection.issues.length} 处不自洽,已修正(${qa.reflection.issues
          .map((i) => `[${i.n}] ${i.reason}`)
          .join(';')})`,
      );
    } else {
      console.log(`🔍 引用自检通过(${qa.reflection.checked} 条引用)`);
    }
  }
  console.log(`\n${qa.answer}\n`);
  if (flags.get('save') === true) {
    const r = await saveQaToLibrary(qa, regionSlug);
    console.log(`已入库:文档 #${r.docId}《${r.title}》(${r.chunks} chunks)`);
  }
}

/**
 * 深度研究(A 腿):联网搜索 → 抓取 → 带引用报告 → 确认沉淀。
 * 沉淀选项比问答多一档:报告可以只带引用来源清单,也可以把来源
 * 一起入库(各拿标签/摘要,并与库内知识建关系边)。
 */
async function promptSaveResearch(result: ResearchResult, regionSlug: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log('(非交互环境,跳过入库确认;要入库请加 --save)');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (
      await rl.question('研究结果要沉淀入库吗?[y=报告+来源 / r=仅报告 / i=稍后(收件箱) / n=丢弃] ')
    ).trim().toLowerCase();
    if (ans === 'y' || ans === 'r') {
      const out = await saveResearchToLibrary(result, { regionSlug, withSources: ans === 'y' });
      console.log(`报告已入库:文档 #${out.report.docId}《${out.report.title}》(${out.report.chunks} chunks)`);
      for (const s of out.sources) {
        if (s.result) console.log(`  来源 [${s.n}] → 文档 #${s.result.docId}${s.result.skipped ? '(库内已有,跳过)' : ''}`);
        else console.log(`  来源 [${s.n}] 入库失败:${s.error}`);
      }
    } else if (ans === 'i') {
      console.log(`已存入收件箱(待办 #${deferResearchToInbox(result)}),W4 整理台统一处理。`);
    } else {
      console.log('已丢弃。');
    }
  } finally {
    rl.close();
  }
}

async function cmdResearch(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const question = positional.join(' ').trim();
  if (!question) throw new Error('用法:research "<研究问题>" [--region learning|work] [--save] [--no-sources]');
  const regionSlug = String(flags.get('region') ?? 'learning');

  const result = await runResearch(question, { onStage: (s) => console.log(`… ${s}`) });

  console.log(`\n${'='.repeat(50)}\n${result.report}\n${'='.repeat(50)}`);
  console.log(`\n来源(${result.sources.length} 个可用,${result.failed.length} 个失败):`);
  for (const s of result.sources) console.log(`  [${s.n}] 《${s.title.slice(0, 40)}》 ${s.finalUrl.slice(0, 70)}`);
  for (const f of result.failed.slice(0, 5)) console.log(`  ✘ [${f.stage}] ${f.url.slice(0, 60)} — ${f.error.slice(0, 50)}`);
  const sec = Math.round(result.stats.durationMs / 1000);
  console.log(`\n耗时 ${sec}s | 检索词 ${result.stats.queries.length} 组 | 搜索结果 ${result.stats.searchHits} 条 | 抓取 ${result.stats.fetched} 页`);

  if (flags.get('save') === true) {
    const withSources = flags.get('no-sources') !== true;
    const out = await saveResearchToLibrary(result, { regionSlug, withSources });
    console.log(`\n报告已入库:文档 #${out.report.docId}《${out.report.title}》(${out.report.chunks} chunks)`);
    for (const s of out.sources) {
      if (s.result) console.log(`  来源 [${s.n}] → 文档 #${s.result.docId}${s.result.skipped ? '(库内已有,跳过)' : ''}`);
      else console.log(`  来源 [${s.n}] 入库失败:${s.error}`);
    }
  } else {
    await promptSaveResearch(result, regionSlug);
  }
}

function cmdDoc(args: string[]): void {
  const id = Number(args[0]);
  const doc = db
    .prepare(
      `SELECT d.*, r.name AS region_name FROM documents d JOIN regions r ON r.id = d.region_id WHERE d.id = ?`,
    )
    .get(id) as
    | { id: number; title: string; source_type: string; source_ref: string; snapshot_path: string; char_count: number; created_at: string; region_name: string }
    | undefined;
  if (!doc) throw new Error(`文档 ${id} 不存在`);
  console.log(`#${doc.id} 《${doc.title}》  区域:${doc.region_name}  来源:${doc.source_type}`);
  console.log(`  source: ${doc.source_ref}`);
  console.log(`  snapshot: ${doc.snapshot_path}  (${doc.char_count} 字, 入库 ${doc.created_at})`);

  const tags = db
    .prepare(
      `SELECT t.name, t.status FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = ?`,
    )
    .all(id) as unknown as { name: string; status: string }[];
  console.log(`  标签:${tags.map((t) => `${t.name}${t.status === 'pending' ? '(待审)' : ''}`).join('、') || '(无)'}`);

  const s = db.prepare('SELECT key_points, prerequisites, version_notes FROM summaries WHERE document_id = ?').get(id) as
    | { key_points: string; prerequisites: string | null; version_notes: string | null }
    | undefined;
  if (s) {
    for (const p of JSON.parse(s.key_points) as string[]) console.log(`  · ${p}`);
    if (s.version_notes) console.log(`  时效:${s.version_notes}`);
  }

  const n = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(id) as unknown as { n: number };
  console.log(`  chunks:${n.n}`);

  const rels = db
    .prepare(
      `SELECT re.type, re.status, re.note, d.title AS other_title
       FROM relations re JOIN documents d ON d.id = CASE WHEN re.doc_a = ? THEN re.doc_b ELSE re.doc_a END
       WHERE re.doc_a = ? OR re.doc_b = ?`,
    )
    .all(id, id, id) as unknown as { type: string; status: string; note: string; other_title: string }[];
  for (const r of rels) {
    const typeZh = { similar: '相似', conflict: '冲突', supplement: '补充' }[r.type] ?? r.type;
    console.log(`  ↔ ${typeZh}《${r.other_title}》[${r.status}] ${r.note}`);
  }
}

function cmdStats(): void {
  for (const r of db.prepare('SELECT id, slug, name FROM regions ORDER BY id').all() as unknown as { id: number; slug: string; name: string }[]) {
    const docs = (db.prepare('SELECT COUNT(*) n FROM documents WHERE region_id = ?').get(r.id) as unknown as { n: number }).n;
    const chunks = (
      db.prepare('SELECT COUNT(*) n FROM chunks ch JOIN documents d ON d.id = ch.document_id WHERE d.region_id = ?').get(r.id) as unknown as { n: number }
    ).n;
    const approved = (db.prepare("SELECT COUNT(*) n FROM tags WHERE region_id = ? AND status='approved'").get(r.id) as unknown as { n: number }).n;
    const pending = (db.prepare("SELECT COUNT(*) n FROM tags WHERE region_id = ? AND status='pending'").get(r.id) as unknown as { n: number }).n;
    console.log(`[${r.slug}] ${r.name}:文档 ${docs},chunks ${chunks},词表 ${approved}(待审 ${pending})`);
  }
  const inbox = db.prepare("SELECT type, COUNT(*) n FROM inbox WHERE status='open' GROUP BY type").all() as unknown as {
    type: string;
    n: number;
  }[];
  console.log(`待办:${inbox.map((i) => `${i.type}×${i.n}`).join(', ') || '无'}`);
}

function cmdTaxo(args: string[]): void {
  const [sub, slug, ...names] = args;
  const region = getRegionBySlug(slug ?? 'learning');
  if (!region) throw new Error(`区域不存在:${slug}`);
  switch (sub) {
    case 'list': {
      for (const t of listTags(region.id)) {
        console.log(`  ${t.status === 'approved' ? '✔' : '…'} ${t.name}(id=${t.id})`);
      }
      return;
    }
    case 'add': {
      if (names.length === 0) throw new Error('用法:taxo add <region> <标签...>');
      for (const n of names) addApprovedTag(region.id, n);
      console.log(`已添加:${names.join('、')}`);
      return;
    }
    case 'approve': {
      if (!names[0]) throw new Error('用法:taxo approve <region> <标签>');
      const t = db.prepare('SELECT id, status FROM tags WHERE region_id = ? AND name = ?').get(region.id, names[0]) as
        | { id: number; status: string }
        | undefined;
      if (!t) throw new Error(`标签不存在:${names[0]}`);
      if (t.status !== 'pending') throw new Error('该标签不在待审状态');
      db.prepare("UPDATE tags SET status='approved' WHERE id = ?").run(t.id);
      console.log(`已批准:${names[0]}`);
      return;
    }
    default:
      throw new Error('用法:taxo list|add|approve <region> [标签...]');
  }
}

function cmdInbox(args: string[]): void {
  const [sub, idStr] = args;
  if (sub === 'drop' && idStr) {
    db.prepare("UPDATE inbox SET status='resolved', resolved_at=? WHERE id = ? AND status='open'").run(now(), Number(idStr));
    console.log(`已忽略待办 #${idStr}`);
    return;
  }
  const rows = db
    .prepare("SELECT id, type, payload, created_at FROM inbox WHERE status='open' ORDER BY id")
    .all() as unknown as { id: number; type: string; payload: string; created_at: string }[];
  if (rows.length === 0) {
    console.log('收件箱是空的。');
    return;
  }
  for (const r of rows) {
    const p = JSON.parse(r.payload) as Record<string, unknown>;
    const desc =
      r.type === 'tag_review'
        ? `新标签「${p.tagName}」(来自《${p.documentTitle}》)`
        : r.type === 'conflict_review'
          ? `冲突:与《${p.oldTitle}》—— ${p.note}`
          : r.type === 'save_review'
            ? `待入库问答:「${p.question}」`
            : `打标失败:《${p.title}》${p.error}`;
    console.log(`#${r.id} [${r.type}] ${desc}  (${r.created_at})`);
  }
}

/** 危险操作:必须显式 --yes。数据无价,不留"顺手清空"的口子。 */
function cmdReset(flags: Map<string, string | boolean>): void {
  if (flags.get('yes') !== true) throw new Error('reset 会清空整库。确认请加 --yes');
  resetAll();
  console.log('已清空并重建(快照目录已删除)。');
}

// ── 入口 ───────────────────────────────────────────────────────────

const HELP = `second-brain CLI(W5)
  import <文件|目录|URL> [--region learning|work] [--no-tag] [--no-relations]   导入
  search <关键词...>                      找文档(零 token,≥3字走 FTS,2字退化 LIKE)
  ask "<问题>" [--region ...] [--save]    归纳问答(带编号引用;不询问入库,--save 可显式入库)
  research "<问题>" [--save] [--no-sources]  深度研究:联网→带引用报告→确认沉淀
  eval [评估集路径]                       评估集跑分(引用命中/要点覆盖/可用率)
  doc <id>                                文档详情(标签/摘要/关系)
  stats                                   各区域统计 + 待办数
  taxo list|add|approve <region> [...]    词表管理
  inbox [drop <id>]                       查看待办 / 忽略
  reset --yes                             清空整库(危险)
  web / desktop                           本机 Web / Electron 桌面壳
`;

async function main(): Promise<void> {
  ensureRegions();
  const [cmd, ...args] = process.argv.slice(2);
  const flags = parseFlags(args).flags;
  switch (cmd) {
    case 'import':
      return cmdImport(args);
    case 'search':
      return cmdSearch(args);
    case 'ask':
      return cmdAsk(args);
    case 'research':
      return cmdResearch(args);
    case 'eval':
      return runEval(args[0]);
    case 'doc':
      return cmdDoc(args);
    case 'stats':
      return cmdStats();
    case 'taxo':
      return cmdTaxo(args);
    case 'inbox':
      return cmdInbox(args);
    case 'reset':
      return cmdReset(flags);
    default:
      console.log(HELP);
  }
}

main().catch((e: unknown) => {
  console.error(`错误:${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
