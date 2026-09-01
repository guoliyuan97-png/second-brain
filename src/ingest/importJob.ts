/**
 * 导入任务运行器:把"导入"做成后台任务(与深度研究同款 job 模式)。
 *
 * 为什么不是一次性 POST:导入一篇要过 LLM 打标+关系对比(秒级到十秒级),
 * 一个目录几十篇就是分钟级 —— 同步请求必超时,前端需要进度可看、可轮询。
 *
 * 三种入口:
 * - paths:文件/目录的绝对路径列表(Electron 拖拽/选择,目录在此展开)
 * - url:单个网页
 * - 浏览器拖拽没有路径,由 server 的 upload 端点先暂存成临时文件再走 paths
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ingestFile, ingestText, ingestUrl } from './pipeline.js';
import { SUPPORTED_EXT } from '../parse/index.js';
import { getRegionBySlug } from '../tagging/taxonomy.js';
import { requestBackfill } from '../embedding/embedding.js';

export interface ImportItemResult {
  name: string;
  status: 'ok' | 'duplicate' | 'failed';
  docId?: number;
  title?: string;
  chunks?: number;
  tags?: string[];
  pendingTags?: string[];
  relations?: { candidates: number; related: number; conflicts: number };
  error?: string;
}

export interface ImportJobState {
  id: number;
  status: 'running' | 'done' | 'error';
  stage: string;
  items: ImportItemResult[];
  total: number;
  done: number;
  error?: string;
}

const jobs = new Map<number, ImportJobState>();
let nextJobId = 1;

export function importJobView(j: ImportJobState) {
  return { id: j.id, status: j.status, stage: j.stage, items: j.items, total: j.total, done: j.done, error: j.error };
}

export function getImportJob(id: number): ImportJobState | undefined {
  return jobs.get(id);
}

/** 目录递归收集支持格式的文件;文件路径直接给(格式校验放在结果里,让用户看到失败原因) */
export function expandTargets(paths: string[]): { files: string[]; preErrors: ImportItemResult[] } {
  const files: string[] = [];
  const seen = new Set<string>();
  const preErrors: ImportItemResult[] = [];
  const walk = (p: string): void => {
    if (!existsSync(p)) {
      preErrors.push({ name: p, status: 'failed', error: '路径不存在' });
      return;
    }
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
      return;
    }
    const ext = extname(p).toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      preErrors.push({ name: p, status: 'failed', error: `不支持的格式(可用 ${SUPPORTED_EXT.join(' / ')})` });
      return;
    }
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      files.push(p);
    }
  };
  for (const p of paths) walk(p);
  return { files, preErrors };
}

export interface ImportRequest {
  mode: 'paths' | 'url' | 'note';
  paths?: string[];
  url?: string;
  /** note 模式:随手记正文,标题取首行(截 30 字) */
  content?: string;
  regionSlug: string;
  tag: boolean;
  relations: boolean;
}

export function startImportJob(req: ImportRequest): number {
  const region = getRegionBySlug(req.regionSlug);
  if (!region) throw new Error(`区域「${req.regionSlug}」不存在`);

  // 预展开:确定总数(校验失败的也计入,让用户看到每一项的下落)
  let targets: { kind: 'file' | 'url' | 'note'; ref: string; content?: string }[] = [];
  const pre: ImportItemResult[] = [];
  if (req.mode === 'url') {
    if (!req.url || !/^https?:\/\//i.test(req.url)) throw new Error('请提供 http(s) 网页地址');
    targets = [{ kind: 'url', ref: req.url }];
  } else if (req.mode === 'note') {
    const content = (req.content ?? '').trim();
    if (!content) throw new Error('随手记内容不能为空');
    const firstLine = content.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 30) || '';
    const title = `随手记:${firstLine || new Date().toLocaleDateString('zh-CN')}`;
    targets = [{ kind: 'note', ref: title, content }];
  } else {
    const { files, preErrors } = expandTargets(req.paths ?? []);
    targets = files.map((f) => ({ kind: 'file' as const, ref: f }));
    pre.push(...preErrors);
  }

  const job: ImportJobState = {
    id: nextJobId++,
    status: 'running',
    stage: '准备导入…',
    items: pre,
    total: targets.length,
    done: 0,
  };
  jobs.set(job.id, job);
  const ids = [...jobs.keys()];
  if (ids.length > 20) for (const id of ids.slice(0, ids.length - 20)) jobs.delete(id);

  void (async () => {
    try {
      for (const t of targets) {
        const label = t.kind === 'url' ? t.ref : t.ref.split(/[\\/]/).pop() || t.ref;
        job.stage = `[${job.done + 1}/${job.total}] ${label}`;
        try {
          const r =
            t.kind === 'url'
              ? await ingestUrl(t.ref, { regionSlug: req.regionSlug, tag: req.tag, relations: req.relations })
              : t.kind === 'note'
                ? await ingestText(t.ref, t.content ?? '', { regionSlug: req.regionSlug, tag: req.tag, relations: req.relations })
                : await ingestFile(t.ref, { regionSlug: req.regionSlug, tag: req.tag, relations: req.relations });
          if (r.skipped === 'duplicate') {
            job.items.push({ name: label, status: 'duplicate', docId: r.duplicateOf, title: r.title });
          } else {
            job.items.push({
              name: label,
              status: 'ok',
              docId: r.docId,
              title: r.title,
              chunks: r.chunks,
              tags: r.tagging?.tags,
              pendingTags: r.tagging?.pendingTags,
              relations: r.relations
                ? { candidates: r.relations.candidates, related: r.relations.related, conflicts: r.relations.conflicts }
                : undefined,
            });
          }
        } catch (e) {
          job.items.push({ name: label, status: 'failed', error: e instanceof Error ? e.message : String(e) });
        }
        job.done++;
      }
      job.status = 'done';
      job.stage = `完成:共 ${job.total} 项`;
      requestBackfill(); // 新 chunk 的向量后台补全(EmbeddingProvider off 时为空操作)
    } catch (e) {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
    }
  })();
  return job.id;
}