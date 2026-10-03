import { defineStore } from 'pinia';
import { seedProjects } from '~/data/seed';
import {
  deepClone,
  deriveRegulations,
  makeAudit,
  makeEvidenceId,
  mergeReviewBatch,
  resolveConflictGroup,
  snapshotWorkset,
  supplementPending
} from '~/services/batch-merge';
import type {
  ApprovalProject,
  AuditEntry,
  BatchProjectFields,
  BatchStatus,
  BatchWal,
  ConflictSide,
  EvidenceItem,
  OfflinePackage,
  ProjectInput,
  ProjectStatus,
  ProjectVersion,
  ReviewBatch
} from '~/types/certification';

const PROJECTS_KEY = 'vehicle-type-approval-projects-v1';
const BATCHES_KEY = 'vehicle-type-approval-review-batches-v1';
const WAL_KEY = 'vehicle-type-approval-review-batch-wal-v1';

const ACTIVE_STATUSES: BatchStatus[] = ['checked_out', 'awaiting_review'];

function cloneSeed() {
  return deepClone(seedProjects);
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function audit(actor: string, action: string, detail: string): AuditEntry {
  return makeAudit(actor, action, detail);
}

export interface CommitResult {
  ok: boolean;
  error?: string;
  batch?: ReviewBatch;
}

export const useCertificationStore = defineStore('certification', {
  state: () => ({
    projects: cloneSeed() as ApprovalProject[],
    batches: [] as ReviewBatch[],
    wal: null as BatchWal | null,
    hydrated: false
  }),

  getters: {
    projectById: (state) => (id: string) => state.projects.find((project) => project.id === id),
    agencies: (state) => Array.from(new Set(state.projects.map((project) => project.agency))).sort(),
    activeBatches: (state) => state.batches.filter((batch) => ACTIVE_STATUSES.includes(batch.status)),
    expiringEvidence: (state) =>
      state.projects.flatMap((project) =>
        project.evidence
          .filter((item) => item.expiryDate)
          .map((item) => ({ project, evidence: item }))
          .filter(({ evidence }) => new Date(evidence.expiryDate!) <= new Date('2027-01-31'))
      )
  },

  actions: {
    /* -------------------------------------------------- 持久化与恢复 */

    hydrate() {
      if (this.hydrated || typeof localStorage === 'undefined') return;
      try {
        const rawProjects = localStorage.getItem(PROJECTS_KEY);
        if (rawProjects) {
          const parsed = JSON.parse(rawProjects) as ApprovalProject[];
          parsed.forEach((project) =>
            project.evidence.forEach((item) => {
              if (!item.logicalId) item.logicalId = item.id;
            })
          );
          this.projects = parsed;
        }
        const rawBatches = localStorage.getItem(BATCHES_KEY);
        if (rawBatches) this.batches = JSON.parse(rawBatches) as ReviewBatch[];
        const rawWal = localStorage.getItem(WAL_KEY);
        if (rawWal) this.wal = JSON.parse(rawWal) as BatchWal;
      } catch {
        this.projects = cloneSeed();
        this.batches = [];
        this.wal = null;
      }
      this.hydrated = true;
      // 上次写入失败留下在途事务：先恢复到写入前的完整批次快照，等待显式重试
      if (this.wal) this.restoreWalPreState();
    },

    restoreWalPreState() {
      if (!this.wal) return;
      this.projects = deepClone(this.wal.preProjects);
      this.batches = deepClone(this.wal.preBatches);
      this.persist();
    },

    /** 按预写日志按完整批次恢复并重试提交。 */
    retryPendingCommit(): CommitResult {
      const pending = this.wal;
      if (!pending) return { ok: false, error: '没有待恢复的批次写入。' };
      this.restoreWalPreState();
      const batch = this.batches.find((item) => item.id === pending.batchId);
      if (!batch) {
        this.wal = null;
        this.persist();
        return { ok: false, error: '恢复失败：批次快照缺失。' };
      }
      return this.runCommit(batch, pending.attempts + 1, true);
    },

    persist() {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(this.projects));
      localStorage.setItem(BATCHES_KEY, JSON.stringify(this.batches));
      if (this.wal) localStorage.setItem(WAL_KEY, JSON.stringify(this.wal));
      else localStorage.removeItem(WAL_KEY);
    },

    /** 启动时发现未完成写入：恢复检出前完整快照，再按同一批次重新合并写入。 */
    recoverPendingCommit(): CommitResult {
      return this.retryPendingCommit();
    },

    /* -------------------------------------------------- 冻结保护 */

    isFrozen(projectId: string) {
      return this.projects.find((project) => project.id === projectId)?.status === 'approved';
    },

    assertWritable(projectId: string) {
      if (this.isFrozen(projectId)) throw new Error(`项目 ${projectId} 已冻结（approved），只读，不能修改。`);
    },

    /* -------------------------------------------------- 项目在线写入 */

    createProject(input: ProjectInput) {
      const createdAt = new Date().toISOString();
      const project: ApprovalProject = {
        id: `TA-${new Date().getFullYear()}-${String(this.projects.length + 121).padStart(3, '0')}`,
        ...input,
        status: 'draft',
        progress: 18,
        reviewer: '待分派',
        updatedAt: createdAt,
        regulations: [
          {
            id: 'REG-BRAKE',
            code: 'GB 21670',
            title: '乘用车制动系统技术要求',
            category: '安全',
            required: true,
            status: 'missing',
            coverage: 0,
            issues: ['尚未关联测试报告']
          },
          {
            id: 'REG-EMC',
            code: 'GB 34660',
            title: '道路车辆电磁兼容性要求',
            category: '环保',
            required: true,
            status: 'missing',
            coverage: 0,
            issues: ['尚未关联测试报告']
          }
        ],
        evidence: [],
        versions: [
          {
            id: makeId('VER'),
            label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
            author: input.applicant,
            createdAt,
            summary: '创建认证证据包草稿。',
            changes: ['录入车型、配置和维护版本', '建立基础法规项'],
            impactedConfigurations: [input.configuration]
          }
        ],
        audit: [audit(input.applicant, '建立项目', '创建型式认证证据包草稿。')]
      };
      this.projects.unshift(project);
      this.persist();
      return project.id;
    },

    recomputeProject(project: ApprovalProject) {
      const baseline = project.softwareVersion;
      const nowIso = new Date().toISOString();
      let invalidated = 0;
      project.evidence.forEach((item) => {
        if (item.conflictGroupId) return;
        if (item.softwareVersion !== baseline) {
          if (!item.staleAt) {
            item.staleAt = nowIso;
            item.staleReason = `软件基线变更为 ${baseline}，证据仍基于 ${item.softwareVersion}，需失效重算。`;
            if (['accepted', 'submitted'].includes(item.status)) item.status = 'resubmit';
            invalidated += 1;
          }
        } else {
          delete item.staleAt;
          delete item.staleReason;
        }
      });
      project.regulations = deriveRegulations(project);
      const total = project.evidence.length;
      const aligned = project.evidence.filter(
        (item) => item.status === 'accepted' && item.softwareVersion === baseline && !item.conflictGroupId
      ).length;
      if (total) project.progress = Math.round((aligned / total) * 100);
      return invalidated;
    },

    updateProject(id: string, input: ProjectInput, reason: string) {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return false;
      this.assertWritable(id);
      const previous = {
        maintenanceVersion: project.maintenanceVersion,
        softwareVersion: project.softwareVersion,
        configuration: project.configuration
      };
      Object.assign(project, input, { updatedAt: new Date().toISOString() });

      const changed: string[] = [];
      if (previous.maintenanceVersion !== input.maintenanceVersion) changed.push('维护版本');
      if (previous.softwareVersion !== input.softwareVersion) changed.push('软件版本');
      if (previous.configuration !== input.configuration) changed.push('配置范围');

      if (changed.length) {
        const version: ProjectVersion = {
          id: makeId('VER'),
          label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
          author: project.applicant,
          createdAt: new Date().toISOString(),
          summary: `更新${changed.join('、')}：${reason}`,
          changes: changed,
          impactedConfigurations: [input.configuration]
        };
        project.versions.unshift(version);
        project.audit.unshift(
          audit(project.applicant, '更新项目版本', `${changed.join('、')}；影响配置：${input.configuration}`)
        );
      } else {
        project.audit.unshift(audit(project.applicant, '更新项目资料', reason));
      }

      // 软件版本一改：证据失效重算，受影响配置的法规覆盖与补件队列同步更新
      if (previous.softwareVersion !== input.softwareVersion) {
        const invalidated = this.recomputeProject(project);
        project.audit.unshift(
          audit(
            project.applicant,
            '软件基线变更联动',
            `软件基线 ${previous.softwareVersion} → ${input.softwareVersion}，${invalidated} 项旧版证据失效重算，受影响配置 ${input.configuration} 的法规覆盖与补件队列已刷新。`
          )
        );
      }
      this.persist();
      return true;
    },

    transition(id: string, status: ProjectStatus, actor: string, reason: string) {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return false;
      this.assertWritable(id);
      project.status = status;
      if (status === 'submitted') project.submittedAt = new Date().toISOString().slice(0, 10);
      if (status === 'approved') project.progress = 100;
      if (status === 'supplement_required') project.progress = Math.min(project.progress, 82);
      project.updatedAt = new Date().toISOString();
      project.audit.unshift(audit(actor, '审批状态流转', `${status}；${reason}`));
      this.persist();
      return true;
    },

    updateEvidence(projectId: string, evidenceId: string, status: EvidenceItem['status'], note: string) {
      const project = this.projects.find((item) => item.id === projectId);
      const evidence = project?.evidence.find((item) => item.id === evidenceId);
      if (!project || !evidence) return false;
      this.assertWritable(projectId);
      evidence.status = status;
      evidence.note = note || evidence.note;
      evidence.updatedAt = new Date().toISOString();
      if (status === 'accepted' && evidence.softwareVersion === project.softwareVersion && !evidence.conflictGroupId) {
        delete evidence.staleAt;
        delete evidence.staleReason;
      }
      project.updatedAt = evidence.updatedAt;
      project.regulations = deriveRegulations(project);
      project.audit.unshift(audit(project.reviewer, '更新证据状态', `${evidence.name}：${status}`));
      this.persist();
      return true;
    },

    bulkSupplement(projectId: string, evidenceIds: string[], note: string) {
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return 0;
      this.assertWritable(projectId);
      let count = 0;
      project.evidence.forEach((evidence) => {
        if (!evidenceIds.includes(evidence.id)) return;
        evidence.status = 'submitted';
        evidence.softwareVersion = project.softwareVersion;
        evidence.note = note;
        evidence.updatedAt = new Date().toISOString();
        delete evidence.staleAt;
        delete evidence.staleReason;
        count += 1;
      });
      if (count) {
        project.progress = Math.min(95, project.progress + count * 4);
        project.updatedAt = new Date().toISOString();
        project.regulations = deriveRegulations(project);
        project.audit.unshift(
          audit(project.applicant, '批量补件', `${count} 项证据更新至 ${project.softwareVersion}。${note}`)
        );
        this.persist();
      }
      return count;
    },

    pendingSupplements(projectId: string) {
      const project = this.projects.find((item) => item.id === projectId);
      return project ? supplementPending(project) : [];
    },

    /* -------------------------------------------------- 复核批次：检出 */

    activeBatchForProject(projectId: string) {
      return this.batches.find(
        (batch) => batch.projectId === projectId && ACTIVE_STATUSES.includes(batch.status)
      ) as ReviewBatch | undefined;
    },

    checkoutBatch(projectId: string, reviewer: string, label: string) {
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      this.assertWritable(projectId);
      if (this.activeBatchForProject(projectId)) {
        throw new Error('该项目已有在途复核批次，请先合并或放弃当前批次。');
      }
      const nowIso = new Date().toISOString();
      const workset = snapshotWorkset(project);
      const batch: ReviewBatch = {
        id: makeId('BAT'),
        projectId,
        label: label.trim() || `${project.id} 离线复核`,
        reviewer: reviewer.trim() || project.reviewer,
        status: 'checked_out',
        createdAt: nowIso,
        checkedOutAt: nowIso,
        base: workset,
        offline: deepClone(workset),
        unresolvedConflictGroupIds: []
      };
      this.batches.unshift(batch);
      project.audit.unshift(audit(batch.reviewer, '检出离线复核批次', `${batch.id}：${batch.label}。`));
      this.persist();
      return batch.id;
    },

    buildOfflinePackage(batchId: string): OfflinePackage {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch) throw new Error('复核批次不存在。');
      if (batch.status !== 'checked_out') throw new Error('只有检出中的批次可以导出离线包。');
      batch.exportedAt = new Date().toISOString();
      this.persist();
      return {
        kind: 'vehicle-approval-offline-batch/v1',
        exportedAt: batch.exportedAt,
        exportedBy: batch.reviewer,
        batch: deepClone(batch)
      };
    },

    importOfflinePackage(payload: OfflinePackage): string {
      if (!payload || payload.kind !== 'vehicle-approval-offline-batch/v1') {
        throw new Error('离线复核包格式不被识别。');
      }
      const incoming = payload.batch;
      const existing = this.batches.find((item) => item.id === incoming.id);
      if (!existing) throw new Error('本机没有该批次的检出记录，不能回网导入（缺少合并基线）。');
      if (existing.status !== 'checked_out') throw new Error('该批次已结束，不能再次导入。');
      const project = this.projects.find((item) => item.id === incoming.projectId);
      if (!project) throw new Error('批次对应的认证项目已不存在。');
      if (project.status === 'approved') {
        // 冻结项目：包只读，登记后等待提交时整体作废，不覆盖在线数据
      }
      if (existing.base.project.softwareVersion !== incoming.base.project.softwareVersion) {
        throw new Error('离线包检出基线与本机记录不一致，拒绝导入。');
      }
      existing.offline = deepClone(incoming.offline);
      existing.exportedAt = incoming.exportedAt;
      this.persist();
      return existing.id;
    },

    abandonBatch(batchId: string) {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch || !ACTIVE_STATUSES.includes(batch.status)) return false;
      batch.status = 'abandoned';
      const project = this.projects.find((item) => item.id === batch.projectId);
      project?.audit.unshift(audit(batch.reviewer, '放弃复核批次', `${batch.id} 的离线改动未回写。`));
      this.persist();
      return true;
    },

    /* -------------------------------------------------- 批次内离线编辑 */

    offlineBatch(batchId: string) {
      return this.batches.find((item) => item.id === batchId);
    },

    offlinePatch(batchId: string, patch: Partial<BatchProjectFields>, reason: string) {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch || batch.status !== 'checked_out') throw new Error('批次不在离线复核状态。');
      const workset = batch.offline;
      const before = { ...workset.project };
      const beforeSoftware = workset.project.softwareVersion;
      Object.assign(workset.project, patch);
      workset.updatedAt = new Date().toISOString();
      const fieldLabels: Partial<Record<keyof BatchProjectFields, string>> = {
        name: '项目名称',
        configuration: '申报配置',
        maintenanceVersion: '维护版本',
        softwareVersion: '软件基线',
        status: '审批状态',
        reviewer: '审阅人',
        certificateExpiry: '证书有效期'
      };
      const labels = (Object.keys(patch) as (keyof BatchProjectFields)[]).filter(
        (field) => patch[field] !== before[field]
      ).map((field) => fieldLabels[field] ?? field);

      // 离线侧软件基线一改，旧版证据同样立即失效重算
      let invalidated = 0;
      if (workset.project.softwareVersion !== beforeSoftware) {
        const baseline = workset.project.softwareVersion;
        workset.evidence.forEach((item) => {
          if (item.softwareVersion !== baseline) {
            item.staleAt = workset.updatedAt;
            item.staleReason = `离线复核将软件基线调整为 ${baseline}，证据仍基于 ${item.softwareVersion}，需失效重算。`;
            if (['accepted', 'submitted'].includes(item.status)) item.status = 'resubmit';
            invalidated += 1;
          } else {
            delete item.staleAt;
            delete item.staleReason;
          }
        });
      }

      workset.audit.unshift(
        makeAudit(
          batch.reviewer,
          '离线修改项目资料',
          `${labels.join('、') || '项目资料'}：${reason}${invalidated ? `；基线联动 ${invalidated} 项证据失效待补件` : ''}`,
          true,
          batch.id
        )
      );
      this.persist();
    },

    offlineSetEvidence(batchId: string, logicalId: string, status: EvidenceItem['status'], note: string) {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch || batch.status !== 'checked_out') throw new Error('批次不在离线复核状态。');
      const evidence = batch.offline.evidence.find((item) => item.logicalId === logicalId);
      if (!evidence) throw new Error('证据不在该复核批次内。');
      evidence.status = status;
      if (note) evidence.note = note;
      evidence.updatedAt = new Date().toISOString();
      batch.offline.updatedAt = evidence.updatedAt;
      batch.offline.audit.unshift(
        makeAudit(batch.reviewer, '离线更新证据状态', `${evidence.name}：${status}`, true, batch.id)
      );
      this.persist();
    },

    offlineAddEvidence(
      batchId: string,
      input: Pick<EvidenceItem, 'regulationId' | 'name' | 'type' | 'version' | 'configurations' | 'note'>
    ) {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch || batch.status !== 'checked_out') throw new Error('批次不在离线复核状态。');
      const nowIso = new Date().toISOString();
      const id = makeEvidenceId();
      const item: EvidenceItem = {
        id,
        logicalId: id,
        projectId: batch.projectId,
        regulationId: input.regulationId,
        name: input.name,
        type: input.type,
        version: input.version,
        softwareVersion: batch.offline.project.softwareVersion,
        configurations: input.configurations,
        status: 'submitted',
        note: input.note,
        updatedAt: nowIso
      };
      batch.offline.evidence.push(item);
      batch.offline.updatedAt = nowIso;
      batch.offline.audit.unshift(
        makeAudit(batch.reviewer, '离线新增证据', `${item.name}（${item.version}）`, true, batch.id)
      );
      this.persist();
      return id;
    },

    offlineDeleteEvidence(batchId: string, logicalId: string) {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch || batch.status !== 'checked_out') throw new Error('批次不在离线复核状态。');
      const target = batch.offline.evidence.find((item) => item.logicalId === logicalId);
      if (!target) return false;
      batch.offline.evidence = batch.offline.evidence.filter((item) => item.logicalId !== logicalId);
      if (!batch.base.evidence.some((item) => item.logicalId === logicalId)) {
        // 检出后新增的证据：直接移除即可
      } else {
        batch.offline.deletedEvidenceIds.push(logicalId);
      }
      batch.offline.updatedAt = new Date().toISOString();
      batch.offline.audit.unshift(
        makeAudit(batch.reviewer, '离线删除证据', target.name, true, batch.id)
      );
      this.persist();
      return true;
    },

    /* -------------------------------------------------- 回网提交与 WAL */

    /**
     * 事务化提交：先写完整批次预写日志，再写入合并结果。
     * simulateFirstFailure 用于演示写入失败：状态留在提交前，WAL 保留，
     * 下次调用（或启动恢复）按完整批次重新合并重试。
     */
    commitReviewBatch(batchId: string, options: { simulateFirstFailure?: boolean } = {}): CommitResult {
      if (this.wal) {
        const recovered = this.recoverPendingCommit();
        if (!recovered.ok) return recovered;
        if (this.wal?.batchId) return { ok: false, error: '存在其他未恢复的批次写入。' };
      }
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch) return { ok: false, error: '复核批次不存在。' };
      if (batch.status !== 'checked_out') return { ok: false, error: '只有检出中的批次可以回网提交。' };
      const online = this.projects.find((item) => item.id === batch.projectId);
      if (!online) return { ok: false, error: '批次对应的认证项目不存在。' };

      const preProjects = deepClone(this.projects);
      const preBatches = deepClone(this.batches);

      const { project: mergedProject, report } = mergeReviewBatch(
        batch,
        online,
        new Date().toISOString(),
        1,
        false
      );

      const postBatch: ReviewBatch = {
        ...deepClone(batch),
        offline: deepClone(batch.offline),
        status: report.onlineFrozen
          ? 'voided'
          : report.conflictGroups.length
            ? 'awaiting_review'
            : 'merged',
        mergedAt: report.mergedAt,
        unresolvedConflictGroupIds: report.conflictGroups.map((group) => group.id),
        report
      };
      const postBatches = this.batches.map((item) => (item.id === batch.id ? postBatch : item));
      const postProjects = this.projects.map((item) => (item.id === online.id ? mergedProject : item));

      this.wal = {
        id: makeId('WAL'),
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        attempts: 1,
        preProjects,
        preBatches,
        postProjects,
        postBatches
      };
      this.persist();

      if (options.simulateFirstFailure) {
        // 模拟写入中断：预写日志已落盘，业务数据保持提交前状态，等待按完整批次恢复重试
        const message = '批次写入失败：存储写入中断，预写日志已保留，可按完整批次恢复重试。';
        postBatch.lastError = message;
        return { ok: false, error: message, batch: postBatch };
      }

      return this.applyWal(postProjects, postBatches, report);
    },

    /** 按预写日志恢复后重跑完整合并（而非套用半成品结果）。 */
    runCommit(batch: ReviewBatch, attempts: number, recoveredFromFailure: boolean): CommitResult {
      const online = this.projects.find((item) => item.id === batch.projectId);
      if (!online) return { ok: false, error: '恢复失败：项目不存在。' };
      const { project: mergedProject, report } = mergeReviewBatch(
        batch,
        online,
        new Date().toISOString(),
        attempts,
        recoveredFromFailure
      );
      const postBatch: ReviewBatch = {
        ...deepClone(batch),
        status: report.onlineFrozen
          ? 'voided'
          : report.conflictGroups.length
            ? 'awaiting_review'
            : 'merged',
        mergedAt: report.mergedAt,
        unresolvedConflictGroupIds: report.conflictGroups.map((group) => group.id),
        report,
        commitAttempts: attempts
      };
      const postProjects = this.projects.map((item) => (item.id === online.id ? mergedProject : item));
      const postBatches = this.batches.map((item) => (item.id === batch.id ? postBatch : item));
      if (this.wal) this.wal.attempts = attempts;
      return this.applyWal(postProjects, postBatches, report);
    },

    applyWal(postProjects: ApprovalProject[], postBatches: ReviewBatch[], report: ReviewBatch['report']): CommitResult {
      try {
        this.projects = postProjects;
        this.batches = postBatches;
        this.wal = null;
        this.persist();
        const batch = postBatches.find((item) => item.id === report!.batchId);
        return { ok: true, batch };
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知写入错误';
        const failed = postBatches.find((item) => item.id === report!.batchId);
        if (failed) failed.lastError = message;
        return { ok: false, error: message, batch: failed };
      }
    },

    /** 两版证据取版：列表、详情、提交包在取版后统一只认同一份有效数据。 */
    resolveBatchConflict(batchId: string, groupId: string, keep: ConflictSide): CommitResult {
      const batch = this.batches.find((item) => item.id === batchId);
      if (!batch) return { ok: false, error: '复核批次不存在。' };
      if (batch.status !== 'awaiting_review' || !batch.report) {
        return { ok: false, error: '该批次没有待复核的两版证据。' };
      }
      const group = batch.report.conflictGroups.find((item) => item.id === groupId);
      if (!group) return { ok: false, error: '冲突组不存在。' };
      const project = this.projects.find((item) => item.id === batch.projectId);
      if (!project) return { ok: false, error: '项目不存在。' };
      if (project.status === 'approved') return { ok: false, error: '项目已冻结，只读。' };

      const preProjects = deepClone(this.projects);
      const preBatches = deepClone(this.batches);
      const resolvedProject = resolveConflictGroup(project, group, keep);
      const winner = keep === 'online' ? group.online : group.offline;
      resolvedProject.audit.unshift(
        audit(
          batch.reviewer,
          '两版证据复核取版',
          `《${group.evidenceName}》采用${keep === 'online' ? '在线' : '离线'}版（${winner?.version ?? '—'}），另一版作废。`
        )
      );
      resolvedProject.audit.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      resolvedProject.regulations = deriveRegulations(resolvedProject);

      const remainingIds = batch.unresolvedConflictGroupIds.filter((id) => id !== groupId);
      const updatedReport = deepClone(batch.report);
      updatedReport.conflictGroups = updatedReport.conflictGroups.filter((item) => item.id !== groupId);
      const updatedBatch: ReviewBatch = {
        ...deepClone(batch),
        status: remainingIds.length ? 'awaiting_review' : 'merged',
        unresolvedConflictGroupIds: remainingIds,
        report: updatedReport
      };

      this.wal = {
        id: makeId('WAL'),
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        attempts: 1,
        preProjects,
        preBatches,
        postProjects: this.projects.map((item) => (item.id === resolvedProject.id ? resolvedProject : item)),
        postBatches: this.batches.map((item) => (item.id === batch.id ? updatedBatch : item))
      };
      this.persist();
      return this.applyWal(this.wal.postProjects, this.wal.postBatches, updatedBatch.report);
    },

    reset() {
      this.projects = cloneSeed();
      this.batches = [];
      this.wal = null;
      this.persist();
    }
  }
});
