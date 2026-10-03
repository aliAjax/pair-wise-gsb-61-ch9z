<script setup lang="ts">
import { batchStatusLabels } from '~/types/certification';
import type { BatchProjectFields, EvidenceItem, EvidenceStatus, OfflinePackage } from '~/types/certification';
import { useCertificationStore } from '~/stores/certification';

const route = useRoute();
const store = useCertificationStore();
const batchId = String(route.params.id);
const message = ref('');
const error = ref('');
const simulateFailure = ref(true);

const batch = computed(() => store.batches.find((item) => item.id === batchId));
const onlineProject = computed(() => (batch.value ? store.projectById(batch.value.projectId) : undefined));

const offlineStatusOptions: EvidenceStatus[] = ['submitted', 'accepted', 'rejected', 'resubmit', 'missing'];

const fieldEdit = reactive({
  softwareVersion: '',
  maintenanceVersion: '',
  configuration: '',
  status: 'under_review' as string,
  reviewer: ''
});
const fieldReason = ref('');

const newEvidence = reactive({
  regulationId: '',
  name: '',
  type: 'test_report' as EvidenceItem['type'],
  version: '',
  configurations: '',
  note: ''
});

const fileInput = ref<HTMLInputElement | null>(null);

const evidenceTypeOptions = [
  { label: '测试报告', value: 'test_report' },
  { label: '部件清单', value: 'part_list' },
  { label: '软件报告', value: 'software_report' },
  { label: '豁免材料', value: 'exemption' },
  { label: '证书', value: 'certificate' }
];

const fieldLabels: Record<string, string> = {
  softwareVersion: '软件基线',
  maintenanceVersion: '维护版本',
  configuration: '申报配置',
  status: '审批状态',
  reviewer: '审阅人',
  name: '项目名称'
};

const statusLabelsCn: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  under_review: '审阅中',
  supplement_required: '待补件',
  approved: '已批准',
  rejected: '已拒绝'
};

watch(
  batch,
  (value) => {
    if (!value) return;
    fieldEdit.softwareVersion = value.offline.project.softwareVersion;
    fieldEdit.maintenanceVersion = value.offline.project.maintenanceVersion;
    fieldEdit.configuration = value.offline.project.configuration;
    fieldEdit.status = value.offline.project.status;
    fieldEdit.reviewer = value.offline.project.reviewer;
    if (!newEvidence.regulationId && onlineProject.value?.regulations[0]) {
      newEvidence.regulationId = onlineProject.value.regulations[0].id;
    }
  },
  { immediate: true }
);

const regulationOptions = computed(() =>
  (onlineProject.value?.regulations ?? []).map((regulation) => ({
    label: `${regulation.code} · ${regulation.title}`,
    value: regulation.id
  }))
);

function applyFieldEdit() {
  message.value = '';
  error.value = '';
  if (!batch.value) return;
  if (!fieldReason.value.trim()) {
    error.value = '请填写离线修改原因，供审计留痕。';
    return;
  }
  try {
    store.offlinePatch(
      batchId,
      {
        softwareVersion: fieldEdit.softwareVersion.trim(),
        maintenanceVersion: fieldEdit.maintenanceVersion.trim(),
        configuration: fieldEdit.configuration.trim(),
        status: fieldEdit.status as BatchProjectFields['status'],
        reviewer: fieldEdit.reviewer.trim()
      },
      fieldReason.value
    );
    fieldReason.value = '';
    message.value = '离线工作集已更新；基线变更已联动失效重算。';
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '离线修改失败。';
  }
}

function setEvidence(logicalId: string, event: Event) {
  if (!batch.value) return;
  const status = (event.target as HTMLSelectElement).value as EvidenceStatus;
  store.offlineSetEvidence(batchId, logicalId, status, `离线复核标记为${statusLabelsCn[status] ?? status}`);
  message.value = '离线证据状态已记录。';
}

