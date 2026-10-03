import type {
  ApprovalProject,
  AuditEntry,
  BatchData,
  BatchDocument,
  BatchMetadata,
  DualRevisionChoice,
  EvidenceItem,
  EvidenceStatus,
  MergeConflict,
  MergeReport,
  OfflinePackage,
  RegulationItem,
  RevisionOrigin
} from '~/types/certification';

/**
 * 复核批次引擎（纯函数）
 *
 * 不变量：
 * 1. 任一时刻只有一份 active 批次，列表/详情/提交包都从它读取；
 * 2. 离线包回网按「基线 + 证据版本」三方合并（基线快照 / 在线 / 离线）；
 * 3. 同一证据两边都改 → 保留双版本，挂起待复核；
 * 4. 软件基线一变，旧版本证据立即失效重算，法规覆盖与补件队列联动；
 * 5. 冻结（已批准）项目对离线改动只读。
 */

const SCALAR_KEYS = [
  'name',
  'modelCode',
  'vehicleType',
  'configuration',
  'maintenanceVersion',
  'softwareVersion',
  'status',
  'progress',
  'applicant',
  'reviewer',
  'agency',
  'submittedAt',
  'certificateExpiry'
] as const;
type ScalarKey = (typeof SCALAR_KEYS)[number];

const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  missing: '缺失',
  submitted: '已提交',
  accepted: '已接受',
  rejected: '被拒',
  resubmit: '需重交'
};

/** 深拷贝纯数据（批次文档全部是可 JSON 序列化结构；避免 structuredClone 对响应式代理报错） */
export function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isFrozenProject(project: ApprovalProject) {
  return project.status === 'approved';
}

/** 参与列表、详情、覆盖计算和提交包的「有效」证据行（隐藏被裁定弃用的版本） */
export function liveEvidence(project: ApprovalProject): EvidenceItem[] {
  return project.evidence.filter((item) => !item.superseded);
}

export function pendingEvidenceRows(project: ApprovalProject): EvidenceItem[] {
  return liveEvidence(project).filter((item) => item.pendingReview || item.invalidated);
}

