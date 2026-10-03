<script setup lang="ts">
import { useCertificationStore } from '~/stores/certification';
import type { ConflictKind, DualRevisionChoice, OfflinePackage, WriteFailureMode } from '~/types/certification';

const store = useCertificationStore();
onMounted(() => store.hydrate());

const exporter = ref('离线审阅员');
const report = computed(() => store.lastMergeReport);
const fileError = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

const conflictKindLabels: Record<ConflictKind, string> = {
  evidence_dual_revision: '同一证据两边改动·双版本',
  frozen_project_readonly: '冻结项目只读拦截',
  online_change_protected: '在线改动受保护',
  stale_baseline: '基线漂移·失效重算'
};

function download(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/* ---------------- 真实离线包往返 ---------------- */
function exportReal() {
  fileError.value = '';
  const pkg = store.exportOfflinePackage(exporter.value);
  download(pkg, `offline-review-${pkg.batchId}.json`);
}

function onImportFile(event: Event) {
  fileError.value = '';
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const pkg = JSON.parse(String(reader.result)) as OfflinePackage;
      if (pkg.kind !== 'vehicle-type-approval-offline-review') {
        throw new Error('文件不是本平台的离线复核包');
      }
      const result = store.mergeOfflinePackage(pkg);
      if (!result) fileError.value = '合并批次写入失败，已按完整批次保留，请在上方红色条中重试。';
    } catch (error) {
      fileError.value = error instanceof Error ? error.message : '离线包解析失败';
    } finally {
      input.value = '';
    }
  };
  reader.readAsText(file);
}

/* ---------------- 一键演练 ---------------- */
const scenario = ref<'dual' | 'baseline' | 'frozen'>('dual');
function runDemo() {
  fileError.value = '';
  // 一步完成：在线窗口先改 → 离线包（基线快照固定在线改动之前）施加离线改动 → 立即回网
  const pkg = store.stageOfflineDemo(scenario.value, exporter.value);
  if (!pkg) {
    fileError.value = '演练前置写入失败，请先在红色提示条中恢复待提交批次。';
    return;
  }
  const result = store.mergeOfflinePackage(pkg);
  if (!result) fileError.value = '合并批次写入失败，已按完整批次保留待重试。';
}

/* ---------------- 冲突裁定 ---------------- */
function resolve(id: string, choice: DualRevisionChoice) {
  store.resolveEvidenceConflict(id, choice, '认证机构审阅人');
}
function acknowledge(id: string) {
  store.acknowledgeConflict(id, '认证机构审阅人');
}

/* ---------------- 故障注入 ---------------- */
const failureModes: { label: string; value: WriteFailureMode; hint: string }[] = [
  { label: '正常写入', value: 'none', hint: '批次直接落盘' },
  { label: '下一次写入中断', value: 'fail_once', hint: 'WAL 已写、主文档未更新，刷新后可按完整批次恢复' },
  { label: '持续写入失败', value: 'fail_always', hint: '所有写入停在恢复区，切回正常后重试' }
];
function setFailureMode(mode: WriteFailureMode) {
  store.setFailureMode(mode);
}

function resetAll() {
  if (confirm('确定重置全部批次与本地数据，回到种子基线？')) store.reset();
}

const conflictCountByKind = (kind: ConflictKind) =>
  store.activeBatch.conflicts.filter((item) => item.kind === kind && item.status === 'pending').length;
</script>

