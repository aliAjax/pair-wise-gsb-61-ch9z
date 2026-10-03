import { createPinia, setActivePinia } from 'pinia';
import { useCertificationStore } from '../stores/certification';
import { mergeReviewBatch, snapshotWorkset } from '../services/batch-merge';
import { seedProjects } from '../data/seed';
import type { ApprovalProject, ReviewBatch } from '../types/certification';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function freshStore() {
  setActivePinia(createPinia());
  const store = useCertificationStore();
  store.hydrate();
  // 清空 localStorage 干扰：直接重置
  store.reset();
  return store;
}

console.log('场景 1：离线改状态，在线窗口没动 → 离线状态生效');
{
  const store = freshStore();
  const pid = 'TA-2026-118';
  const bid = store.checkoutBatch(pid, '审阅人甲', '现场复核');
  store.offlinePatch(bid, { status: 'approved' }, '现场通过');
  const result = store.commitReviewBatch(bid);
  check('合并成功', result.ok);
  check('状态被离线更新为 approved', store.projectById(pid)!.status === 'approved');
  const online = store.projectById(pid)!;
  check('冻结后审计链包含离线记录', online.audit.some((e) => e.offline && e.action === '离线修改项目资料'));
}

console.log('场景 2：在线窗口改了软件基线，离线旧包回来 → 旧包不覆盖新基线');
{
  const store = freshStore();
  const pid = 'TA-2026-109';
  const bid = store.checkoutBatch(pid, '审阅人甲', '旧包');
  // 离线仅改一条证据
  const ev = store.offlineBatch(bid)!.offline.evidence[0];
  store.offlineSetEvidence(bid, ev.logicalId, 'accepted', '离线接受');
  // 在线窗口推进基线 5.7.0 -> 5.8.0
  store.updateProject(pid, {
    name: store.projectById(pid)!.name,
    modelCode: 'PHV-M9',
    vehicleType: 'M1',
    configuration: '七座旗舰版',
    maintenanceVersion: 'MY26.2',
    softwareVersion: '5.8.0',
    applicant: '北辰汽车',
    agency: '华南认证中心',
    certificateExpiry: store.projectById(pid)!.certificateExpiry
  }, '在线窗口紧急升级基线');
  check('在线基线已为 5.8.0', store.projectById(pid)!.softwareVersion === '5.8.0');
  const result = store.commitReviewBatch(bid);
  check('合并成功', result.ok);
  check('基线仍是在线 5.8.0，不被旧包覆盖', store.projectById(pid)!.softwareVersion === '5.8.0');
  check('离线证据审阅被采纳', store.projectById(pid)!.audit.some((e) => e.action === '离线复核回网合并'));
}

console.log('场景 3：同一证据两边改过 → 留两版待复核，取版后归一');
{
  const store = freshStore();
  const pid = 'TA-2026-118';
  const bid = store.checkoutBatch(pid, '审阅人甲', '双改冲突');
  const logicalId = 'EV-118-01';
  // 离线改
  store.offlineSetEvidence(bid, logicalId, 'rejected', '离线判定拒绝');
  // 在线改（不同结论）
  store.updateEvidence(pid, 'EV-118-01', 'resubmit', '在线窗口要求重新抽样');
  const result = store.commitReviewBatch(bid);
  check('合并成功', result.ok);
  const batch = store.batches.find((b) => b.id === bid)!;
  check('批次进入两版待复核', batch.status === 'awaiting_review');
  const conflictPairs = store.projectById(pid)!.evidence.filter((e) => e.logicalId === logicalId);
  check('同一证据保留两版', conflictPairs.length === 2, `实际 ${conflictPairs.length}`);
  check('两版共享 conflictGroupId', new Set(conflictPairs.map((e) => e.conflictGroupId)).size === 1);
  check('两版分别标记 online/offline',
    conflictPairs.some((e) => e.conflictSide === 'online') && conflictPairs.some((e) => e.conflictSide === 'offline'));
  check('两版状态均为 resubmit', conflictPairs.every((e) => e.status === 'resubmit'));
  // 提交包阻断
  check('仍有未决冲突', batch.unresolvedConflictGroupIds.length === 1);
  // 取在线版
  const groupId = batch.unresolvedConflictGroupIds[0];
  const resolveResult = store.resolveBatchConflict(bid, groupId, 'online');
  check('取版成功', resolveResult.ok);
  const remaining = store.projectById(pid)!.evidence.filter((e) => e.logicalId === logicalId);
  check('取版后只剩一版', remaining.length === 1, `实际 ${remaining.length}`);
  check('留下的是在线版', remaining[0].conflictSide === undefined && remaining[0].note.includes('在线'));
  check('批次归档为 merged', store.batches.find((b) => b.id === bid)!.status === 'merged');
  check('冲突标记已清除', store.projectById(pid)!.evidence.every((e) => !e.conflictGroupId));
}

