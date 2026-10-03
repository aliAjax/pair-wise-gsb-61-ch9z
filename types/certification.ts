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

/** 变更来源：在线窗口、离线复核包、种子数据或批次系统 */
export type RevisionOrigin = 'online' | 'offline' | 'seed' | 'system';

/** 批次生命周期：同一时刻只允许一份 active，其余全部 superseded */
export type BatchStatus = 'active' | 'superseded';

export type WriteFailureMode = 'none' | 'fail_once' | 'fail_always';

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
  /** 跨修订稳定的证据身份，冲突双版本共用同一 logicalId（缺省迁移为 id） */
  logicalId?: string;
  /** 当本行是冲突双版本之一时，指向其归属的 logicalId */
  revisionOf?: string;
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
  origin?: RevisionOrigin;
  /** 离线回网或双版本冲突后等待人工复核 */
  pendingReview?: boolean;
  /** 同一证据两边都改过：两版共享的冲突组号 */
  conflictGroup?: string;
  /** 软件基线变更后旧版本证据已失效，需要重新测试/补件 */
  invalidated?: boolean;
  /** 冲突复核中未被采用的版本，保留留档但不参与列表/覆盖/提交包 */
  superseded?: boolean;
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
  origin?: RevisionOrigin;
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

export interface BatchMetadata {
  id: string;
  label: string;
  status: BatchStatus;
  createdAt: string;
  supersededAt?: string;
  parentBatchId?: string;
  /** 批次内容指纹：离线包导出时记录，回网用于识别在线窗口是否漂移 */
  baselineToken: string;
  actor: string;
  note: string;
  conflictsPending: number;
}

export type ConflictKind =
  | 'evidence_dual_revision'
  | 'frozen_project_readonly'
  | 'online_change_protected'
  | 'stale_baseline';

/** 同一证据两边改动时，复核人对保留双版本的裁定 */
export type DualRevisionChoice = 'online' | 'offline' | 'both';

export interface MergeConflict {
  id: string;
  kind: ConflictKind;
  projectId: string;
  projectName: string;
  evidenceName?: string;
  regulationId?: string;
  conflictGroup?: string;
  onlineSummary: string;
  offlineSummary: string;
  status: 'pending' | 'resolved';
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** 一份批次的完整数据：认证项目、证据、法规、审计与未决冲突 */
export interface BatchData {
  meta: BatchMetadata;
  projects: ApprovalProject[];
  conflicts: MergeConflict[];
}

/** 持久化文档：始终只有一份 active 批次，旧批次留档只读 */
export interface BatchDocument {
  version: 2;
  activeBatchId: string;
  batches: BatchData[];
}

/** 审阅员带出网络的离线复核包：嵌入导出时刻基线快照与指纹 */
export interface OfflinePackage {
  kind: 'vehicle-type-approval-offline-review';
  packageVersion: 1;
  batchId: string;
  exportedAt: string;
  exporter: string;
  baselineToken: string;
  projects: ApprovalProject[];
  /** 导出时刻的基线快照，回网时作为三方合并的共同祖先 */
  baseline: ApprovalProject[];
}

export interface MergeReport {
  batchId: string;
  parentBatchId: string;
  mergedAt: string;
  baselineToken: string;
  offlineProjects: number;
  /** 在线窗口刚改过、旧包未动 → 在线值得以保留 */
  onlineOnlyChanges: number;
  /** 离线单边改动，按基线合并 */
  offlineOnlyChanges: number;
  /** 同一证据两边都改，保留双版本待复核 */
  dualRevisionEvidence: number;
  /** 离线新增补件 */
  offlineEvidenceAdded: number;
  /** 冻结项目离线改动被拒 */
  frozenSkipped: number;
  /** 软件基线升级后失效重算的证据 */
  invalidatedEvidence: number;
  conflicts: MergeConflict[];
}
