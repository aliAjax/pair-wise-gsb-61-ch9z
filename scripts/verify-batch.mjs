/* 复核批次引擎端到端演练（纯 Node，经 esbuild 即时转译 TS） */
import { build as esbuild } from 'esbuild';
import { writeFileSync } from 'node:fs';

const root = process.cwd() + '/';

const memory = {};
globalThis.localStorage = {
  getItem: (k) => (k in memory ? memory[k] : null),
  setItem: (k, v) => {
    memory[k] = String(v);
  },
  removeItem: (k) => {
    delete memory[k];
  },
  clear: () => {
    for (const k of Object.keys(memory)) delete memory[k];
  }
};

const bundled = await esbuild({
  entryPoints: ['./scripts/_engine-entry.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  alias: {
    '~': root
  }
});
writeFileSync('/tmp/engine-bundle.mjs', bundled.outputFiles[0].text);
const engine = await import('file:///tmp/engine-bundle.mjs');
const storage = engine.storage;
const { useStore } = engine;
const { setActivePinia, createPinia } = engine;
setActivePinia(createPinia());
const batchLogic = engine.engine;

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

console.log('\n[1] 初始文档：唯一有效批次 + 种子迁移');
const initial = storage.readDocument().document;
check('只有一份 active', initial.batches.filter((b) => b.meta.status === 'active').length === 1);
check('种子证据补齐 logicalId/origin', initial.batches[0].projects[0].evidence[0].logicalId);
useStore().hydrate();
check('store 读取到 4 个项目', useStore().projects.length === 4);
const targetId = 'TA-2026-118';
check('目标项目存在', !!useStore().projectById(targetId));

console.log('\n[2] 双版本冲突：同一证据两边都改 → 留两版待复核');
{
  const s = useStore();
  const before = s.activeBatch.meta.id;
  const pkg = s.stageOfflineDemo('dual', '离线审阅员');
  check('离线包生成', !!pkg);
  check('在线窗口已产生新批次', s.activeBatch.meta.id !== before);
  const onlineProject = s.projectById(targetId);
  const onlineEv = onlineProject.evidence.find((e) => e.id === 'EV-118-01');
  check('在线版证据为需重交', onlineEv.status === 'resubmit', onlineEv.status);
  check('离线包基线快照仍为旧状态（accepted）', (() => {
    const base = pkg.baseline.find((p) => p.id === targetId);
    return base.evidence.find((e) => e.id === 'EV-118-01').status === 'accepted';
  })());
  const offProj = pkg.projects.find((p) => p.id === targetId);
  check('离线侧改为 rejected', offProj.evidence.find((e) => e.id === 'EV-118-01').status === 'rejected');

  const report = s.mergeOfflinePackage(pkg);
  check('合并返回报告', !!report);
  check('报告记录 1 组双版本', report.dualRevisionEvidence === 1, String(report.dualRevisionEvidence));
  const merged = s.projectById(targetId);
  const groupRows = merged.evidence.filter((e) => e.conflictGroup);
  check('保留两条同组版本', groupRows.length === 2, String(groupRows.length));
  check('两版均待复核', groupRows.every((e) => e.pendingReview));
  check('在线版来源非 offline', groupRows.some((e) => e.origin !== 'offline'));
  check('离线版来源 offline', groupRows.some((e) => e.origin === 'offline'));
  check('双版本冲突入队', s.activeBatch.conflicts.some((c) => c.kind === 'evidence_dual_revision' && c.status === 'pending'));
  check('liveEvidence 同时含两版', batchLogic.liveEvidence(merged).filter((e) => e.conflictGroup).length === 2);
  check('法规覆盖被标缺失（待复核）', merged.regulations.find((r) => r.id === 'REG-BRAKE').status !== 'complete');

  console.log('\n[3] 裁定采用在线版：离线版留档弃用，覆盖重算');
  const conflict = s.activeBatch.conflicts.find((c) => c.kind === 'evidence_dual_revision');
  s.resolveEvidenceConflict(conflict.id, 'online', '刘珊');
  const after = s.projectById(targetId);
  const rowsAfter = after.evidence.filter((e) => e.conflictGroup === conflict.conflictGroup);
  check('采用后仅一条有效', batchLogic.liveEvidence(after).filter((e) => e.conflictGroup === conflict.conflictGroup).length === 1);
  check('离线版标记 superseded 但仍留档', rowsAfter.some((e) => e.superseded));
  check('冲突已决', s.activeBatch.conflicts.every((c) => c.status === 'resolved'));
}