console.log('场景 4：软件版本一改 → 证据失效重算、法规覆盖与补件队列更新');
{
  const store = freshStore();
  const pid = 'TA-2026-118';
  // 在线基线升级
  store.updateProject(pid, {
    name: store.projectById(pid)!.name,
    modelCode: 'EVS-27',
    vehicleType: 'M1',
    configuration: '长续航四驱版',
    maintenanceVersion: 'MY27.1',
    softwareVersion: '8.5.0',
    applicant: '远航汽车工程部',
    agency: '华东认证中心',
    certificateExpiry: store.projectById(pid)!.certificateExpiry
  }, '软件升级到 8.5.0');
  const project = store.projectById(pid)!;
  const stale = project.evidence.filter((e) => e.staleAt);
  check('旧版证据全部失效', stale.length === project.evidence.length, `失效 ${stale.length}/${project.evidence.length}`);
  check('原本 accepted 的证据失效后置为 resubmit',
    project.evidence.filter((e) => ['EV-118-01', 'EV-118-04'].includes(e.id)).every((e) => e.status === 'resubmit'));
  check('失效原因记录新旧基线', stale.every((e) => (e.staleReason ?? '').includes('8.5.0')));
  check('补件队列包含失效证据', store.pendingSupplements(pid).length === project.evidence.length);
  const regs = project.regulations;
  check('法规覆盖重算出现冲突/缺失', regs.some((r) => r.status !== 'complete'));
  check('法规 issues 含失效说明', regs.some((r) => r.issues.some((i) => i.includes('失效'))));
  // 补件后恢复
  const ids = store.pendingSupplements(pid).map((e) => e.id);
  const n = store.bulkSupplement(pid, ids, '已按 8.5.0 完成全部重测并覆盖配置');
  check('批量补件全部处理', n === ids.length);
  check('补件后无失效标记', store.projectById(pid)!.evidence.every((e) => !e.staleAt));
}

console.log('场景 5：冻结项目只读，旧包回网整体作废不覆盖');
{
  const store = freshStore();
  const pid = 'TA-2026-092'; // approved seed
  let blocked = false;
  try {
    store.transition(pid, 'rejected', 'x', 'y');
  } catch {
    blocked = true;
  }
  check('在线写操作被冻结拦截', blocked);
  blocked = false;
  try {
    store.updateEvidence(pid, 'EV-092-01', 'rejected', '试图改冻结证据');
  } catch {
    blocked = true;
  }
  check('证据修改被冻结拦截', blocked);
  // 直接构造一个基于该项目检出时未冻结、回网时已冻结的批次
  const frozenProject = store.projectById(pid)!;
  const base = snapshotWorkset(frozenProject);
  const offline = structuredClone(base);
  offline.project.softwareVersion = '9.9.9';
  offline.audit.unshift({ id: 'AUD-OFF-1', actor: '甲', action: '离线修改', detail: '改基线', createdAt: '2026-10-01T00:00:00.000Z', offline: true });
  const batch: ReviewBatch = {
    id: 'BAT-FROZEN', projectId: pid, label: '冻结包', reviewer: '甲',
    status: 'checked_out', createdAt: '2026-09-01T00:00:00.000Z', checkedOutAt: '2026-09-01T00:00:00.000Z',
    base, offline, unresolvedConflictGroupIds: []
  };
  store.batches.push(batch);
  const result = store.commitReviewBatch('BAT-FROZEN');
  check('冻结项目提交返回成功（作废而非报错）', result.ok);
  check('批次作废 voided', store.batches.find((b) => b.id === 'BAT-FROZEN')!.status === 'voided');
  check('在线基线未被覆盖', store.projectById(pid)!.softwareVersion === '3.2.4');
  check('在线审计未被离线记录污染', store.projectById(pid)!.audit.every((e) => e.detail !== '改基线'));
}

