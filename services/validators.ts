import { liveEvidence } from './review-batch';
import type { ApprovalProject, ProjectInput } from '~/types/certification';

export function validateProjectInput(input: ProjectInput) {
  const errors: Partial<Record<keyof ProjectInput, string>> = {};

  if (input.name.trim().length < 3) errors.name = '项目名称至少 3 个字符';
  if (!/^[A-Za-z0-9-]{3,}$/.test(input.modelCode.trim())) errors.modelCode = '车型代码只能包含字母、数字和连字符';
  if (!input.vehicleType.trim()) errors.vehicleType = '请选择车辆类别';
  if (input.configuration.trim().length < 2) errors.configuration = '请填写配置名称';
  if (!/^MY\d{2}\.\d+$/.test(input.maintenanceVersion.trim())) errors.maintenanceVersion = '维护版本格式应类似 MY27.1';
  if (!/^\d+\.\d+\.\d+$/.test(input.softwareVersion.trim())) errors.softwareVersion = '软件版本格式应类似 8.4.1';
  if (input.applicant.trim().length < 2) errors.applicant = '请填写申请主体';
  if (input.agency.trim().length < 2) errors.agency = '请选择认证机构';
  if (!input.certificateExpiry) errors.certificateExpiry = '请选择证书有效期';

  return errors;
}

/** 提交包校验只认同一份有效批次：失效/待复核证据均为阻断项 */
export function validateSubmission(project: ApprovalProject) {
  const issues: string[] = [];
  const requiredRegulations = project.regulations.filter((item) => item.required);
  const evidence = liveEvidence(project);
  const missingEvidence = evidence.filter((item) => ['missing', 'rejected', 'resubmit'].includes(item.status));
  const invalidated = evidence.filter((item) => item.invalidated);
  const pendingReview = evidence.filter((item) => item.pendingReview);
  const versionMismatch = evidence.filter((item) => item.softwareVersion !== project.softwareVersion);
  const coverageIssue = requiredRegulations.find((item) => item.status !== 'complete');
  const expiring = new Date(project.certificateExpiry) <= new Date('2026-12-31');

  if (missingEvidence.length) issues.push(`${missingEvidence.length} 项证据缺失、被拒或待补件`);
  if (invalidated.length) issues.push(`${invalidated.length} 项证据因软件基线变更已失效，需重新测试/补件`);
  if (pendingReview.length) issues.push(`${pendingReview.length} 项证据存在离线改动或双版本，待人工复核裁定`);
  if (versionMismatch.length) issues.push(`${versionMismatch.length} 项证据软件版本与项目基线不一致`);
  if (coverageIssue) issues.push(`法规项 ${coverageIssue.code} 尚未完整覆盖配置`);
  if (expiring) issues.push('证书有效期不足 90 天，需先确认续证安排');

  return issues;
}

export function validateEvidenceUpgrade(project: ApprovalProject, evidenceIds: string[], note: string) {
  const errors: string[] = [];
  if (!evidenceIds.length) errors.push('至少选择一项待补件证据');
  if (note.trim().length < 6) errors.push('批量补件说明至少 6 个字符');
  const selectable = new Set(liveEvidence(project).map((item) => item.id));
  if (evidenceIds.some((id) => !selectable.has(id))) errors.push('所选证据不属于当前有效批次');
  return errors;
}