function addEvidence() {
  message.value = '';
  error.value = '';
  if (!batch.value) return;
  if (newEvidence.name.trim().length < 2 || !newEvidence.version.trim()) {
    error.value = '请填写证据名称与文件版本。';
    return;
  }
  try {
    store.offlineAddEvidence(batchId, {
      regulationId: newEvidence.regulationId,
      name: newEvidence.name.trim(),
      type: newEvidence.type,
      version: newEvidence.version.trim(),
      configurations: newEvidence.configurations
        .split(/[、,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
      note: newEvidence.note.trim()
    });
    newEvidence.name = '';
    newEvidence.version = '';
    newEvidence.configurations = '';
    newEvidence.note = '';
    message.value = '证据已加入离线复核工作集。';
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '新增证据失败。';
  }
}

function removeEvidence(logicalId: string) {
  store.offlineDeleteEvidence(batchId, logicalId);
  message.value = '证据已在离线工作集中标记删除。';
}

function exportPackage() {
  message.value = '';
  error.value = '';
  try {
    const payload = store.buildOfflinePackage(batchId);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `offline-review-${batchId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.value = '离线复核包已导出，可断网带走。';
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '导出失败。';
  }
}

async function importPackage(event: Event) {
  message.value = '';
  error.value = '';
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text) as OfflinePackage;
    store.importOfflinePackage(payload);
    message.value = `离线包已导入（导出于 ${payload.exportedAt.slice(0, 16).replace('T', ' ')}），可以回网提交合并。`;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '离线包解析失败。';
  } finally {
    if (fileInput.value) fileInput.value.value = '';
  }
}

function commit() {
  message.value = '';
  error.value = '';
  const result = store.commitReviewBatch(batchId, { simulateFirstFailure: simulateFailure.value });
  if (result.ok) {
    if (result.batch?.status === 'awaiting_review') {
      message.value = '合并完成：存在两版证据，请在下方逐组复核取版。';
    } else if (result.batch?.status === 'voided') {
      message.value = '在线项目已冻结，离线包只读，批次作废，在线数据未被覆盖。';
    } else {
      message.value = '回网合并成功，已按当前基线重算证据与法规覆盖。';
    }
  } else {
    error.value = result.error ?? '批次写入失败。';
  }
}

function retryWal() {
  message.value = '';
  error.value = '';
  const result = store.retryPendingCommit();
  if (result.ok) message.value = '已按完整批次恢复并重试提交成功。';
  else error.value = result.error ?? '恢复重试失败。';
}

function resolve(groupId: string, keep: 'online' | 'offline') {
  message.value = '';
  error.value = '';
  const result = store.resolveBatchConflict(batchId, groupId, keep);
  if (result.ok) message.value = keep === 'online' ? '已采用在线版，另一版作废。' : '已采用离线版，另一版作废。';
  else error.value = result.error ?? '取版失败。';
}

function abandon() {
  store.abandonBatch(batchId);
  message.value = '批次已放弃，离线改动不回写。';
}

onMounted(() => store.hydrate());
</script>

<template>
  <div v-if="!batch" class="border border-red-200 bg-red-50 p-6 text-red-900">
    未找到复核批次 {{ batchId }}。
    <NuxtLink to="/batches" class="ml-2 underline">返回批次列表</NuxtLink>
  </div>

  <template v-else>
    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <NuxtLink to="/batches" class="text-sm text-teal-700 hover:underline">返回复核批次</NuxtLink>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-semibold">{{ batch.id }}</h1>
          <UBadge
            :color="batch.status === 'checked_out' ? 'blue' : batch.status === 'awaiting_review' ? 'amber' : batch.status === 'merged' ? 'green' : 'gray'"
            variant="soft"
          >
            {{ batchStatusLabels[batch.status] }}
          </UBadge>
        </div>
        <p class="mt-2 text-lg font-medium">{{ batch.label }}</p>
        <p class="mt-1 text-sm text-slate-500">
          项目
          <NuxtLink v-if="onlineProject" :to="`/projects/${batch.projectId}`" class="text-teal-700 hover:underline">
            {{ batch.projectId }} · {{ onlineProject.name }}
          </NuxtLink>
          <template v-else>{{ batch.projectId }}（项目已不存在）</template>
          · 审阅人 {{ batch.reviewer }}
        </p>
      </div>
      <div v-if="onlineProject?.status === 'approved'" class="border border-slate-300 bg-slate-100 p-4 text-sm text-slate-700">
        <p class="font-semibold">项目已冻结（approved）</p>
        <p class="mt-1">在线数据只读，本离线包回网时不会覆盖任何状态、基线或证据。</p>
      </div>
    </div>

    <section v-if="store.wal && store.wal.batchId === batchId" class="mb-5 border-2 border-red-300 bg-red-50 p-4">
      <p class="font-semibold text-red-950">本批次上次写入失败，预写日志保留中（第 {{ store.wal.attempts }} 次尝试）</p>
      <p class="mt-1 text-sm text-red-900">列表、详情和提交包仍只展示提交前的同一份有效数据，未被旧包部分覆盖。</p>
      <div class="mt-3 flex gap-2">
        <UButton color="red" size="sm" @click="retryWal">按完整批次恢复并重试</UButton>
      </div>
    </section>

    <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
    <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>

    <!-- 已合并/作废：合并报告 -->
    <section v-if="batch.report && ['awaiting_review', 'merged', 'voided'].includes(batch.status)" class="mb-6 space-y-5">
      <div class="border border-slate-200 bg-white p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-semibold">合并报告</h2>
          <span class="text-xs text-slate-500">{{ batch.report.mergedAt.slice(0, 16).replace('T', ' ') }}</span>
        </div>

        <div v-if="batch.report.onlineFrozen" class="mt-3 border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
          在线项目在回网前已批准冻结，整包只读作废，未写入任何改动。
        </div>

        <template v-else>
          <div v-if="batch.report.recoveredFromFailure" class="mt-3 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            本次为写入失败后的恢复重试：从完整批次基线重新合并，第 {{ batch.report.attempts }} 次尝试成功。
          </div>

          <div class="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div class="border border-slate-200 p-3">
              <p class="text-xs text-slate-500">采纳离线证据</p>
              <p class="metric-value mt-1 text-xl font-semibold">{{ batch.report.appliedOfflineEvidence.length }}</p>
            </div>
            <div class="border border-slate-200 p-3">
              <p class="text-xs text-slate-500">保留在线证据</p>
              <p class="metric-value mt-1 text-xl font-semibold">{{ batch.report.keptOnlineEvidence.length }}</p>
            </div>
            <div class="border border-slate-200 p-3">
              <p class="text-xs text-slate-500">两版待复核</p>
              <p class="metric-value mt-1 text-xl font-semibold text-amber-700">{{ batch.report.conflictGroups.length }}</p>
            </div>
            <div class="border border-slate-200 p-3">
              <p class="text-xs text-slate-500">基线失效重算</p>
              <p class="metric-value mt-1 text-xl font-semibold text-amber-700">{{ batch.report.staleEvidence.length }}</p>
            </div>
          </div>

          <div v-if="batch.report.baselineChanged" class="mt-4 border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
            软件基线 {{ batch.report.baselineFrom }} → {{ batch.report.baselineTo }}：受影响配置的法规覆盖与补件队列已按新基线重算。
          </div>

          <div v-if="batch.report.fieldMerges.length" class="mt-4 overflow-x-auto">
            <table class="data-table min-w-[720px]">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>检出基线</th>
                  <th>在线窗口</th>
                  <th>离线包</th>
                  <th>合并结果</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="record in batch.report.fieldMerges" :key="record.field">
                  <td class="font-medium">{{ record.label }}</td>
                  <td class="text-slate-500">{{ record.base ?? '—' }}</td>
                  <td :class="record.resolution === 'online' || record.resolution === 'both_online_wins' || record.resolution === 'baseline_moved' ? 'font-semibold text-teal-700' : ''">
                    {{ record.online ?? '—' }}
                  </td>
                  <td :class="record.resolution === 'offline' ? 'font-semibold text-teal-700' : ''">
                    {{ record.offline ?? '—' }}
                  </td>
                  <td>
                    {{ record.picked ?? '—' }}
                    <UBadge size="sm" color="gray" variant="soft" class="ml-2">
                      {{ record.resolution === 'offline' ? '采用离线' : record.resolution === 'online' ? '采用在线' : record.resolution === 'baseline_moved' ? '在线基线已推进' : record.resolution === 'both_online_wins' ? '两边都改·在线为准' : '一致' }}
                    </UBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <!-- 两版待复核取版 -->
      <div
        v-for="group in batch.report.conflictGroups"
        :key="group.id"
        class="border-2 border-amber-300 bg-white"
      >
        <div class="border-b border-amber-200 bg-amber-50 px-4 py-3">
          <h3 class="font-semibold text-amber-950">两版待复核 · {{ group.evidenceName }}</h3>
          <p class="mt-1 text-xs text-amber-800">{{ group.id }} · 法规 {{ group.regulationId }}</p>
        </div>
        <div class="grid gap-4 p-4 md:grid-cols-2">
          <div :class="['border p-4', group.online ? 'border-slate-300' : 'border-dashed border-slate-200 bg-slate-50']">
            <div class="flex items-center justify-between">
              <UBadge color="blue" variant="soft">在线窗口版本</UBadge>
              <UButton v-if="group.online" size="xs" color="blue" @click="resolve(group.id, 'online')">采用在线版</UButton>
            </div>
            <template v-if="group.online">
              <p class="mt-3 text-sm font-medium">{{ group.online.name }} · 文件 {{ group.online.version }}</p>
              <p class="mt-1 text-xs text-slate-500">软件 {{ group.online.softwareVersion }} · {{ group.online.configurations.join('、') }}</p>
              <p class="mt-2 text-sm text-slate-600">{{ group.online.note }}</p>
              <p class="mt-2 text-xs text-slate-400">{{ group.online.updatedAt.slice(0, 16).replace('T', ' ') }}</p>
            </template>
            <p v-else class="mt-3 text-sm text-slate-400">在线侧无此版本。</p>
          </div>
          <div :class="['border p-4', group.offline ? 'border-slate-300' : 'border-dashed border-slate-200 bg-slate-50']">
            <div class="flex items-center justify-between">
              <UBadge color="amber" variant="soft">离线包版本</UBadge>
              <UButton v-if="group.offline" size="xs" color="amber" @click="resolve(group.id, 'offline')">采用离线版</UButton>
            </div>
            <template v-if="group.offline">
              <p class="mt-3 text-sm font-medium">{{ group.offline.name }} · 文件 {{ group.offline.version }}</p>
              <p class="mt-1 text-xs text-slate-500">软件 {{ group.offline.softwareVersion }} · {{ group.offline.configurations.join('、') }}</p>
              <p class="mt-2 text-sm text-slate-600">{{ group.offline.note }}</p>
              <p class="mt-2 text-xs text-slate-400">{{ group.offline.updatedAt.slice(0, 16).replace('T', ' ') }}</p>
            </template>
            <p v-else class="mt-3 text-sm text-slate-400">离线侧无此版本。</p>
          </div>
        </div>
      </div>

      <!-- 失效重算清单 + 法规覆盖 -->
      <div v-if="!batch.report.onlineFrozen" class="grid gap-5 xl:grid-cols-2">
        <div class="border border-slate-200 bg-white p-5">
          <h3 class="font-semibold">软件基线失效重算（{{ batch.report.staleEvidence.length }}）</h3>
          <ul class="mt-3 space-y-2 text-sm">
            <li v-for="item in batch.report.staleEvidence" :key="item.id" class="border-l-2 border-amber-500 pl-3">
              <p class="font-medium">{{ item.name }} · 文件 {{ item.evidenceVersion }}</p>
              <p class="mt-1 text-xs text-slate-500">
                证据软件 {{ item.evidenceSoftwareVersion }} → 新基线 {{ item.baseline }}，已置待补件重算。
              </p>
            </li>
            <li v-if="!batch.report.staleEvidence.length" class="text-slate-400">本次合并没有失效证据。</li>
          </ul>
        </div>
        <div class="border border-slate-200 bg-white p-5">
          <h3 class="font-semibold">法规覆盖联动更新（{{ batch.report.regulationUpdates.length }}）</h3>
          <ul class="mt-3 space-y-2 text-sm">
            <li v-for="regulation in batch.report.regulationUpdates" :key="regulation.regulationId" class="border-l-2 border-slate-300 pl-3">
              <p class="font-medium">{{ regulation.code }} · {{ regulation.coverage }}% · {{ regulation.status === 'complete' ? '完整' : regulation.status === 'conflict' ? '冲突' : '缺失' }}</p>
              <p v-for="issue in regulation.issues" :key="issue" class="mt-1 text-xs text-amber-800">{{ issue }}</p>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 检出中：离线工作集编辑 -->
    <template v-if="batch.status === 'checked_out'">
      <section class="mb-6 grid gap-6 xl:grid-cols-2">
        <div class="border border-slate-200 bg-white p-5">
          <h2 class="font-semibold">离线修改项目基线与状态</h2>
          <p class="mt-1 text-xs text-slate-500">改动只写入离线工作集；软件版本一改，工作集内旧版证据立即失效待补件。</p>
          <div class="mt-4 grid gap-4 md:grid-cols-2">
            <UFormGroup label="软件基线">
              <UInput v-model="fieldEdit.softwareVersion" placeholder="8.4.2" />
            </UFormGroup>
            <UFormGroup label="维护版本">
              <UInput v-model="fieldEdit.maintenanceVersion" />
            </UFormGroup>
            <UFormGroup label="申报配置">
              <UInput v-model="fieldEdit.configuration" />
            </UFormGroup>
            <UFormGroup label="审批状态">
              <USelect
                v-model="fieldEdit.status"
                :options="[
                  { label: '草稿', value: 'draft' },
                  { label: '已提交', value: 'submitted' },
                  { label: '审阅中', value: 'under_review' },
                  { label: '待补件', value: 'supplement_required' },
                  { label: '已拒绝', value: 'rejected' }
                ]"
              />
            </UFormGroup>
            <UFormGroup label="审阅人">
              <UInput v-model="fieldEdit.reviewer" />
            </UFormGroup>
            <UFormGroup label="修改原因（审计留痕）">
              <UInput v-model="fieldReason" placeholder="例如：现场确认软件升级影响" />
            </UFormGroup>
          </div>
          <div class="mt-4">
            <UButton color="primary" @click="applyFieldEdit">写入离线工作集</UButton>
          </div>
        </div>

        <div class="border border-slate-200 bg-white p-5">
          <h2 class="font-semibold">离线包导出 / 回网导入</h2>
          <p class="mt-1 text-xs text-slate-500">导出后可断网带走；回网导入时校验检出基线，提交时与在线窗口三方合并。</p>
          <div class="mt-4 space-y-3 text-sm">
            <p>
              检出基线：<span class="font-mono">{{ batch.base.project.maintenanceVersion }} / SW {{ batch.base.project.softwareVersion }}</span>
            </p>
            <p>
              在线当前：
              <span class="font-mono" :class="onlineProject && onlineProject.softwareVersion !== batch.base.project.softwareVersion ? 'text-amber-700' : ''">
                {{ onlineProject?.maintenanceVersion }} / SW {{ onlineProject?.softwareVersion }}
              </span>
            </p>
            <p>
              离线工作集：<span class="font-mono">{{ batch.offline.project.maintenanceVersion }} / SW {{ batch.offline.project.softwareVersion }}</span>
            </p>
            <p v-if="batch.exportedAt" class="text-xs text-slate-500">上次导出：{{ batch.exportedAt.slice(0, 16).replace('T', ' ') }}</p>
          </div>
          <div class="mt-4 flex flex-wrap gap-3">
            <UButton color="primary" icon="i-heroicons-arrow-down-tray" @click="exportPackage">导出离线复核包</UButton>
            <label class="inline-flex cursor-pointer items-center rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50">
              回网导入离线包
              <input ref="fileInput" type="file" accept="application/json,.json" class="hidden" @change="importPackage" />
            </label>
          </div>
        </div>
      </section>

      <section class="mb-6 border border-slate-200 bg-white">
        <div class="border-b border-slate-200 px-4 py-3">
          <h2 class="font-semibold">离线证据复核（{{ batch.offline.evidence.length }}）</h2>
          <p class="mt-1 text-xs text-slate-500">
            在线版本：SW {{ onlineProject?.softwareVersion }}；离线工作集：SW {{ batch.offline.project.softwareVersion }}。
            与基线不一致的证据已标记失效重算。
          </p>
        </div>
        <div class="overflow-x-auto">
          <table class="data-table min-w-[1040px]">
            <thead>
              <tr>
                <th>证据文件</th>
                <th>文件 / 软件版本</th>
                <th>在线窗口状态</th>
                <th>离线状态</th>
                <th>失效</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in batch.offline.evidence" :key="item.logicalId">
                <td>
                  <p class="font-medium">{{ item.name }}</p>
                  <p class="mt-1 text-xs text-slate-500">{{ item.logicalId }} · {{ item.regulationId }}</p>
                </td>
                <td>
                  <p>{{ item.version }}</p>
                  <p class="mt-1 text-xs" :class="item.softwareVersion !== batch.offline.project.softwareVersion ? 'text-amber-700' : 'text-slate-500'">
                    SW {{ item.softwareVersion }}
                  </p>
                </td>
                <td>
                  <StatusBadge
                    v-if="onlineProject?.evidence.find((evidence) => evidence.logicalId === item.logicalId)"
                    :status="onlineProject.evidence.find((evidence) => evidence.logicalId === item.logicalId)!.status"
                  />
                  <span v-else class="text-xs text-slate-400">在线不存在</span>
                </td>
                <td>
                  <select
                    class="rounded border border-slate-300 px-2 py-1 text-sm"
                    :value="item.status"
                    @change="setEvidence(item.logicalId, $event)"
                  >
                    <option v-for="option in offlineStatusOptions" :key="option" :value="option">
                      {{ statusLabelsCn[option] }}
                    </option>
                  </select>
                </td>
                <td>
                  <UBadge v-if="item.staleAt || item.softwareVersion !== batch.offline.project.softwareVersion" color="amber" variant="soft">失效待补件</UBadge>
                  <span v-else class="text-xs text-slate-400">—</span>
                </td>
                <td>
                  <UButton size="xs" color="red" variant="ghost" @click="removeEvidence(item.logicalId)">离线删除</UButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="border-t border-slate-200 p-4">
          <h3 class="text-sm font-semibold">离线新增证据</h3>
          <div class="mt-3 grid gap-3 md:grid-cols-3">
            <UFormGroup label="法规项">
              <USelect v-model="newEvidence.regulationId" :options="regulationOptions" />
            </UFormGroup>
            <UFormGroup label="证据名称">
              <UInput v-model="newEvidence.name" placeholder="例如：照明系统补充测试报告" />
            </UFormGroup>
            <UFormGroup label="文件版本">
              <UInput v-model="newEvidence.version" placeholder="R2" />
            </UFormGroup>
            <UFormGroup label="类型">
              <USelect v-model="newEvidence.type" :options="evidenceTypeOptions" />
            </UFormGroup>
            <UFormGroup label="配置覆盖（顿号分隔）">
              <UInput v-model="newEvidence.configurations" :placeholder="batch.offline.project.configuration" />
            </UFormGroup>
            <UFormGroup label="说明">
              <UInput v-model="newEvidence.note" placeholder="离线补充的测试结论" />
            </UFormGroup>
          </div>
          <div class="mt-3">
            <UButton color="primary" variant="soft" @click="addEvidence">加入离线工作集</UButton>
          </div>
        </div>
      </section>

      <section class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">回网提交合并</h2>
        <p class="mt-1 text-xs text-slate-500">
          提交以检出基线、在线现状、离线工作集做三方合并；两边都改的证据保留两版。写入采用批次事务，失败后可按完整批次恢复重试。
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-4">
          <label class="flex items-center gap-2 text-sm text-slate-600">
            <input v-model="simulateFailure" type="checkbox" />
            模拟本次写入失败（演示预写日志恢复）
          </label>
          <UButton color="primary" size="lg" icon="i-heroicons-arrow-up-tray" @click="commit">回网提交并合并</UButton>
          <UButton color="gray" variant="ghost" @click="abandon">放弃批次</UButton>
        </div>
      </section>
    </template>
  </template>
</template>