export function makeId(prefix: string): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${String(rand).split('-')[0]!.slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeAudit(
  actor: string,
  action: string,
  detail: string,
  origin: RevisionOrigin = 'online',
  batchId?: string,
  createdAt: string = nowIso()
): AuditEntry {
  return { id: makeId('AUD'), actor, action, detail, createdAt, origin, batchId };
}

/** cyrb53 指纹，用于基线令牌与漂移识别 */
function hash53(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function evidenceSignature(item: EvidenceItem): string {
  return stableStringify({
    s: item.status,
    v: item.version,
    sw: item.softwareVersion,
    cfg: [...item.configurations].sort(),
    note: item.note,
    name: item.name,
    reg: item.regulationId,
    type: item.type,
    exp: item.expiryDate ?? null
  });
}

/** 项目内容签名（审计轨迹不参与：追加审计不构成内容漂移） */
export function projectSignature(project: ApprovalProject): string {
  return stableStringify({
    scalar: Object.fromEntries(SCALAR_KEYS.map((key) => [key, project[key] ?? null])),
    evidence: project.evidence
      .map((item) => ({ id: item.id, sig: evidenceSignature(item) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    versions: project.versions.map((item) => item.id).sort(),
    regulations: project.regulations.map((item) => `${item.id}:${item.status}:${item.coverage}`).sort()
  });
}

export function baselineToken(projects: ApprovalProject[]): string {
  return hash53(projects.map((project) => `${project.id}|${projectSignature(project)}`).join('||'));
}

/* ------------------------------------------------------------------ */
/* 软件基线联动                                                        */
/* ------------------------------------------------------------------ */

export function applySoftwareBaselineInvalidation(
  project: ApprovalProject,
  previousVersion: string,
  actor: string,
  origin: RevisionOrigin = 'online',
  at: string = nowIso()
): string[] {
  if (previousVersion === project.softwareVersion) return [];
  const impacted = new Set<string>([project.configuration]);
  let count = 0;
  for (const item of liveEvidence(project)) {
    if (item.softwareVersion === project.softwareVersion) continue;
    // 幂等：已经被上一轮基线变更标记失效的证据不重复追加批注
    if (item.invalidated) {
      item.configurations.forEach((config) => impacted.add(config));
      continue;
    }
    item.invalidated = true;
    if (item.status === 'accepted') item.status = 'resubmit';
    item.note = `${item.note}【${at.slice(0, 16).replace('T', ' ')} 软件基线 ${previousVersion}→${project.softwareVersion}，本证据版本失效，需重新测试/补件】`.trim();
    item.configurations.forEach((config) => impacted.add(config));
    count += 1;
  }
  if (count) {
    project.audit.unshift(
      makeAudit(
        actor,
        '软件基线失效重算',
        `软件基线 ${previousVersion}→${project.softwareVersion}，${count} 项旧版本证据失效，受影响配置：${[...impacted].join('、')}，法规覆盖与补件队列已联动更新。`,
        origin,
        undefined,
        at
      )
    );
  }
  return [...impacted];
}

/* ------------------------------------------------------------------ */
/* 法规覆盖重算                                                        */
/* ------------------------------------------------------------------ */

export function recomputeRegulations(project: ApprovalProject): void {
  project.regulations = project.regulations.map((regulation): RegulationItem => {
    const rows = liveEvidence(project).filter((item) => item.regulationId === regulation.id);
    if (!rows.length) {
      return { ...regulation, status: 'missing', coverage: 0, issues: ['尚未关联证据文件'] };
    }

    const issues: string[] = [];
    const invalid = rows.filter((item) => item.invalidated || item.softwareVersion !== project.softwareVersion);
    const pending = rows.filter((item) => item.pendingReview);
    const blocked = rows.filter(
      (item) => !item.invalidated && ['missing', 'rejected', 'resubmit'].includes(item.status)
    );
    const accepted = rows.filter((item) => item.status === 'accepted' && !item.invalidated);
    const configCovered = accepted.some((item) => item.configurations.includes(project.configuration));

    invalid.forEach((item) =>
      issues.push(
        `证据《${item.name}》软件版本 ${item.softwareVersion} 落后基线 ${project.softwareVersion}，已失效待重算`
      )
    );
    pending.forEach((item) => issues.push(`证据《${item.name}》存在离线改动或双版本，待人工复核裁定`));
    blocked.forEach((item) => issues.push(`证据《${item.name}》状态为${EVIDENCE_STATUS_LABELS[item.status]}，待补件`));

    const status: RegulationItem['status'] = invalid.length
      ? 'conflict'
      : blocked.length || pending.length
        ? 'missing'
        : 'complete';

    let coverage: number;
    if (status === 'complete') coverage = 100;
    else {
      const ratio = accepted.length / rows.length;
      coverage = configCovered ? Math.max(55, Math.round(ratio * 100)) : Math.round(ratio * 80);
      if (!accepted.length) coverage = invalid.length ? 25 : 10;
    }

    return { ...regulation, status, coverage, issues };
  });
}

export function recomputeProgress(project: ApprovalProject): number {
  if (project.status === 'approved') {
    project.progress = 100;
    return 100;
  }
  if (!project.regulations.length) return project.progress;
  project.progress = Math.round(
    project.regulations.reduce((sum, item) => sum + item.coverage, 0) / project.regulations.length
  );
  return project.progress;
}

/* ------------------------------------------------------------------ */
/* 离线包                                                              */
/* ------------------------------------------------------------------ */

export function buildOfflinePackage(batch: BatchData, exporter: string, at = nowIso()): OfflinePackage {
  return {
    kind: 'vehicle-type-approval-offline-review',
    packageVersion: 1,
    batchId: batch.meta.id,
    exportedAt: at,
    exporter,
    baselineToken: batch.meta.baselineToken,
    projects: cloneData(batch.projects),
    baseline: cloneData(batch.projects)
  };
}

/* ------------------------------------------------------------------ */
/* 三方合并                                                            */
/* ------------------------------------------------------------------ */

interface MergeCounters {
  onlineOnlyChanges: number;
  offlineOnlyChanges: number;
  dualRevisionEvidence: number;
  offlineEvidenceAdded: number;
  frozenSkipped: number;
  invalidatedEvidence: number;
}

function summarizeEvidence(item: EvidenceItem): string {
  return `文件 ${item.version} / 软件 ${item.softwareVersion} / 状态 ${EVIDENCE_STATUS_LABELS[item.status]} / ${item.configurations.join('、')}；批注：${item.note}（${item.updatedAt.slice(0, 16).replace('T', ' ')}）`;
}

function mergeProject(
  online: ApprovalProject,
  offline: ApprovalProject | undefined,
  base: ApprovalProject | undefined,
  newBatchId: string,
  counters: MergeCounters,
  conflicts: MergeConflict[],
  at: string
): ApprovalProject {
  // 离线包未覆盖的在线项目原样保留
  if (!offline || !base) return cloneData(online);

  const merged = cloneData(online);
  const frozen = isFrozenProject(online);
  const offlineChanged = projectSignature(offline) !== projectSignature(base);

  // 冻结项目：离线任何改动一律拒绝，在线值只读保留
  if (frozen) {
    if (offlineChanged) {
      counters.frozenSkipped += 1;
      conflicts.push({
        id: makeId('CFL'),
        kind: 'frozen_project_readonly',
        projectId: online.id,
        projectName: online.name,
        onlineSummary: `冻结基线 ${online.maintenanceVersion} / SW ${online.softwareVersion}，状态 ${online.status}`,
        offlineSummary: '离线复核包试图修改已批准（冻结）项目，已按只读规则拒绝',
        status: 'pending',
        createdAt: at
      });
      merged.audit.unshift(
        makeAudit('系统', '冻结项目离线改动拦截', '离线包包含对已批准项目的修改，按只读规则丢弃，以在线冻结版本为准。', 'system', newBatchId, at)
      );
    }
    return merged;
  }

  /* ---- 标量字段三方合并 ---- */
  const bothChangedFields: string[] = [];
  const fieldLabels: Record<string, string> = {
    status: '审批状态',
    softwareVersion: '软件版本',
    maintenanceVersion: '维护版本',
    configuration: '配置',
    certificateExpiry: '证书有效期',
    reviewer: '审阅人'
  };
  for (const key of SCALAR_KEYS) {
    const baseValue = base[key];
    const onlineValue = online[key];
    const offlineValue = offline[key];
    const onlineChanged = JSON.stringify(onlineValue ?? null) !== JSON.stringify(baseValue ?? null);
    const offlineChangedField = JSON.stringify(offlineValue ?? null) !== JSON.stringify(baseValue ?? null);

    if (!onlineChanged && !offlineChangedField) continue;
    if (onlineChanged && !offlineChangedField) {
      counters.onlineOnlyChanges += 1;
      continue;
    }
    if (!onlineChanged && offlineChangedField) {
      // 审批状态以在线状态机为准，其余字段离线单边改动直接并入
      if (key === 'status') {
        bothChangedFields.push(fieldLabels[key] ?? key);
        continue;
      }
      (merged as unknown as Record<ScalarKey, unknown>)[key] = offlineValue;
      counters.offlineOnlyChanges += 1;
      continue;
    }
    // 两边都改：在线值受保护，登记冲突待人审
    bothChangedFields.push(fieldLabels[key] ?? key);
    counters.onlineOnlyChanges += 1;
  }

  if (bothChangedFields.length) {
    conflicts.push({
      id: makeId('CFL'),
      kind: 'online_change_protected',
      projectId: online.id,
      projectName: online.name,
      onlineSummary: `在线窗口保留值：状态 ${online.status} / SW ${online.softwareVersion}`,
      offlineSummary: `离线包携带值：状态 ${offline.status} / SW ${offline.softwareVersion}；分歧字段：${bothChangedFields.join('、')}`,
      status: 'pending',
      createdAt: at
    });
  }

  /* ---- 版本记录：离线新增并入 ---- */
  const onlineVersionIds = new Set(merged.versions.map((item) => item.id));
  offline.versions
    .filter((item) => !onlineVersionIds.has(item.id))
    .forEach((item) => {
      merged.versions.unshift(cloneData(item));
      counters.offlineOnlyChanges += 1;
    });

  /* ---- 证据三方合并 ---- */
  const mergedEvidence: EvidenceItem[] = [];
  const baseById = new Map(base.evidence.map((item) => [item.id, item]));
  const onlineById = new Map(online.evidence.map((item) => [item.id, item]));
  const offlineById = new Map(offline.evidence.map((item) => [item.id, item]));

  const pushOfflineNew = (item: EvidenceItem) => {
    mergedEvidence.push({
      ...cloneData(item),
      origin: 'offline',
      pendingReview: true
    });
    counters.offlineEvidenceAdded += 1;
  };

  // 离线新增的证据
  offline.evidence
    .filter((item) => !baseById.has(item.id))
    .forEach(pushOfflineNew);

  // 在线新增的证据（基线里没有）
  online.evidence
    .filter((item) => !baseById.has(item.id))
    .forEach((item) => mergedEvidence.push(cloneData(item)));

  // 双方共有的证据
  for (const baseItem of base.evidence) {
    const onlineItem = onlineById.get(baseItem.id);
    const offlineItem = offlineById.get(baseItem.id);
    if (!onlineItem || !offlineItem) {
      if (onlineItem) mergedEvidence.push(cloneData(onlineItem));
      else if (offlineItem) pushOfflineNew(offlineItem);
      continue;
    }
    const onlineChanged = evidenceSignature(onlineItem) !== evidenceSignature(baseItem);
    const offlineChanged = evidenceSignature(offlineItem) !== evidenceSignature(baseItem);

    if (!onlineChanged && !offlineChanged) {
      mergedEvidence.push(cloneData(onlineItem));
    } else if (onlineChanged && !offlineChanged) {
      mergedEvidence.push(cloneData(onlineItem));
      counters.onlineOnlyChanges += 1;
    } else if (!onlineChanged && offlineChanged) {
      mergedEvidence.push({ ...cloneData(offlineItem), origin: 'offline' });
      counters.offlineOnlyChanges += 1;
    } else {
      // 同一证据两边都改过：保留双版本待复核
      const group = makeId('CFL');
      const logicalId = onlineItem.logicalId || onlineItem.id;
      mergedEvidence.push({
        ...cloneData(onlineItem),
        logicalId,
        revisionOf: logicalId,
        conflictGroup: group,
        pendingReview: true
      });
      mergedEvidence.push({
        ...cloneData(offlineItem),
        id: makeId('EV-OFF'),
        logicalId,
        revisionOf: logicalId,
        conflictGroup: group,
        origin: 'offline',
        pendingReview: true
      });
      counters.dualRevisionEvidence += 1;
      conflicts.push({
        id: makeId('CFL'),
        kind: 'evidence_dual_revision',
        projectId: online.id,
        projectName: online.name,
        evidenceName: onlineItem.name,
        regulationId: onlineItem.regulationId,
        conflictGroup: group,
        onlineSummary: `在线版：${summarizeEvidence(onlineItem)}`,
        offlineSummary: `离线版：${summarizeEvidence(offlineItem)}`,
        status: 'pending',
        createdAt: at
      });
    }
  }
  merged.evidence = mergedEvidence;

  /* ---- 软件基线失效重算（无论基线从哪一侧合并过来） ---- */
  if (base.softwareVersion !== merged.softwareVersion) {
    applySoftwareBaselineInvalidation(merged, base.softwareVersion, merged.applicant, 'system', at);
    counters.invalidatedEvidence += liveEvidence(merged).filter((item) => item.invalidated).length;
    const affectedConfigs = new Set<string>();
    liveEvidence(merged)
      .filter((item) => item.invalidated)
      .forEach((item) => item.configurations.forEach((config) => affectedConfigs.add(config)));
    if (affectedConfigs.size) {
      conflicts.push({
        id: makeId('CFL'),
        kind: 'stale_baseline',
        projectId: online.id,
        projectName: online.name,
        onlineSummary: `当前有效软件基线 SW ${merged.softwareVersion}`,
        offlineSummary: `离线包基于 SW ${offline.softwareVersion} 复核，受影响配置：${[...affectedConfigs].join('、')}；旧版本证据已失效，法规覆盖与补件队列已重算`,
        status: 'pending',
        createdAt: at
      });
    }
  }

  /* ---- 审计并集（按时间倒序），离线记录打标 ---- */
  const auditIds = new Set(merged.audit.map((item) => item.id));
  offline.audit
    .filter((item) => !auditIds.has(item.id))
    .forEach((item) => merged.audit.unshift({ ...cloneData(item), origin: 'offline', batchId: newBatchId }));

  recomputeRegulations(merged);
  recomputeProgress(merged);
  merged.updatedAt = at;
  merged.audit.unshift(
    makeAudit(
      '系统',
      '离线复核批次合并',
      `批次 ${newBatchId} 回网合并完成：离线改动按基线并入，在线改动保留。`,
      'system',
      newBatchId,
      at
    )
  );
  merged.audit.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return merged;
}

export interface MergeOutcome {
  data: BatchData;
  report: MergeReport;
}

export function mergeOfflineBatch(active: BatchData, pkg: OfflinePackage, at = nowIso()): MergeOutcome {
  if (pkg.kind !== 'vehicle-type-approval-offline-review') {
    throw new Error('不是有效的离线复核包');
  }

  const newBatchId = makeId('BATCH');
  const counters: MergeCounters = {
    onlineOnlyChanges: 0,
    offlineOnlyChanges: 0,
    dualRevisionEvidence: 0,
    offlineEvidenceAdded: 0,
    frozenSkipped: 0,
    invalidatedEvidence: 0
  };
  const conflicts: MergeConflict[] = [];

  const onlineMap = new Map(active.projects.map((project) => [project.id, project]));
  const offlineMap = new Map(pkg.projects.map((project) => [project.id, project]));
  const baseMap = new Map(pkg.baseline.map((project) => [project.id, project]));

  // 以在线顺序为主，离线新建项目追加在后
  const mergedProjects = active.projects.map((online) =>
    mergeProject(online, offlineMap.get(online.id), baseMap.get(online.id), newBatchId, counters, conflicts, at)
  );
  pkg.projects
    .filter((project) => !onlineMap.has(project.id))
    .forEach((project) => {
      const cloned = cloneData(project);
      cloned.evidence.forEach((item) => {
        item.origin = 'offline';
        item.pendingReview = true;
      });
      recomputeRegulations(cloned);
      mergedProjects.push(cloned);
      counters.offlineEvidenceAdded += cloned.evidence.length;
    });

  const carriedConflicts = active.conflicts.map((item) => ({ ...item }));
  const allConflicts = [...conflicts, ...carriedConflicts];
  const meta: BatchMetadata = {
    id: newBatchId,
    label: `离线回网合并 ${at.slice(0, 16).replace('T', ' ')}`,
    status: 'active',
    createdAt: at,
    parentBatchId: pkg.batchId,
    baselineToken: baselineToken(mergedProjects),
    actor: pkg.exporter,
    note: `由离线包 ${pkg.batchId} 回网合并生成`,
    conflictsPending: allConflicts.filter((item) => item.status === 'pending').length
  };

  const data: BatchData = {
    meta,
    projects: mergedProjects,
    conflicts: allConflicts
  };

  const report: MergeReport = {
    batchId: newBatchId,
    parentBatchId: pkg.batchId,
    mergedAt: at,
    baselineToken: meta.baselineToken,
    offlineProjects: pkg.projects.length,
    onlineOnlyChanges: counters.onlineOnlyChanges,
    offlineOnlyChanges: counters.offlineOnlyChanges,
    dualRevisionEvidence: counters.dualRevisionEvidence,
    offlineEvidenceAdded: counters.offlineEvidenceAdded,
    frozenSkipped: counters.frozenSkipped,
    invalidatedEvidence: counters.invalidatedEvidence,
    conflicts
  };
  return { data, report };
}

/* ------------------------------------------------------------------ */
/* 冲突裁定                                                            */
/* ------------------------------------------------------------------ */

export function resolveEvidenceConflict(
  data: BatchData,
  conflictId: string,
  choice: DualRevisionChoice,
  actor: string,
  at = nowIso()
): boolean {
  const conflict = data.conflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.kind !== 'evidence_dual_revision' || conflict.status === 'resolved') return false;
  const project = data.projects.find((item) => item.id === conflict.projectId);
  if (!project || !conflict.conflictGroup) return false;

  const rows = project.evidence.filter((item) => item.conflictGroup === conflict.conflictGroup);
  const onlineRow = rows.find((item) => item.origin !== 'offline');
  const offlineRow = rows.find((item) => item.origin === 'offline');

  if (choice === 'online' && onlineRow && offlineRow) {
    onlineRow.pendingReview = false;
    offlineRow.superseded = true;
  } else if (choice === 'offline' && onlineRow && offlineRow) {
    offlineRow.pendingReview = false;
    onlineRow.superseded = true;
  } else {
    rows.forEach((item) => {
      item.pendingReview = false;
    });
  }

  conflict.status = 'resolved';
  conflict.resolution = choice === 'both' ? '两版并存，均留档复核' : choice === 'online' ? '采用在线版，离线版留档弃用' : '采用离线版，在线版留档弃用';
  conflict.resolvedAt = at;
  data.meta.conflictsPending = data.conflicts.filter((item) => item.status === 'pending').length;

  recomputeRegulations(project);
  recomputeProgress(project);
  project.audit.unshift(
    makeAudit(actor, '双版本冲突裁定', `${conflict.evidenceName}: ${conflict.resolution}`, 'online', data.meta.id, at)
  );
  return true;
}

export function acknowledgeConflict(data: BatchData, conflictId: string, actor: string, at = nowIso()): boolean {
  const conflict = data.conflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.status === 'resolved') return false;
  conflict.status = 'resolved';
  conflict.resolution = '已知悉，按合并规则保留在线有效版本';
  conflict.resolvedAt = at;
  data.meta.conflictsPending = data.conflicts.filter((item) => item.status === 'pending').length;
  const project = data.projects.find((item) => item.id === conflict.projectId);
  project?.audit.unshift(
    makeAudit(actor, '合并冲突确认', `${conflict.kind}: ${conflict.resolution}`, 'online', data.meta.id, at)
  );
  return true;
}

/* ------------------------------------------------------------------ */
/* 批次档案                                                            */
/* ------------------------------------------------------------------ */

export function createInitialDocument(projects: ApprovalProject[], at = nowIso()): BatchDocument {
  const seeded = cloneData(projects);
  seeded.forEach((project) => {
    project.evidence.forEach((item) => {
      if (!item.logicalId) item.logicalId = item.id;
      item.origin ??= 'seed';
    });
    recomputeRegulations(project);
  });
  const meta: BatchMetadata = {
    id: makeId('BATCH'),
    label: '基线批次（种子）',
    status: 'active',
    createdAt: at,
    baselineToken: baselineToken(seeded),
    actor: '系统',
    note: '初始化的有效复核批次',
    conflictsPending: 0
  };
  return {
    version: 2,
    activeBatchId: meta.id,
    batches: [{ meta, projects: seeded, conflicts: [] }]
  };
}

export function spawnBatch(active: BatchData, label: string, actor: string, note: string, at = nowIso()): BatchData {
  return {
    meta: {
      id: makeId('BATCH'),
      label,
      status: 'active',
      createdAt: at,
      parentBatchId: active.meta.id,
      baselineToken: active.meta.baselineToken,
      actor,
      note,
      conflictsPending: active.conflicts.filter((item) => item.status === 'pending').length
    },
    projects: cloneData(active.projects),
    conflicts: cloneData(active.conflicts)
  };
}
