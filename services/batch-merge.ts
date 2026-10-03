import type {
  ApprovalProject,
  AuditEntry,
  BatchProjectFields,
  BatchWorkset,
  ConflictGroup,
  EvidenceItem,
  EvidenceStatus,
  FieldMergeRecord,
  MergeReport,
  RegulationItem,
  ReviewBatch
} from '~/types/certification';

let sequence = 0;
function uniqueId(prefix: string) {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 深拷贝纯数据（Pinia reactive 代理在部分运行时不能被 structuredClone 序列化）。 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeAudit(actor: string, action: string, detail: string, offline = false, batchId?: string): AuditEntry {
  return { id: uniqueId('AUD'), actor, action, detail, createdAt: new Date().toISOString(), offline, batchId };
}

export function makeEvidenceId() {
  return uniqueId('EV');
}

const projectFieldLabels: Record<keyof BatchProjectFields, string> = {
  id: '项目编号',
  name: '项目名称',
  modelCode: '车型代码',
  vehicleType: '车辆类别',
  configuration: '申报配置',
  maintenanceVersion: '维护版本',
  softwareVersion: '软件基线',
  status: '审批状态',
  applicant: '申请主体',
  agency: '认证机构',
  reviewer: '审阅人',
  certificateExpiry: '证书有效期'
};

const projectFieldKeys = Object.keys(projectFieldLabels) as (keyof BatchProjectFields)[];

const evidenceSignatureFields = [
  'regulationId',
  'name',
  'type',
  'version',
  'softwareVersion',
  'configurations',
  'status',
  'expiryDate',
  'note'
] as const;

function evidenceSignature(item: EvidenceItem) {
  return JSON.stringify(evidenceSignatureFields.map((field) => item[field]));
}

/**
 * 软件基线联动产生的失效标记（staleAt / 状态被系统置为 resubmit）不算人工改动，
 * 否则审阅人在另一窗口仅推进基线也会把离线的人工判读误判成"两边都改"。
 */
function humanSignature(item: EvidenceItem, base?: EvidenceItem) {
  const normalized: EvidenceItem = { ...item };
  delete normalized.staleAt;
  delete normalized.staleReason;
  if (
    base &&
    item.staleAt &&
    item.status === 'resubmit' &&
    base.status !== 'resubmit' &&
    ['accepted', 'submitted'].includes(base.status)
  ) {
    normalized.status = base.status;
  }
  return evidenceSignature(normalized);
}

function semverGreater(a: string, b: string) {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export function snapshotWorkset(project: ApprovalProject): BatchWorkset {
  return {
    project: {
      id: project.id,
      name: project.name,
      modelCode: project.modelCode,
      vehicleType: project.vehicleType,
      configuration: project.configuration,
      maintenanceVersion: project.maintenanceVersion,
      softwareVersion: project.softwareVersion,
      status: project.status,
      applicant: project.applicant,
      agency: project.agency,
      reviewer: project.reviewer,
      certificateExpiry: project.certificateExpiry
    },
    evidence: project.evidence.map((item) => ({
      ...item,
      configurations: [...item.configurations],
      conflictGroupId: undefined,
      conflictSide: undefined
    })),
    deletedEvidenceIds: [],
    audit: project.audit.map((entry) => ({ ...entry })),
    updatedAt: project.updatedAt
  };
}

function indexByLogicalId(items: EvidenceItem[]) {
  const map = new Map<string, EvidenceItem>();
  items.forEach((item) => map.set(item.logicalId, item));
  return map;
}

const evidenceStatusLabels: Record<EvidenceStatus, string> = {
  missing: '缺失',
  submitted: '已提交',
  accepted: '已接受',
  rejected: '已拒绝',
  resubmit: '需重交'
};

/** 按当前软件基线重算证据失效标记与法规覆盖，软件基线一变即重算。 */
export function deriveRegulations(project: ApprovalProject): RegulationItem[] {
  const baseline = project.softwareVersion;
  return project.regulations.map((regulation) => {
    const items = project.evidence.filter((item) => item.regulationId === regulation.id);
    if (!items.length) {
      return { ...regulation, coverage: 0, status: 'missing', issues: ['尚未关联证据文件，需补件后覆盖。'] };
    }

    const aligned = items.filter(
      (item) => item.status === 'accepted' && item.softwareVersion === baseline && !item.staleAt && !item.conflictGroupId
    );
    const staleItems = items.filter((item) => item.staleAt || item.softwareVersion !== baseline);
    const conflictItems = items.filter((item) => item.conflictGroupId);
    const badItems = items.filter((item) => item.status !== 'accepted' && !item.conflictGroupId);
    const uncoveredConfig = items.filter(
      (item) => !item.configurations.includes(project.configuration) && !item.conflictGroupId
    );

    const issues: string[] = [];
    staleItems.forEach((item) => {
      issues.push(`《${item.name}》基于软件 ${item.softwareVersion}，基线已为 ${baseline}，证据失效需重测补件。`);
    });
    conflictItems
      .filter((item) => item.conflictSide === 'online')
      .forEach((item) => {
        issues.push(`《${item.name}》在线与离线两版并存，待人工复核取版后覆盖才能确认。`);
      });
    badItems.forEach((item) => {
      issues.push(`《${item.name}》状态为${evidenceStatusLabels[item.status]}，影响配置 ${item.configurations.join('、') || '—'}。`);
    });
    uncoveredConfig.forEach((item) => {
      issues.push(`《${item.name}》未覆盖当前配置 ${project.configuration}。`);
    });

    const coverage = Math.round((aligned.length / items.length) * 100);
    const status: RegulationItem['status'] =
      staleItems.length || conflictItems.length ? 'conflict' : aligned.length === items.length ? 'complete' : 'missing';
    return { ...regulation, coverage, status, issues: issues.length ? issues : [] };
  });
}

export function supplementPending(project: ApprovalProject): EvidenceItem[] {
  return project.evidence.filter(
    (item) =>
      !!item.staleAt ||
      item.softwareVersion !== project.softwareVersion ||
      ['missing', 'rejected', 'resubmit'].includes(item.status)
  );
}

interface EvidenceMergeResult {
  evidence: EvidenceItem[];
  groups: ConflictGroup[];
  appliedOffline: string[];
  keptOnline: string[];
  removed: string[];
  added: string[];
  notes: string[];
}

function mergeEvidence(
  batch: ReviewBatch,
  base: BatchWorkset,
  online: ApprovalProject,
  offline: BatchWorkset
): EvidenceMergeResult {
  const baseMap = indexByLogicalId(base.evidence);
  const onlineMap = indexByLogicalId(online.evidence);
  const offlineMap = indexByLogicalId(offline.evidence);
  const logicalIds = new Set([...baseMap.keys(), ...onlineMap.keys(), ...offlineMap.keys()]);

  const result: EvidenceItem[] = [];
  const groups: ConflictGroup[] = [];
  const appliedOffline: string[] = [];
  const keptOnline: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  const notes: string[] = [];

  logicalIds.forEach((logicalId) => {
    const b = baseMap.get(logicalId);
    const o = onlineMap.get(logicalId);
    const f = offlineMap.get(logicalId);

    // 离线新增
    if (!b && f) {
      result.push({ ...f, id: uniqueId('EV'), projectId: online.id });
      added.push(`${f.name}（${f.version}）`);
      return;
    }
    // 在线新增
    if (!b && o) {
      result.push({ ...o });
      keptOnline.push(`${o.name}（${o.version}）`);
      return;
    }

    const baseSig = b ? evidenceSignature(b) : '';
    const onlineChanged = !!o && (!b || humanSignature(o, b) !== baseSig);
    const offlineChanged = !!f && (!b || humanSignature(f, b) !== baseSig);
    const onlineDeleted = b && !o;
    const offlineDeleted = b && !f;

    if (onlineDeleted && offlineDeleted) {
      removed.push(b!.name);
      return;
    }
    if (onlineDeleted) {
      if (offlineChanged && f) {
        // 在线删除、离线修改：恢复离线版挂起待复核
        const groupId = uniqueId('CFL');
        groups.push({ id: groupId, logicalId, evidenceName: f.name, regulationId: f.regulationId, offline: { ...f } });
        result.push({
          ...f,
          id: uniqueId('EV'),
          projectId: online.id,
          conflictGroupId: groupId,
          conflictSide: 'offline',
          status: 'resubmit'
        });
        notes.push(`《${f.name}》在线窗口已删除但离线包有修改，保留离线版待复核确认。`);
      } else {
        removed.push(b!.name);
      }
      return;
    }
    if (offlineDeleted) {
      if (onlineChanged && o) {
        const groupId = uniqueId('CFL');
        groups.push({ id: groupId, logicalId, evidenceName: o.name, regulationId: o.regulationId, online: { ...o } });
        result.push({ ...o, conflictGroupId: groupId, conflictSide: 'online', status: 'resubmit' });
        notes.push(`《${o.name}》离线包已删除但在线窗口有修改，保留在线版待复核确认。`);
      } else if (o) {
        result.push({ ...o });
        keptOnline.push(`${o.name}（${o.version}）`);
      }
      return;
    }

    if (!o || !f) return;

    if (!onlineChanged && !offlineChanged) {
      result.push({ ...o });
      return;
    }
    if (onlineChanged && !offlineChanged) {
      result.push({ ...o });
      keptOnline.push(`${o.name}（${o.version}）`);
      return;
    }
    if (!onlineChanged && offlineChanged) {
      result.push({ ...f, id: o.id, projectId: online.id });
      appliedOffline.push(`${f.name}（${f.version}）`);
      return;
    }

    // 两边都改过
    if (evidenceSignature(o) === evidenceSignature(f)) {
      result.push({ ...o });
      notes.push(`《${o.name}》两边修改内容一致，按同一版本合并。`);
      return;
    }

    // 同一证据两边改过：留两版待复核
    const groupId = uniqueId('CFL');
    const onlineVersion: EvidenceItem = {
      ...o,
      conflictGroupId: groupId,
      conflictSide: 'online',
      status: 'resubmit'
    };
    const offlineVersion: EvidenceItem = {
      ...f,
      id: uniqueId('EV'),
      projectId: online.id,
      conflictGroupId: groupId,
      conflictSide: 'offline',
      status: 'resubmit'
    };
    groups.push({
      id: groupId,
      logicalId,
      evidenceName: o.name,
      regulationId: o.regulationId,
      online: onlineVersion,
      offline: offlineVersion
    });
    result.push(onlineVersion, offlineVersion);
    notes.push(`《${o.name}》在线窗口与离线包都做过修改，保留两版（在线 ${o.version} / 离线 ${f.version}）待复核取版。`);
  });

  return { evidence: result, groups, appliedOffline, keptOnline, removed, added, notes };
}

/** 三方合并：检出基线 base × 在线现状 online × 离线工作集 offline。纯函数，可幂等重算。 */
export function mergeReviewBatch(
  batch: ReviewBatch,
  online: ApprovalProject,
  nowIso: string,
  attempts = 1,
  recoveredFromFailure = false
): { project: ApprovalProject; report: MergeReport } {
  const { base, offline } = batch;

  // 冻结项目只读：在线已批准，旧包整体作废，不覆盖任何在线数据。
  if (online.status === 'approved') {
    const report: MergeReport = {
      batchId: batch.id,
      projectId: online.id,
      mergedAt: nowIso,
      fieldMerges: [],
      appliedOfflineEvidence: [],
      keptOnlineEvidence: [],
      conflictGroups: [],
      removedEvidence: [],
      addedEvidence: [],
      staleEvidence: [],
      regulationUpdates: [],
      baselineChanged: false,
      onlineFrozen: true,
      notes: [`项目 ${online.id} 已冻结（approved），离线复核包只读，未写入任何改动。`],
      attempts,
      recoveredFromFailure
    };
    return { project: deepClone(online), report };
  }

  const fieldMerges: FieldMergeRecord[] = [];
  const mergedFields = {} as BatchProjectFields;

  projectFieldKeys.forEach((field) => {
    const bv = base.project[field];
    const ov = online[field];
    const fv = offline.project[field];
    let picked: unknown = ov;
    let resolution: FieldMergeRecord['resolution'] = 'unchanged';

    const onlineChanged = ov !== bv;
    const offlineChanged = fv !== bv;

    if (!onlineChanged && !offlineChanged) {
      picked = ov;
    } else if (onlineChanged && !offlineChanged) {
      picked = ov;
      resolution = 'online';
    } else if (!onlineChanged && offlineChanged) {
      picked = fv;
      resolution = 'offline';
    } else if (ov === fv) {
      picked = ov;
      resolution = 'unchanged';
    } else if (field === 'softwareVersion') {
      // 基线按版本号合并：取更新的软件版本，旧包不覆盖新基线
      if (semverGreater(String(fv), String(ov))) {
        picked = fv;
        resolution = 'offline';
      } else {
        picked = ov;
        resolution = 'baseline_moved';
      }
    } else {
      // 状态、配置等其余字段冲突：在线审批链为准，差异留痕待复核
      picked = ov;
      resolution = field === 'status' ? 'both_online_wins' : 'both_online_wins';
    }

    mergedFields[field] = picked as never;
    if (onlineChanged || offlineChanged) {
      fieldMerges.push({
        field,
        label: projectFieldLabels[field],
        base: bv,
        online: ov,
        offline: fv,
        picked,
        resolution
      });
    }
  });

  const evidenceMerge = mergeEvidence(batch, base, online, offline);
  const baselineChanged = mergedFields.softwareVersion !== base.project.softwareVersion;
  const baselineFrom = baselineChanged ? base.project.softwareVersion : undefined;
  const baselineTo = baselineChanged ? mergedFields.softwareVersion : undefined;

  // 软件版本一改就失效：仅对"检出时与旧基线一致、合并不满足新基线"的证据置失效。
  // 检出前就已存在的历史版本错配不算本次基线变更造成的失效，避免连带改写离线状态流转。
  const baseEvidenceByLogicalId = new Map(base.evidence.map((item) => [item.logicalId, item]));
  const staleEvidence = evidenceMerge.evidence
    .filter((item) => {
      if (item.softwareVersion === mergedFields.softwareVersion) return false;
      if (item.conflictGroupId) return false;
      const baseItem = baseEvidenceByLogicalId.get(item.logicalId);
      if (baselineChanged) {
        // 基线推进：检出时与旧基线一致（或离线新增）的证据才判失效
        return !baseItem || baseItem.softwareVersion === base.project.softwareVersion;
      }
      // 基线未动：保留在线/离线工作集里已有的失效标记，不新制造失效
      return !!item.staleAt;
    })
    .map((item) => {
      item.staleAt = nowIso;
      item.staleReason = `软件基线变更为 ${mergedFields.softwareVersion}，证据仍基于 ${item.softwareVersion}，需失效重算。`;
      if (['accepted', 'submitted'].includes(item.status)) item.status = 'resubmit';
      return {
        id: item.id,
        name: item.name,
        evidenceVersion: item.version,
        evidenceSoftwareVersion: item.softwareVersion,
        baseline: mergedFields.softwareVersion
      };
    });

  // 与当前基线一致的证据清除工作集遗留的失效标记
  evidenceMerge.evidence.forEach((item) => {
    if (item.softwareVersion === mergedFields.softwareVersion && !item.conflictGroupId) {
      delete item.staleAt;
      delete item.staleReason;
    }
  });

  // 审计链合并：离线新增审计并入在线链，按 id 去重、按时间倒序
  const baseAuditIds = new Set(base.audit.map((entry) => entry.id));
  const offlineNewAudit = offline.audit
    .filter((entry) => !baseAuditIds.has(entry.id))
    .map((entry) => ({ ...entry, offline: true, batchId: batch.id }));
  const onlineAuditIds = new Set(online.audit.map((entry) => entry.id));
  const audit = [...online.audit, ...offlineNewAudit.filter((entry) => !onlineAuditIds.has(entry.id))];

  const merged: ApprovalProject = {
    ...deepClone(online),
    ...mergedFields,
    evidence: evidenceMerge.evidence,
    audit,
    versions: [...online.versions],
    updatedAt: nowIso
  };

  const notes = [...evidenceMerge.notes];

  // 离线侧把基线推到了更新版本：补一条版本记录
  if (
    baselineChanged &&
    mergedFields.softwareVersion === offline.project.softwareVersion &&
    mergedFields.softwareVersion !== online.softwareVersion
  ) {
    merged.versions.unshift({
      id: uniqueId('VER'),
      label: `${mergedFields.maintenanceVersion} / ${mergedFields.softwareVersion}`,
      author: batch.reviewer,
      createdAt: nowIso,
      summary: `离线复核包将软件基线由 ${online.softwareVersion} 推进至 ${mergedFields.softwareVersion}。`,
      changes: ['软件基线升级（离线复核带回）'],
      impactedConfigurations: [mergedFields.configuration]
    });
  }

  merged.audit.unshift(
    makeAudit(
      batch.reviewer,
      '离线复核回网合并',
      [
        `批次 ${batch.id} 按检出基线三方合并。`,
        evidenceMerge.appliedOffline.length ? `采纳离线证据 ${evidenceMerge.appliedOffline.length} 项。` : '',
        evidenceMerge.groups.length ? `两版待复核证据 ${evidenceMerge.groups.length} 组。` : '',
        staleEvidence.length ? `基线变更致 ${staleEvidence.length} 项证据失效重算。` : ''
      ]
        .filter(Boolean)
        .join(''),
      false,
      batch.id
    )
  );
  merged.audit.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // 法规覆盖随基线、证据版本与冲突状态重算
  merged.regulations = deriveRegulations(merged);
  const regulationUpdates = merged.regulations.map((regulation) => ({
    regulationId: regulation.id,
    code: regulation.code,
    coverage: regulation.coverage,
    status: regulation.status,
    issues: regulation.issues
  }));

  // 补件队列随失效重算刷新完整度
  const total = merged.evidence.length;
  const aligned = merged.evidence.filter(
    (item) => item.status === 'accepted' && item.softwareVersion === merged.softwareVersion && !item.conflictGroupId
  ).length;
  if (total) merged.progress = Math.round((aligned / total) * 100);
  if (evidenceMerge.groups.length || staleEvidence.length) {
    merged.status = merged.status === 'approved' ? merged.status : 'supplement_required';
  }

  if (baselineChanged) {
    notes.push(
      `软件基线由 ${baselineFrom} 变为 ${baselineTo}：${staleEvidence.length} 项证据失效重算，受影响配置 ${mergedFields.configuration} 的法规覆盖与补件队列已刷新。`
    );
  }

  const report: MergeReport = {
    batchId: batch.id,
    projectId: online.id,
    mergedAt: nowIso,
    fieldMerges,
    appliedOfflineEvidence: evidenceMerge.appliedOffline,
    keptOnlineEvidence: evidenceMerge.keptOnline,
    conflictGroups: evidenceMerge.groups,
    removedEvidence: evidenceMerge.removed,
    addedEvidence: evidenceMerge.added,
    staleEvidence,
    regulationUpdates,
    baselineChanged,
    baselineFrom,
    baselineTo,
    onlineFrozen: false,
    notes,
    attempts,
    recoveredFromFailure
  };

  return { project: merged, report };
}

/** 冲突取版：保留指定侧，丢弃另一侧，并清理失效/冲突标记。 */
export function resolveConflictGroup(
  project: ApprovalProject,
  group: ConflictGroup,
  keep: 'online' | 'offline'
): ApprovalProject {
  const next = deepClone(project);
  const winner = keep === 'online' ? group.online : group.offline;
  next.evidence = next.evidence.filter((item) => item.conflictGroupId !== group.id || item.conflictSide === keep);
  next.evidence.forEach((item) => {
    if (item.conflictGroupId === group.id) {
      delete item.conflictGroupId;
      delete item.conflictSide;
      if (winner) {
        item.status = winner.status === 'resubmit' ? 'submitted' : winner.status;
        item.note = `${winner.note}（复核取 ${keep === 'online' ? '在线' : '离线'} 版）`;
      }
    }
  });
  next.regulations = deriveRegulations(next);
  next.updatedAt = new Date().toISOString();
  return next;
}
