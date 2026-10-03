import { defineStore } from 'pinia';
import { seedProjects } from '~/data/seed';
import {
  acknowledgeConflict as engineAcknowledgeConflict,
  applySoftwareBaselineInvalidation,
  baselineToken,
  buildOfflinePackage,
  cloneData,
  createInitialDocument,
  isFrozenProject,
  liveEvidence,
  makeAudit,
  makeId,
  mergeOfflineBatch,
  nowIso,
  recomputeProgress,
  recomputeRegulations,
  resolveEvidenceConflict as engineResolveEvidenceConflict,
  spawnBatch
} from '~/services/review-batch';
import {
  BatchWriteError,
  discardWal,
  readDocument,
  readFailureMode,
  writeDocument,
  writeFailureMode
} from '~/services/batch-storage';
import type {
  ApprovalProject,
  BatchData,
  BatchDocument,
  DualRevisionChoice,
  EvidenceItem,
  MergeReport,
  OfflinePackage,
  ProjectInput,
  ProjectStatus,
  ProjectVersion,
  WriteFailureMode
} from '~/types/certification';

export interface RecoveryState {
  pending: boolean;
  fromWal: boolean;
  error: string;
}

export const useCertificationStore = defineStore('certification', {
  state: () => ({
    doc: createInitialDocument(seedProjects) as BatchDocument,
    hydrated: false,
    failureMode: 'none' as WriteFailureMode,
    recovery: { pending: false, fromWal: false, error: '' } as RecoveryState,
    lastMergeReport: null as MergeReport | null,
    /** 写入失败时暂存的完整待提交文档；内存视图不采用它，列表/详情仍读有效批次 */
    pendingDocument: undefined as BatchDocument | undefined,
    /** 仅供演示：在「另一个窗口」修改在线批次 */
    demoOnlineDirty: false
  }),

  getters: {
    activeBatch(state): BatchData {
      const active = state.doc.batches.find((batch) => batch.meta.status === 'active');
      return active ?? state.doc.batches[state.doc.batches.length - 1]!;
    },
    projects(state): ApprovalProject[] {
      return this.activeBatch.projects;
    },
    projectById() {
      return (id: string) => this.projects.find((project: ApprovalProject) => project.id === id);
    },
    agencies(): string[] {
      return Array.from(new Set(this.projects.map((project: ApprovalProject) => project.agency))).sort();
    },
    pendingConflictCount(): number {
      return this.activeBatch.conflicts.filter((item) => item.status === 'pending').length;
    },
    batchHistory(): BatchData[] {
      return [...this.doc.batches].sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
    },
    expiringEvidence(): { project: ApprovalProject; evidence: EvidenceItem }[] {
      return this.projects.flatMap((project: ApprovalProject) =>
        liveEvidence(project)
          .filter((item) => item.expiryDate)
          .map((item) => ({ project, evidence: item }))
          .filter(({ evidence }) => new Date(evidence.expiryDate!) <= new Date('2027-01-31'))
      );
    }
  },

  actions: {
    /* ---------------------------------------------------------------- */
    hydrate() {
      if (this.hydrated || typeof localStorage === 'undefined') return;
      const read = readDocument();
      this.doc = read.document;
      this.failureMode = readFailureMode();
      this.recovery = {
        pending: read.source === 'wal',
        fromWal: read.source === 'wal',
        error:
          read.source === 'wal'
            ? '检测到上一次写入在提交前中断，当前展示恢复区中的完整批次，确认后重试提交。'
            : read.source === 'corrupt'
              ? '主批次文档损坏，已回退到种子基线批次。'
              : ''
      };
      this.hydrated = true;
    },

    /**
     * 所有写操作的唯一入口：在克隆的完整文档上改，再整体落盘。
     * 写入失败 → 内存态保持旧批次不动，整份待提交文档进入恢复态，按完整批次重试。
     */
    commit(nextDoc: BatchDocument, label: string, actor: string, note: string): boolean {
      // 再次保证只有一份有效批次
      nextDoc.batches.forEach((batch) => {
        if (batch.meta.id !== nextDoc.activeBatchId) batch.meta.status = 'superseded';
      });
      const active = nextDoc.batches.find((batch) => batch.meta.id === nextDoc.activeBatchId);
      if (active) {
        active.meta.status = 'active';
        active.meta.label = label;
        active.meta.actor = actor;
        active.meta.note = note;
        active.meta.conflictsPending = active.conflicts.filter((item) => item.status === 'pending').length;
        active.meta.baselineToken = baselineToken(active.projects);
      }
      try {
        writeDocument(nextDoc, this.failureMode);
      } catch (error) {
        // fail_once 在存储层抛出前已自行清除，内存标记与落盘保持一致
        this.failureMode = readFailureMode();
        this.recovery = {
          pending: true,
          fromWal: false,
          error: error instanceof BatchWriteError ? error.message : '写入失败，完整批次已暂存待重试。'
        };
        // 待恢复文档不进内存视图：列表/详情/提交包仍只认当前有效批次
        this.pendingDocument = nextDoc;
        return false;
      }
      this.doc = nextDoc;
      this.recovery = { pending: false, fromWal: false, error: '' };
      this.pendingDocument = undefined;
      return true;
    },

    /** 基于当前有效批次开一份可续作的新批次并写入 */
    commitNewBatch(mutate: (batch: BatchData) => void, label: string, actor: string, note: string): boolean {
      const next = cloneData(this.doc);
      const old = next.batches.find((batch) => batch.meta.id === next.activeBatchId)!;
      old.meta.status = 'superseded';
      old.meta.supersededAt = nowIso();
      const fresh = spawnBatch(old, label, actor, note);
      mutate(fresh);
      next.batches.push(fresh);
      next.activeBatchId = fresh.meta.id;
      return this.commit(next, label, actor, note);
    },

    retryLastWrite(): boolean {
      if (!this.pendingDocument) return false;
      try {
        writeDocument(this.pendingDocument, 'none');
      } catch (error) {
        this.recovery = {
          pending: true,
          fromWal: false,
          error: error instanceof BatchWriteError ? error.message : '重试仍然失败，完整批次继续保留。'
        };
        return false;
      }
      this.doc = this.pendingDocument;
      this.pendingDocument = undefined;
      this.recovery = { pending: false, fromWal: false, error: '' };
      discardWal();
      return true;
    },

    /** 放弃恢复区，继续以当前有效批次工作 */
    discardPendingWrite() {
      this.pendingDocument = undefined;
      this.recovery = { pending: false, fromWal: false, error: '' };
      discardWal();
    },

    /** 故障演练用：产生一次内容不变的续作批次写入 */
    selfCheckCommit(): boolean {
      return this.commitNewBatch(() => {}, '写入自检批次', '系统', '验证完整批次写入与恢复重试链路');
    },

    setFailureMode(mode: WriteFailureMode) {
      this.failureMode = mode;
      writeFailureMode(mode);
    },

    resumeBatch(batchId: string): boolean {
      const target = this.doc.batches.find((batch) => batch.meta.id === batchId);
      if (!target) return false;
      const next = cloneData(this.doc);
      next.batches.forEach((batch) => {
        batch.meta.status = batch.meta.id === batchId ? 'active' : 'superseded';
      });
      const restored = next.batches.find((batch) => batch.meta.id === batchId)!;
      restored.meta.supersededAt = undefined;
      next.activeBatchId = batchId;
      return this.commit(next, `恢复续作批次 ${target.meta.label}`, target.meta.actor, `从历史批次 ${batchId} 恢复为唯一有效批次`);
    },

    /* ---------------------------------------------------------------- */
    createProject(input: ProjectInput): string | null {
      const at = nowIso();
      let newId = '';
      const ok = this.commitNewBatch(
        (batch) => {
          const project: ApprovalProject = {
            id: `TA-${new Date().getFullYear()}-${String(this.projects.length + 121).padStart(3, '0')}`,
            ...input,
            status: 'draft',
            progress: 18,
            reviewer: '待分派',
            updatedAt: at,
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
                createdAt: at,
                summary: '创建认证证据包草稿。',
                changes: ['录入车型、配置和维护版本', '建立基础法规项'],
                impactedConfigurations: [input.configuration]
              }
            ],
            audit: [makeAudit(input.applicant, '建立项目', '创建型式认证证据包草稿。', 'online', undefined, at)]
          };
          newId = project.id;
          batch.projects.unshift(project);
        },
        `新建项目批次`,
        input.applicant,
        '建立车型、配置、维护版本和软件版本基线'
      );
      return ok ? newId : null;
    },

    updateProject(id: string, input: ProjectInput, reason: string, actor?: string): boolean {
      const existing = this.projectById(id);
      if (!existing || isFrozenProject(existing)) return false;
      const at = nowIso();
      const previous = {
        maintenanceVersion: existing.maintenanceVersion,
        softwareVersion: existing.softwareVersion,
        configuration: existing.configuration
      };
      return this.commitNewBatch(
        (batch) => {
          const project = batch.projects.find((item) => item.id === id)!;
          Object.assign(project, input, { updatedAt: at });

          const changed: string[] = [];
          if (previous.maintenanceVersion !== input.maintenanceVersion) changed.push('维护版本');
          if (previous.softwareVersion !== input.softwareVersion) changed.push('软件版本');
          if (previous.configuration !== input.configuration) changed.push('配置范围');

          if (changed.length) {
            let impacted: string[] = [input.configuration];
            if (previous.softwareVersion !== input.softwareVersion) {
              impacted = applySoftwareBaselineInvalidation(project, previous.softwareVersion, input.applicant, 'online', at);
            }
            const version: ProjectVersion = {
              id: makeId('VER'),
              label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
              author: input.applicant,
              createdAt: at,
              summary: `更新${changed.join('、')}：${reason}`,
              changes: changed,
              impactedConfigurations: impacted
            };
            project.versions.unshift(version);
            project.audit.unshift(
              makeAudit(
                input.applicant,
                '更新项目版本',
                `${changed.join('、')}；影响配置：${impacted.join('、')}`,
                'online',
                batch.meta.id,
                at
              )
            );
          } else {
            project.audit.unshift(makeAudit(input.applicant, '更新项目资料', reason, 'online', batch.meta.id, at));
          }
          recomputeRegulations(project);
          recomputeProgress(project);
        },
        `项目 ${id} 资料更新`,
        actor ?? input.applicant,
        reason
      );
    },

    transition(id: string, status: ProjectStatus, actor: string, reason: string): boolean {
      const existing = this.projectById(id);
      if (!existing || isFrozenProject(existing)) return false;
      const at = nowIso();
      return this.commitNewBatch(
        (batch) => {
          const project = batch.projects.find((item) => item.id === id)!;
          project.status = status;
          if (status === 'submitted') project.submittedAt = at.slice(0, 10);
          if (status === 'approved') project.progress = 100;
          if (status === 'supplement_required') project.progress = Math.min(project.progress, 82);
          project.updatedAt = at;
          project.audit.unshift(makeAudit(actor, '审批状态流转', `${status}；${reason}`, 'online', batch.meta.id, at));
        },
        `项目 ${id} 状态流转`,
        actor,
        reason
      );
    },

    updateEvidence(projectId: string, evidenceId: string, status: EvidenceItem['status'], note: string): boolean {
      const existing = this.projectById(projectId);
      if (!existing || isFrozenProject(existing)) return false;
      const at = nowIso();
      const actor = existing.reviewer === '待分派' ? '认证机构审阅人' : existing.reviewer;
      return this.commitNewBatch(
        (batch) => {
          const project = batch.projects.find((item) => item.id === projectId)!;
          const evidence = project.evidence.find((item) => item.id === evidenceId);
          if (!evidence) return;
          evidence.status = status;
          evidence.note = note || evidence.note;
          evidence.updatedAt = at;
          evidence.pendingReview = false;
          evidence.origin = 'online';
          project.updatedAt = at;
          project.audit.unshift(
            makeAudit(actor, '更新证据状态', `${evidence.name}：${status}`, 'online', batch.meta.id, at)
          );
          recomputeRegulations(project);
          recomputeProgress(project);
        },
        `项目 ${projectId} 证据审阅`,
        actor,
        note
      );
    },

    bulkSupplement(projectId: string, evidenceIds: string[], note: string): number {
      const existing = this.projectById(projectId);
      if (!existing || isFrozenProject(existing)) return 0;
      const at = nowIso();
      let count = 0;
      const ok = this.commitNewBatch(
        (batch) => {
          const project = batch.projects.find((item) => item.id === projectId)!;
          project.evidence.forEach((evidence) => {
            if (!evidenceIds.includes(evidence.id)) return;
            evidence.status = 'submitted';
            evidence.softwareVersion = project.softwareVersion;
            evidence.invalidated = false;
            evidence.pendingReview = false;
            evidence.note = note;
            evidence.updatedAt = at;
            evidence.origin = 'online';
            count += 1;
          });
          if (count) {
            project.updatedAt = at;
            project.audit.unshift(
              makeAudit(
                project.applicant,
                '批量补件',
                `${count} 项证据更新至 ${project.softwareVersion}，失效重算项已重新提交。${note}`,
                'online',
                batch.meta.id,
                at
              )
            );
            recomputeRegulations(project);
            recomputeProgress(project);
          }
        },
        `项目 ${projectId} 批量补件`,
        existing.applicant,
        note
      );
      return ok ? count : 0;
    },

    /* ---------------------------------------------------------------- */
    exportOfflinePackage(exporter: string): OfflinePackage {
      return buildOfflinePackage(this.activeBatch, exporter || '离线审阅员');
    },

    /**
     * 演示用：一步完成「导出离线包 → 另一窗口在线改动 → 离线侧改动」。
     * 离线包的基线快照固定在在线改动之前，回网合并时才能真实识别三方分歧。
     */
    stageOfflineDemo(kind: 'dual' | 'baseline' | 'frozen', exporter: string): OfflinePackage | null {
      const at = nowIso();
      const preBatch: BatchData = cloneData(this.activeBatch);
      const editableTarget =
        preBatch.projects.find(
          (project) => !isFrozenProject(project) && project.evidence.some((item) => item.id === 'EV-118-01')
        ) ?? preBatch.projects.find((project) => !isFrozenProject(project) && project.evidence.length);

      // 先在「另一窗口」施加在线改动并提交
      if (kind === 'dual' && editableTarget) {
        const ok = this.updateEvidence(editableTarget.id, 'EV-118-01', 'resubmit', '在线窗口：抽查发现制动报告需补充低温工况，要求重新抽样。');
        if (!ok) return null;
        this.demoOnlineDirty = true;
      } else if (kind === 'baseline' && editableTarget) {
        const current = editableTarget.softwareVersion;
        const ok = this.updateProject(
          editableTarget.id,
          {
            name: editableTarget.name,
            modelCode: editableTarget.modelCode,
            vehicleType: editableTarget.vehicleType,
            configuration: editableTarget.configuration,
            maintenanceVersion: editableTarget.maintenanceVersion,
            softwareVersion: current === '8.4.1' ? '8.4.2' : '8.4.1',
            applicant: editableTarget.applicant,
            agency: editableTarget.agency,
            certificateExpiry: editableTarget.certificateExpiry
          },
          '在线窗口紧急修复：升级软件基线修复制动标定',
          editableTarget.applicant
        );
        if (!ok) return null;
        this.demoOnlineDirty = true;
      }

      // 离线包从「在线改动之前」的批次导出，基线快照不含在线改动
      const pkg = buildOfflinePackage(preBatch, exporter);
      if (kind === 'frozen') {
        const frozen = pkg.projects.find(isFrozenProject);
        if (frozen) {
          frozen.status = 'rejected';
          frozen.softwareVersion = '9.9.9';
          frozen.audit.unshift(
            makeAudit(exporter, '离线尝试修改冻结项目', '离线现场尝试把已批准项目改为拒绝并升级软件版本。', 'offline', undefined, at)
          );
        }
        return pkg;
      }

      if (!editableTarget) return null;
      const target = pkg.projects.find((project) => project.id === editableTarget.id)!;
      const evidence = target.evidence.find((item) => item.id === 'EV-118-01') ?? target.evidence[0]!;
      if (kind === 'baseline') {
        evidence.status = 'accepted';
        evidence.note = '离线审阅：维持现有报告，记录现场意见。';
        evidence.updatedAt = at;
        target.audit.unshift(
          makeAudit(exporter, '离线复核记录', `${evidence.name} 离线批注。`, 'offline', undefined, at)
        );
        return pkg;
      }

      evidence.status = 'rejected';
      evidence.note = '离线复核结论：试验配置照片不全，要求重新抽样。';
      evidence.updatedAt = at;
      target.audit.unshift(
        makeAudit(exporter, '离线审阅', `${evidence.name} 标记为拒绝并要求重新抽样。`, 'offline', undefined, at)
      );
      return pkg;
    },

    mergeOfflinePackage(pkg: OfflinePackage): MergeReport | null {
      const outcome = mergeOfflineBatch(this.activeBatch, pkg);
      const next = cloneData(this.doc);
      const old = next.batches.find((batch) => batch.meta.id === next.activeBatchId)!;
      old.meta.status = 'superseded';
      old.meta.supersededAt = nowIso();
      next.batches.push(outcome.data);
      next.activeBatchId = outcome.data.meta.id;
      const ok = this.commit(next, outcome.data.meta.label, pkg.exporter, outcome.data.meta.note);
      if (!ok) return null;
      this.lastMergeReport = outcome.report;
      this.demoOnlineDirty = false;
      return outcome.report;
    },

    resolveEvidenceConflict(conflictId: string, choice: DualRevisionChoice, actor: string): boolean {
      let changed = false;
      const ok = this.commitNewBatch(
        (batch) => {
          changed = engineResolveEvidenceConflict(batch, conflictId, choice, actor);
        },
        '冲突裁定',
        actor,
        '对同一证据两边改动保留的双版本进行人工裁定'
      );
      return ok && changed;
    },

    acknowledgeConflict(conflictId: string, actor: string): boolean {
      let changed = false;
      const ok = this.commitNewBatch(
        (batch) => {
          changed = engineAcknowledgeConflict(batch, conflictId, actor);
        },
        '合并冲突确认',
        actor,
        '确认冻结拦截/在线保护/基线漂移提示'
      );
      return ok && changed;
    },

    reset() {
      const next = createInitialDocument(seedProjects);
      this.pendingDocument = undefined;
      this.recovery = { pending: false, fromWal: false, error: '' };
      discardWal();
      writeFailureMode('none');
      this.failureMode = 'none';
      this.doc = next;
      this.lastMergeReport = null;
      this.demoOnlineDirty = false;
    }
  }
});