<template>
  <div class="mb-6">
    <h1 class="text-2xl font-semibold">复核批次与离线回网控制台</h1>
    <p class="mt-1 text-sm text-slate-600">
      认证项目、证据文件、法规项目和审计记录同属一份可续作批次；离线改动按基线和证据版本合并，同一证据两边改过保留双版本待复核。
    </p>
  </div>

  <BatchBanner />
  <div v-if="fileError" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ fileError }}</div>

  <!-- 合并报告 -->
  <section v-if="report" class="mb-6 border border-teal-200 bg-white p-5">
    <h2 class="font-semibold">最近一次离线回网合并报告</h2>
    <p class="mt-1 text-xs text-slate-500">新批次 {{ report.batchId }}（父批次 {{ report.parentBatchId }}）· {{ report.mergedAt.slice(0, 16).replace('T', ' ') }}</p>
    <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="border border-slate-200 p-3">
        <p class="text-xs text-slate-500">在线单边改动保留</p>
        <p class="metric-value text-2xl font-semibold">{{ report.onlineOnlyChanges }}</p>
      </div>
      <div class="border border-slate-200 p-3">
        <p class="text-xs text-slate-500">离线单边改动并入</p>
        <p class="metric-value text-2xl font-semibold">{{ report.offlineOnlyChanges }}</p>
      </div>
      <div class="border border-amber-200 bg-amber-50 p-3">
        <p class="text-xs text-amber-800">同证据两边改·双版本</p>
        <p class="metric-value text-2xl font-semibold text-amber-900">{{ report.dualRevisionEvidence }}</p>
      </div>
      <div class="border border-slate-200 p-3">
        <p class="text-xs text-slate-500">离线新增证据</p>
        <p class="metric-value text-2xl font-semibold">{{ report.offlineEvidenceAdded }}</p>
      </div>
      <div class="border border-red-200 bg-red-50 p-3">
        <p class="text-xs text-red-800">基线变更失效重算证据</p>
        <p class="metric-value text-2xl font-semibold text-red-900">{{ report.invalidatedEvidence }}</p>
      </div>
      <div class="border border-green-200 bg-green-50 p-3">
        <p class="text-xs text-green-800">冻结项目离线改动拦截</p>
        <p class="metric-value text-2xl font-semibold text-green-900">{{ report.frozenSkipped }}</p>
      </div>
      <div class="border border-slate-200 p-3">
        <p class="text-xs text-slate-500">离线包覆盖项目</p>
        <p class="metric-value text-2xl font-semibold">{{ report.offlineProjects }}</p>
      </div>
      <div class="border border-amber-200 p-3">
        <p class="text-xs text-slate-500">待复核冲突</p>
        <p class="metric-value text-2xl font-semibold">{{ report.conflicts.filter((item) => item.status === 'pending').length }}</p>
      </div>
    </div>
  </section>

  <div class="grid gap-6 xl:grid-cols-2">
    <!-- 离线包演练 -->
    <section class="border border-slate-200 bg-white p-5">
      <h2 class="font-semibold">离线复核包演练</h2>
      <p class="mt-1 text-xs text-slate-500">
        离线包嵌入导出时刻基线快照与指纹；回网做「在线 / 离线 / 基线」三方合并，旧包不会覆盖另一窗口刚改的状态与软件基线。
      </p>

      <div class="mt-4 space-y-3">
        <UFormGroup label="离线审阅人">
          <UInput v-model="exporter" />
        </UFormGroup>

        <div class="rounded-md border border-slate-200 p-4">
          <p class="text-sm font-medium">真实往返（可断网后编辑再带回）</p>
          <p class="mt-1 text-xs text-slate-500">导出 JSON 离线复核包，在外部修改后通过文件选择器导回合并。</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <UButton size="sm" color="primary" variant="soft" @click="exportReal">导出离线复核包</UButton>
            <UButton size="sm" color="primary" @click="fileInput?.click()">导回离线包并合并</UButton>
            <input ref="fileInput" type="file" accept="application/json,.json" class="hidden" @change="onImportFile" />
          </div>
        </div>

        <div class="rounded-md border border-amber-200 bg-amber-50/60 p-4">
          <p class="text-sm font-medium">一键场景演练（无需外部编辑）</p>
          <UFormGroup label="演练场景" class="mt-2">
            <USelect
              v-model="scenario"
              :options="[
                { label: '同一证据两边都改 → 保留双版本待复核', value: 'dual' },
                { label: '在线窗口已升软件基线 → 旧包证据失效重算', value: 'baseline' },
                { label: '离线包改了冻结项目 → 只读拦截', value: 'frozen' }
              ]"
            />
          </UFormGroup>
          <p class="mt-2 text-xs text-amber-900">
            演练会先在「另一窗口」制造在线改动，再生成含离线改动的复核包并立即回网。
          </p>
          <UButton size="sm" color="amber" class="mt-3" @click="runDemo">制造两端改动并回网合并</UButton>
        </div>
      </div>
    </section>

    <!-- 故障注入与恢复 -->
    <section class="border border-slate-200 bg-white p-5">
      <h2 class="font-semibold">写入失败 · 完整批次恢复重试</h2>
      <p class="mt-1 text-xs text-slate-500">
        所有写入先把完整批次落入恢复区（WAL）再提交主文档；失败时内存视图不前进，列表/详情/提交包仍读有效批次，重试按同一份完整批次进行。
      </p>
      <div class="mt-4 space-y-2">
        <label
          v-for="mode in failureModes"
          :key="mode.value"
          class="flex cursor-pointer items-start gap-3 border border-slate-200 p-3"
          :class="store.failureMode === mode.value ? 'ring-2 ring-teal-500' : ''"
        >
          <input
            type="radio"
            class="mt-1"
            :checked="store.failureMode === mode.value"
            @change="setFailureMode(mode.value)"
          />
          <span>
            <span class="block text-sm font-medium">{{ mode.label }}</span>
            <span class="mt-1 block text-xs text-slate-500">{{ mode.hint }}</span>
          </span>
        </label>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <UButton size="sm" variant="soft" @click="store.selfCheckCommit()">写一次自检批次</UButton>
        <UButton size="sm" color="red" variant="ghost" @click="resetAll">重置为种子批次</UButton>
      </div>
      <p class="mt-3 text-xs text-slate-500">
        提示：制造「下一次写入中断」后点击任意写操作，再刷新页面，可看到从恢复区检出的完整批次提示。
      </p>
    </section>
  </div>

  <!-- 冲突队列 -->
  <section class="mt-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">合并冲突复核队列</h2>
      <p class="mt-1 text-xs text-slate-500">
        {{ conflictCountByKind('evidence_dual_revision') }} 项双版本 ·
        {{ conflictCountByKind('frozen_project_readonly') }} 项冻结拦截 ·
        {{ conflictCountByKind('online_change_protected') }} 项在线保护 ·
        {{ conflictCountByKind('stale_baseline') }} 项基线漂移
      </p>
    </div>
    <div class="divide-y divide-slate-200">
      <article v-for="conflict of store.activeBatch.conflicts" :key="conflict.id" class="p-4" :class="conflict.status === 'resolved' ? 'opacity-60' : ''">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
              <UBadge :color="conflict.status === 'pending' ? 'amber' : 'green'" variant="soft">
                {{ conflict.status === 'pending' ? '待复核' : '已处理' }}
              </UBadge>
              {{ conflictKindLabels[conflict.kind] }}
              <span class="text-slate-400">{{ conflict.projectId }} · {{ conflict.projectName }}</span>
              <span v-if="conflict.evidenceName" class="text-slate-600">《{{ conflict.evidenceName }}》</span>
            </p>
            <div class="mt-2 grid gap-2 text-sm md:grid-cols-2">
              <div class="border border-slate-200 bg-slate-50 p-2">
                <p class="text-xs font-semibold text-slate-500">在线窗口</p>
                <p class="mt-1">{{ conflict.onlineSummary }}</p>
              </div>
              <div class="border border-violet-200 bg-violet-50 p-2">
                <p class="text-xs font-semibold text-violet-700">离线复核包</p>
                <p class="mt-1">{{ conflict.offlineSummary }}</p>
              </div>
            </div>
            <p v-if="conflict.resolution" class="mt-2 text-xs text-green-800">裁定：{{ conflict.resolution }} · {{ conflict.resolvedAt?.slice(0, 16).replace('T', ' ') }}</p>
          </div>
          <div v-if="conflict.status === 'pending'" class="flex shrink-0 flex-wrap gap-2">
            <template v-if="conflict.kind === 'evidence_dual_revision'">
              <UButton size="xs" color="blue" variant="soft" @click="resolve(conflict.id, 'online')">采用在线版</UButton>
              <UButton size="xs" color="violet" variant="soft" @click="resolve(conflict.id, 'offline')">采用离线版</UButton>
              <UButton size="xs" color="amber" variant="soft" @click="resolve(conflict.id, 'both')">两版并存</UButton>
            </template>
            <UButton v-else size="xs" color="primary" variant="soft" @click="acknowledge(conflict.id)">已知悉并确认</UButton>
          </div>
        </div>
      </article>
      <p v-if="!store.activeBatch.conflicts.length" class="py-10 text-center text-sm text-slate-500">当前批次暂无合并冲突。</p>
    </div>
  </section>

  <!-- 批次档案 -->
  <section class="mt-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">可续作批次档案</h2>
      <p class="mt-1 text-xs text-slate-500">任一时刻只有一份 active；旧批次只读留档，可恢复为有效批次继续复核。</p>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[900px]">
        <thead>
          <tr>
            <th>批次</th>
            <th>状态</th>
            <th>父批次</th>
            <th>生成时间</th>
            <th>项目 / 冲突</th>
            <th>基线指纹</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in store.batchHistory" :key="batch.meta.id">
            <td>
              <p class="font-mono text-xs">{{ batch.meta.id }}</p>
              <p class="mt-1 text-sm">{{ batch.meta.label }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ batch.meta.actor }} · {{ batch.meta.note }}</p>
            </td>
            <td>
              <UBadge :color="batch.meta.status === 'active' ? 'green' : 'gray'" variant="soft">
                {{ batch.meta.status === 'active' ? '有效' : '已归档' }}
              </UBadge>
            </td>
            <td class="font-mono text-xs text-slate-500">{{ batch.meta.parentBatchId ?? '—' }}</td>
            <td class="text-xs">{{ batch.meta.createdAt.slice(0, 16).replace('T', ' ') }}</td>
            <td class="text-sm">{{ batch.projects.length }} 项 / {{ batch.meta.conflictsPending }} 待决</td>
            <td class="font-mono text-xs text-slate-500">{{ batch.meta.baselineToken.slice(0, 10) }}</td>
            <td>
              <UButton
                v-if="batch.meta.status !== 'active'"
                size="xs"
                color="primary"
                variant="soft"
                @click="store.resumeBatch(batch.meta.id)"
              >恢复为有效批次</UButton>
              <span v-else class="text-xs text-green-700">列表/详情/提交包均读取此批次</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