console.log('场景 6：写入失败 → WAL 保留提交前状态 → 按完整批次恢复重试');
{
  const store = freshStore();
  const pid = 'TA-2026-118';
  const beforeStatus = store.projectById(pid)!.status;
  const bid = store.checkoutBatch(pid, '审阅人甲', '失败恢复');
  store.offlinePatch(bid, { status: 'submitted' }, '离线提交');
  const first = store.commitReviewBatch(bid, { simulateFirstFailure: true });
  check('首次提交报告失败', !first.ok && (first.error ?? '').includes('恢复重试'));
  check('WAL 已落盘', !!store.wal && store.wal.batchId === bid);
  check('在线数据仍是提交前状态', store.projectById(pid)!.status === beforeStatus);
  check('批次仍是 checked_out（未半成品覆盖）', store.batches.find((b) => b.id === bid)!.status === 'checked_out');
  const retry = store.retryPendingCommit();
  check('恢复重试成功', retry.ok, retry.error);
  check('WAL 清除', store.wal === null);
  check('离线改动在重试后生效', store.projectById(pid)!.status === 'submitted');
  const finalBatch = store.batches.find((b) => b.id === bid)!;
  check('报告标记 recoveredFromFailure', finalBatch.report?.recoveredFromFailure === true);
  check('尝试次数为 2', finalBatch.commitAttempts === 2);
}

console.log('场景 7：离线新增证据 + 在线新增证据并存，互不覆盖');
{
  const store = freshStore();
  const pid = 'TA-2026-118';
  const bid = store.checkoutBatch(pid, '审阅人甲', '各自新增');
  store.offlineAddEvidence(bid, {
    regulationId: 'REG-BRAKE', name: '离线补充制动说明', type: 'exemption',
    version: 'O1', configurations: ['长续航四驱版'], note: '离线新增'
  });
  // 在线也加一个（模拟另一窗口）
  const project = store.projectById(pid)!;
  const newId = `EV-ONLINE-${Date.now()}`;
  project.evidence.push({
    id: newId, logicalId: newId, projectId: pid, regulationId: 'REG-EMC',
    name: '在线新增 EMC 复测', type: 'test_report', version: 'N1',
    softwareVersion: project.softwareVersion, configurations: ['长续航四驱版'],
    status: 'submitted', note: '在线窗口新增', updatedAt: new Date().toISOString()
  });
  store.persist();
  const result = store.commitReviewBatch(bid);
  check('合并成功', result.ok);
  check('离线新增证据在', store.projectById(pid)!.evidence.some((e) => e.name === '离线补充制动说明'));
  check('在线新增证据也在', store.projectById(pid)!.evidence.some((e) => e.name === '在线新增 EMC 复测'));
  check('无冲突组', result.batch?.report?.conflictGroups.length === 0);
}

console.log('场景 8：离线删除、在线修改同一证据 → 保留在线版挂起');
{
  const store = freshStore();
  const pid = 'TA-2026-118';
  const bid = store.checkoutBatch(pid, '审阅人甲', '删改分叉');
  const logicalId = 'EV-118-04';
  store.offlineDeleteEvidence(bid, logicalId);
  store.updateEvidence(pid, 'EV-118-04', 'resubmit', '在线窗口改了结论');
  const result = store.commitReviewBatch(bid);
  check('合并成功', result.ok);
  const survivors = store.projectById(pid)!.evidence.filter((e) => e.logicalId === logicalId);
  check('保留一版（在线）待复核', survivors.length === 1 && survivors[0].conflictSide === 'online');
  check('批次等待复核', result.batch?.status === 'awaiting_review');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) process.exit(1);
