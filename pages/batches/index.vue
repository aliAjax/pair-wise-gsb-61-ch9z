<script setup lang="ts">
import { batchStatusLabels } from '~/types/certification';
import type { BatchStatus } from '~/types/certification';
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
const router = useRouter();
const message = ref('');
const error = ref('');

const statusFilters: Array<{ label: string; value: BatchStatus | 'all' }> = [
  { label: '全部批次', value: 'all' },
  { label: '离线复核中', value: 'checked_out' },
  { label: '两版待复核', value: 'awaiting_review' },
  { label: '已合并归档', value: 'merged' },
  { label: '冻结作废', value: 'voided' },
  { label: '已放弃', value: 'abandoned' }
];
const filter = ref<BatchStatus | 'all'>('all');

const checkoutProject = ref('');
const checkoutLabel = ref('');
const checkoutReviewer = ref('');

const eligibleProjects = computed(() =>
  store.projects.filter((project) => project.status !== 'approved' && !store.activeBatchForProject(project.id))
);
const projectOptions = computed(() =>
  eligibleProjects.value.map((project) => ({ label: `${project.id} · ${project.name}（${project.status}）`, value: project.id }))
);

const rows = computed(() =>
  store.batches
    .filter((batch) => filter.value === 'all' || batch.status === filter.value)
    .map((batch) => ({
      batch,
      project: store.projectById(batch.projectId)
    }))
);

function statusColor(status: BatchStatus) {
  return status === 'checked_out'
    ? 'blue'
    : status === 'awaiting_review'
      ? 'amber'
      : status === 'merged'
        ? 'green'
        : 'gray';
}

function checkout() {
  message.value = '';
  error.value = '';
  if (!checkoutProject.value) {
    error.value = '请选择要检出的认证项目。';
    return;
  }
  try {
    const id = store.checkoutBatch(checkoutProject.value, checkoutReviewer.value || '认证机构审阅人', checkoutLabel.value);
    message.value = `批次 ${id} 已检出，可导出离线包开始复核。`;
    checkoutLabel.value = '';
    void router.push(`/batches/${id}`);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '检出失败。';
  }
}

function retryWal() {
  message.value = '';
  error.value = '';
  const result = store.retryPendingCommit();
  if (result.ok) {
    message.value = `批次写入已按完整批次恢复并重试成功（第 ${result.batch?.commitAttempts ?? 1} 次尝试）。`;
  } else {
    error.value = result.error ?? '恢复重试失败。';
  }
}

function discardWal() {
  store.wal = null;
  store.restoreWalPreState();
  message.value = '已放弃未完成写入并恢复到提交前批次状态。';
}

