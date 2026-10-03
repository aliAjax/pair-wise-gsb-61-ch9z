import type { BatchDocument, WriteFailureMode } from '~/types/certification';
import { createInitialDocument } from './review-batch';
import { seedProjects } from '~/data/seed';

/**
 * 批次持久化：整份批次文档写入。
 * 先写 WAL（完整批次快照）再写主文档，模拟写入中断后可按完整批次恢复。
 */

const MAIN_KEY = 'vehicle-type-approval-batches-v2';
const WAL_KEY = 'vehicle-type-approval-batches-v2-wal';
const LEGACY_KEY = 'vehicle-type-approval-projects-v1';
const FAILURE_MODE_KEY = 'vehicle-type-approval-write-mode';

function isValidDocument(doc: unknown): doc is BatchDocument {
  if (!doc || typeof doc !== 'object') return false;
  const candidate = doc as BatchDocument;
  if (candidate.version !== 2 || !Array.isArray(candidate.batches)) return false;
  const active = candidate.batches.filter((batch) => batch.meta.status === 'active');
  return active.length === 1 && active[0]!.meta.id === candidate.activeBatchId;
}

function readJson(key: string): unknown | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return parseJson(localStorage.getItem(key));
}

function parseJson(raw: string | null): unknown | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export interface DocumentRead {
  document: BatchDocument;
  source: 'wal' | 'main' | 'legacy' | 'seed' | 'corrupt';
}

/** 只读当前应生效的完整批次文档（不发生写入） */
export function readDocument(): DocumentRead {
  if (typeof localStorage === 'undefined') {
    return { document: createInitialDocument(seedProjects), source: 'seed' };
  }

  const wal = parseJson(localStorage.getItem(WAL_KEY));
  if (isValidDocument(wal)) {
    return { document: wal, source: 'wal' };
  }

  const mainRaw = localStorage.getItem(MAIN_KEY);
  const walRaw = localStorage.getItem(WAL_KEY);
  const main = parseJson(mainRaw);
  if (isValidDocument(main)) {
    return { document: main, source: 'main' };
  }

  const legacy = parseJson(localStorage.getItem(LEGACY_KEY));
  if (Array.isArray(legacy) && legacy.length) {
    return { document: createInitialDocument(legacy as Parameters<typeof createInitialDocument>[0]), source: 'legacy' };
  }

  if (mainRaw !== null || walRaw !== null) {
    return { document: createInitialDocument(seedProjects), source: 'corrupt' };
  }

  return { document: createInitialDocument(seedProjects), source: 'seed' };
}

export function readFailureMode(): WriteFailureMode {
  const value = readJson(FAILURE_MODE_KEY) as WriteFailureMode | undefined;
  return value === 'fail_once' || value === 'fail_always' ? value : 'none';
}

export function writeFailureMode(mode: WriteFailureMode): void {
  if (typeof localStorage === 'undefined') return;
  if (mode === 'none') localStorage.removeItem(FAILURE_MODE_KEY);
  else localStorage.setItem(FAILURE_MODE_KEY, mode);
}

export class BatchWriteError extends Error {
  recoverable: boolean;
  constructor(message: string, recoverable = true) {
    super(message);
    this.name = 'BatchWriteError';
    this.recoverable = recoverable;
  }
}

/**
 * 原子风格的整批次写入。
 * 失败时内存态绝不前进；WAL 中保留完整批次，调用方按同一文档重试即可。
 */
export function writeDocument(doc: BatchDocument, failureMode: WriteFailureMode = readFailureMode()): void {
  if (typeof localStorage === 'undefined') return;
  if (!isValidDocument(doc)) throw new BatchWriteError('拒绝写入：批次文档不满足唯一有效批次约束', false);

  const json = JSON.stringify(doc);

  // 1) 先落完整批次到恢复区
  localStorage.setItem(WAL_KEY, json);

  // 2) 模拟写入失败（主文档未更新，WAL 完好）
  if (failureMode === 'fail_always') {
    throw new BatchWriteError('模拟写入失败（fail_always）：完整批次保留在恢复区，排除故障后重试');
  }
  if (failureMode === 'fail_once') {
    writeFailureMode('none');
    throw new BatchWriteError('模拟写入中断（fail_once）：主文档尚未更新，已按完整批次暂存，请重试');
  }

  // 3) 正式提交并清理恢复区
  localStorage.setItem(MAIN_KEY, json);
  localStorage.removeItem(WAL_KEY);
}

export function discardWal(): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(WAL_KEY);
}
