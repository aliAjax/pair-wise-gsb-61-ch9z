export const projectStatuses = [
  'draft',
  'submitted',
  'under_review',
  'supplement_required',
  'approved',
  'rejected'
] as const;

export const evidenceStatuses = ['missing', 'submitted', 'accepted', 'rejected', 'resubmit'] as const;

export type ProjectStatus = (typeof projectStatuses)[number];
export type EvidenceStatus = (typeof evidenceStatuses)[number];

export type ConflictSide = 'online' | 'offline';

export type BatchStatus =
  | 'checked_out' // 已检出，离线复核进行中
  | 'awaiting_review' // 回网合并完成，但存在两版证据待复核
  | 'merged' // 合并完成且无待决冲突
  | 'abandoned' // 放弃
  | 'voided'; // 在线项目已冻结，旧包无法回写

export const batchStatusLabels: Record<BatchStatus, string> = {
  checked_out: '离线复核中',
  awaiting_review: '两版待复核',
  merged: '已合并归档',
  abandoned: '已放弃',
  voided: '冻结作废'
};

export interface RegulationItem {
  id: string;
  code: string;
  title: string;
  category: '安全' | '环保' | '能耗' | '软件' | '部件';
  required: boolean;
  status: 'complete' | 'missing' | 'conflict';
  coverage: number;
  issues: string[];
}

export interface EvidenceItem {
  id: string;
  /** 跨版本稳定标识：同一证据在线/离线两版共用 */
  logicalId: string;
  projectId: string;
  regulationId: string;
  name: string;
  type: 'test_report' | 'part_list' | 'software_report' | 'exemption' | 'certificate';
  version: string;
  softwareVersion: string;
  configurations: string[];
  status: EvidenceStatus;
  expiryDate?: string;
  note: string;
  updatedAt: string;
  /** 两边都改过：同组两版待人工复核 */
  conflictGroupId?: string;
  conflictSide?: ConflictSide;
  /** 软件基线变更后失效时间，需要补件重算 */
  staleAt?: string;
  staleReason?: string;
}

export interface ProjectVersion {
  id: string;
  label: string;
  author: string;
  createdAt: string;
  summary: string;
  changes: string[];
  impactedConfigurations: string[];
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
  /** 离线复核期间产生、回网后合并进在线审计链 */
  offline?: boolean;
  batchId?: string;
}

export interface ApprovalProject {
  id: string;
  name: string;
  modelCode: string;
  vehicleType: string;
  configuration: string;
  maintenanceVersion: string;
  softwareVersion: string;
  status: ProjectStatus;
  progress: number;
  applicant: string;
  reviewer: string;
  agency: string;
  submittedAt?: string;
  updatedAt: string;
  certificateExpiry: string;
  regulations: RegulationItem[];
  evidence: EvidenceItem[];
  versions: ProjectVersion[];
  audit: AuditEntry[];
}

export interface ProjectInput {
  name: string;
  modelCode: string;
  vehicleType: string;
  configuration: string;
  maintenanceVersion: string;
  softwareVersion: string;
  applicant: string;
  agency: string;
  certificateExpiry: string;
}

export interface ProjectFilters {
  query: string;
  status: ProjectStatus | 'all';
  agency: string | 'all';
  risk: 'all' | 'expiring' | 'missing' | 'version_conflict';
}

/** 复核批次内可离线修改的项目字段集合 */
export type BatchProjectFields = Pick<
  ApprovalProject,
  | 'id'
  | 'name'
  | 'modelCode'
  | 'vehicleType'
  | 'configuration'
  | 'maintenanceVersion'
  | 'softwareVersion'
  | 'status'
  | 'applicant'
  | 'agency'
  | 'reviewer'
  | 'certificateExpiry'
>;

/** 工作集：检出基线和离线改动都用同一形状，构成三方合并的两端 */
export interface BatchWorkset {
  project: BatchProjectFields;
  evidence: EvidenceItem[];
  deletedEvidenceIds: string[];
  audit: AuditEntry[];
  updatedAt: string;
}

export interface FieldMergeRecord {
  field: keyof BatchProjectFields;
  label: string;
  base: unknown;
  online: unknown;
  offline: unknown;
  picked: unknown;
  resolution: 'unchanged' | 'online' | 'offline' | 'both_online_wins' | 'baseline_moved';
}

export interface ConflictGroup {
  id: string;
  logicalId: string;
  evidenceName: string;
  regulationId: string;
  online?: EvidenceItem;
  offline?: EvidenceItem;
}

export interface StaleEvidenceRecord {
  id: string;
  name: string;
  evidenceVersion: string;
  evidenceSoftwareVersion: string;
  baseline: string;
}

export interface RegulationUpdate {
  regulationId: string;
  code: string;
  coverage: number;
  status: RegulationItem['status'];
  issues: string[];
}

export interface MergeReport {
  batchId: string;
  projectId: string;
  mergedAt: string;
  fieldMerges: FieldMergeRecord[];
  appliedOfflineEvidence: string[];
  keptOnlineEvidence: string[];
  conflictGroups: ConflictGroup[];
  removedEvidence: string[];
  addedEvidence: string[];
  staleEvidence: StaleEvidenceRecord[];
  regulationUpdates: RegulationUpdate[];
  baselineChanged: boolean;
  baselineFrom?: string;
  baselineTo?: string;
  onlineFrozen: boolean;
  notes: string[];
  attempts: number;
  recoveredFromFailure: boolean;
}

export interface ReviewBatch {
  id: string;
  projectId: string;
  label: string;
  reviewer: string;
  status: BatchStatus;
  createdAt: string;
  checkedOutAt: string;
  /** 检出时的在线快照，三方合并的基线 */
  base: BatchWorkset;
  /** 离线复核工作集，回网前的全部改动 */
  offline: BatchWorkset;
  exportedAt?: string;
  mergedAt?: string;
  unresolvedConflictGroupIds: string[];
  report?: MergeReport;
  lastError?: string;
  /** 提交时写入尝试次数（含失败恢复重试） */
  commitAttempts?: number;
}

/** 离线复核包：审阅员可下载带走、回网后导入的完整批次 */
export interface OfflinePackage {
  kind: 'vehicle-approval-offline-batch/v1';
  exportedAt: string;
  exportedBy: string;
  batch: ReviewBatch;
}

/** 批次提交的预写日志：写入失败后据此按完整批次恢复重试 */
export interface BatchWal {
  id: string;
  batchId: string;
  createdAt: string;
  attempts: number;
  preProjects: ApprovalProject[];
  preBatches: ReviewBatch[];
  postProjects: ApprovalProject[];
  postBatches: ReviewBatch[];
}