console.log('\n[4] 软件基线一变 → 旧证据失效重算，法规覆盖与补件队列联动');
{
  const s = useStore();
  const project = s.projectById(targetId);
  const prev = project.softwareVersion;
  const input = {
    name: project.name,
    modelCode: project.modelCode,
    vehicleType: project.vehicleType,
    configuration: project.configuration,
    maintenanceVersion: project.maintenanceVersion,
    softwareVersion: prev === '8.4.2' ? '8.4.3' : '8.4.2',
    applicant: project.applicant,
    agency: project.agency,
    certificateExpiry: project.certificateExpiry
  };
  const ok = s.updateProject(targetId, input, '演练：升级软件基线', project.applicant);
  check('更新提交成功', ok);
  const after = s.projectById(targetId);
  const stale = after.evidence.filter((e) => e.softwareVersion !== after.softwareVersion && !e.superseded);
  check('落后基线的证据被标记失效', stale.length > 0 && stale.every((e) => e.invalidated), `stale=${stale.length}`);
  check('失效的已接受证据被打回需重交', stale.every((e) => e.status !== 'accepted' || !e.invalidated ? true : e.status === 'resubmit'));
  check('生成新版本记录', after.versions.some((v) => v.label.includes(after.softwareVersion)));
  check('审计含失效重算记录', after.audit.some((a) => a.action === '软件基线失效重算'));
  const regs = after.regulations;
  check('法规覆盖出现 conflict', regs.some((r) => r.status === 'conflict'));
  const reg = regs.find((r) => r.status === 'conflict');
  check('法规问题说明指向失效证据', reg.issues.some((i) => i.includes('失效待重算')));

  console.log('\n[5] 补件对齐基线 → 失效清除，覆盖回到完整');
  const beforeIds = new Set(after.evidence.filter((e) => e.invalidated && !e.superseded).map((e) => e.id));
  const n = s.bulkSupplement(targetId, [...beforeIds], '重新完成全部受影响配置的测试并对齐新软件基线');
  check('补件数量与失效项一致', n === beforeIds.size, `${n} vs ${beforeIds.size}`);
  const fixed = s.projectById(targetId);
  check('补件后无失效项', fixed.evidence.every((e) => !e.invalidated));
  check('补件证据软件版本对齐', batchLogic.liveEvidence(fixed).filter((e) => beforeIds.has(e.id)).every((e) => e.softwareVersion === fixed.softwareVersion));
}

console.log('\n[6] 冻结项目只读：离线改动回网被拒');
{
  const s = useStore();
  const frozenId = 'TA-2026-092';
  check('种子中 092 为 approved', s.projectById(frozenId).status === 'approved');
  const project = s.projectById(frozenId);
  const okEvidence = s.updateEvidence(frozenId, project.evidence[0].id, 'rejected', '试图拒绝冻结证据');
  check('在线拒绝冻结证据失败', okEvidence === false);
  const okTrans = s.transition(frozenId, 'rejected', 'x', 'y');
  check('冻结项目状态流转失败', okTrans === false);
  const pkg = s.stageOfflineDemo('frozen', '离线审阅员');
  const beforeStatus = s.projectById(frozenId).status;
  s.mergeOfflinePackage(pkg);
  const frozenAfter = s.projectById(frozenId);
  check('回网后冻结项目状态不变', frozenAfter.status === beforeStatus);
  check('回网后冻结软件版本不被旧包覆盖', frozenAfter.softwareVersion === '3.2.4');
  const c = s.activeBatch.conflicts.find((x) => x.kind === 'frozen_project_readonly' && x.projectId === frozenId);
  check('冻结拦截冲突入队', !!c);
}

console.log('\n[7] 写入失败：视图不前进 + 按完整批次恢复重试');
{
  const s = useStore();
  const activeBefore = s.activeBatch.meta.id;
  s.setFailureMode('fail_once');
  const ok = s.selfCheckCommit();
  check('写入返回失败', ok === false);
  check('内存视图仍停留在旧批次', s.activeBatch.meta.id === activeBefore);
  check('恢复态挂起', s.recovery.pending === true);
  check('待恢复文档已暂存', !!s.pendingDocument);
  const wal = storage.readDocument();
  check('存储层从 WAL 读到待提交完整批次', wal.source === 'wal');
  const retried = s.retryLastWrite();
  check('重试成功', retried === true);
  check('重试后新批次生效', s.activeBatch.meta.id !== activeBefore);
  check('恢复态解除', s.recovery.pending === false);
  const walGone = storage.readDocument().source === 'main';
  check('WAL 已清理', walGone);
}

console.log('\n[8] 旧批次留档可续作：恢复历史批次成为唯一有效');
{
  const s = useStore();
  const archived = s.batchHistory.find((b) => b.meta.status !== 'active');
  check('存在已归档批次', !!archived);
  const ok = s.resumeBatch(archived.meta.id);
  check('恢复成功', ok);
  check('恢复后只有一份 active', s.doc.batches.filter((b) => b.meta.status === 'active').length === 1);
  check('activeId 指向被恢复批次', s.doc.activeBatchId === archived.meta.id);
}

console.log('\n[9] 基线场景：在线已升软件基线，旧包回网不覆盖基线并联动失效');
{
  const s = useStore();
  s.reset();
  const before = s.projectById(targetId).softwareVersion;
  const pkg = s.stageOfflineDemo('baseline', '离线审阅员');
  check('在线窗口基线已升级', s.projectById(targetId).softwareVersion !== before);
  check('离线包基线快照仍是旧基线', pkg.baseline.find((p) => p.id === targetId).softwareVersion === before);
  const report = s.mergeOfflinePackage(pkg);
  check('合并完成', !!report);
  const after = s.projectById(targetId);
  check('有效基线保留为在线新版本', after.softwareVersion !== before);
  check('存在失效重算证据', batchLogic.liveEvidence(after).some((e) => e.invalidated));
  check('登记基线漂移冲突', s.activeBatch.conflicts.some((c) => c.kind === 'stale_baseline' && c.status === 'pending'));
  check('补件队列包含失效项', batchLogic.liveEvidence(after).filter((e) => e.invalidated).length >= 1);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