onMounted(() => store.hydrate());
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">离线复核批次</h1>
      <p class="mt-1 text-sm text-slate-600">
        检出基线、离线审阅、回网按基线与证据版本三方合并；同一证据两边改过则留两版待复核。
      </p>
    </div>
  </div>

  <section v-if="store.wal" class="mb-5 border-2 border-red-300 bg-red-50 p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="font-semibold text-red-950">检测到未完成的批次写入（预写日志）</p>
        <p class="mt-1 text-sm text-red-900">
          批次 {{ store.wal.batchId }} 上次写入中断（已尝试 {{ store.wal.attempts }} 次）。业务数据已保持在提交前状态，
          可按完整批次恢复并重试合并。
        </p>
      </div>
      <div class="flex gap-2">
        <UButton color="red" @click="retryWal">按完整批次恢复并重试</UButton>
        <UButton color="gray" variant="ghost" @click="discardWal">放弃该写入</UButton>
      </div>
    </div>
  </section>

  <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
  <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>

  <section class="mb-6 border border-slate-200 bg-white p-5">
    <h2 class="font-semibold">检出新的复核批次</h2>
    <p class="mt-1 text-xs text-slate-500">冻结（已批准）项目只读，不能检出；每个项目同时只允许一份在途批次。</p>
    <div class="mt-4 grid gap-4 md:grid-cols-[minmax(280px,2fr)_minmax(220px,2fr)_minmax(160px,1fr)_auto] md:items-end">
      <UFormGroup label="认证项目">
        <USelect v-model="checkoutProject" :options="projectOptions" placeholder="选择项目" />
      </UFormGroup>
      <UFormGroup label="批次说明">
        <UInput v-model="checkoutLabel" placeholder="例如：现场离线复核 10-03" />
      </UFormGroup>
      <UFormGroup label="审阅人">
        <UInput v-model="checkoutReviewer" placeholder="默认项目审阅人" />
      </UFormGroup>
      <UButton color="primary" @click="checkout">检出复核批次</UButton>
    </div>
  </section>

  <section class="border border-slate-200 bg-white">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">批次列表（{{ rows.length }}）</h2>
      <div class="flex flex-wrap gap-1">
        <UButton
          v-for="option in statusFilters"
          :key="option.value"
          size="xs"
          :variant="filter === option.value ? 'solid' : 'soft'"
          :color="filter === option.value ? 'primary' : 'gray'"
          @click="filter = option.value"
        >
          {{ option.label }}
        </UButton>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[1080px]">
        <thead>
          <tr>
            <th>批次</th>
            <th>认证项目</th>
            <th>基线（检出 / 当前在线）</th>
            <th>状态</th>
            <th>待复核两版</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="{ batch, project } in rows" :key="batch.id">
            <td>
              <NuxtLink :to="`/batches/${batch.id}`" class="font-semibold text-teal-700 hover:underline">
                {{ batch.id }}
              </NuxtLink>
              <p class="mt-1 max-w-[240px] text-sm text-slate-600">{{ batch.label }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ batch.reviewer }}</p>
            </td>
            <td>
              <p class="font-medium">{{ batch.projectId }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ project?.name ?? '项目已不存在' }}</p>
              <UBadge v-if="project?.status === 'approved'" color="gray" variant="soft" class="mt-1">已冻结只读</UBadge>
            </td>
            <td class="font-mono text-xs">
              <p>检出 SW {{ batch.base.project.softwareVersion }}</p>
              <p class="mt-1 text-slate-500">在线 SW {{ project?.softwareVersion ?? '—' }}</p>
              <p class="mt-1" :class="batch.offline.project.softwareVersion !== batch.base.project.softwareVersion ? 'text-amber-700' : 'text-slate-500'">
                离线 SW {{ batch.offline.project.softwareVersion }}
              </p>
            </td>
            <td>
              <UBadge :color="statusColor(batch.status)" variant="soft">{{ batchStatusLabels[batch.status] }}</UBadge>
              <p v-if="batch.report?.recoveredFromFailure" class="mt-1 text-xs text-amber-700">
                失败后第 {{ batch.commitAttempts }} 次恢复成功
              </p>
            </td>
            <td>
              <span v-if="batch.unresolvedConflictGroupIds.length" class="text-sm font-medium text-amber-700">
                {{ batch.unresolvedConflictGroupIds.length }} 组待取版
              </span>
              <span v-else class="text-sm text-slate-400">—</span>
            </td>
            <td class="text-xs text-slate-500">
              <p>检出 {{ batch.checkedOutAt.slice(0, 16).replace('T', ' ') }}</p>
              <p v-if="batch.exportedAt" class="mt-1">导出 {{ batch.exportedAt.slice(0, 16).replace('T', ' ') }}</p>
              <p v-if="batch.mergedAt" class="mt-1">合并 {{ batch.mergedAt.slice(0, 16).replace('T', ' ') }}</p>
            </td>
            <td>
              <div class="flex flex-wrap gap-2">
                <UButton size="xs" color="primary" variant="soft" :to="`/batches/${batch.id}`">
                  {{ batch.status === 'awaiting_review' ? '复核取版' : '打开批次' }}
                </UButton>
                <UButton
                  v-if="['checked_out', 'awaiting_review'].includes(batch.status)"
                  size="xs"
                  color="gray"
                  variant="ghost"
                  @click="store.abandonBatch(batch.id)"
                >
                  放弃
                </UButton>
              </div>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="7" class="py-12 text-center text-slate-500">暂无复核批次，请先检出。</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
