<script setup lang="ts">
import { batchStatusLabels } from '~/types/certification';
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
const selectedProject = ref('all');
onMounted(() => store.hydrate());

const projectOptions = computed(() => [
  { label: '全部项目', value: 'all' },
  ...store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id }))
]);

const inScopeProjects = computed(() =>
  store.projects.filter((project) => selectedProject.value === 'all' || project.id === selectedProject.value)
);

// 列表只认同一份有效批次数据：两版待复核未取版的项目标记为不可导出
const pendingReviewProjects = computed(() =>
  store.batches.filter((batch) => batch.status === 'awaiting_review').map((batch) => batch.projectId)
);

const entries = computed(() =>
  inScopeProjects.value
    .flatMap((project) =>
      project.audit.map((entry) => ({
        ...entry,
        projectId: project.id,
        projectName: project.name
      }))
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
);

const blockingMessage = computed(() => {
  if (pendingReviewProjects.value.length) {
    const names = inScopeProjects.value
      .filter((project) => pendingReviewProjects.value.includes(project.id))
      .map((project) => project.id)
      .join('、');
    if (names) return `以下项目存在两版证据待复核取版，提交包暂不可用：${names}`;
  }
  return '';
});

function exportAudit() {
  if (blockingMessage.value) return;
  // 提交包与列表、详情来自同一 store 有效批次快照，不另取旧包数据
  const payload = {
    kind: 'vehicle-approval-submission/v1',
    generatedAt: new Date().toISOString(),
    scope: selectedProject.value,
    projects: inScopeProjects.value.map((project) => ({
      id: project.id,
      status: project.status,
      frozen: project.status === 'approved',
      maintenanceVersion: project.maintenanceVersion,
      softwareVersion: project.softwareVersion,
      versions: project.versions,
      evidence: project.evidence,
      regulations: project.regulations,
      effectiveBatch: (() => {
        const batch = store.activeBatchForProject(project.id);
        return batch
          ? { id: batch.id, status: batch.status, unresolvedConflicts: batch.unresolvedConflictGroupIds.length }
          : null;
      })(),
      audit: project.audit
    })),
    mergedBatches: store.batches
      .filter((batch) => batch.status === 'merged' || batch.status === 'voided')
      .map((batch) => ({
        id: batch.id,
        projectId: batch.projectId,
        status: batch.status,
        label: batchStatusLabels[batch.status],
        mergedAt: batch.mergedAt,
        attempts: batch.commitAttempts ?? 1,
        recoveredFromFailure: batch.report?.recoveredFromFailure ?? false,
        notes: batch.report?.notes ?? []
      }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'vehicle-type-approval-audit-package.json';
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">审计与提交包</h1>
      <p class="mt-1 text-sm text-slate-600">保留项目变更、证据审阅、状态流转、离线批次合并和批量补件的完整轨迹。</p>
    </div>
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-[300px]">
        <UFormGroup label="审计范围">
          <USelect v-model="selectedProject" :options="projectOptions" />
        </UFormGroup>
      </div>
      <UButton color="primary" :disabled="!!blockingMessage" @click="exportAudit">导出提交包</UButton>
    </div>
  </div>

  <div v-if="blockingMessage" class="mb-5 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
    {{ blockingMessage }}
    <NuxtLink to="/batches" class="ml-2 font-medium underline">前往复核取版</NuxtLink>
  </div>

  <section class="mb-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">在途复核批次</h2>
      <p class="mt-1 text-xs text-slate-500">提交包只认同一份有效批次；待取版批次合并后才可导出。</p>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[760px]">
        <thead>
          <tr>
            <th>批次</th>
            <th>项目</th>
            <th>状态</th>
            <th>两版待复核</th>
            <th>合并时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in store.batches.filter((item) => ['checked_out', 'awaiting_review', 'voided'].includes(item.status))" :key="batch.id">
            <td>
              <NuxtLink :to="`/batches/${batch.id}`" class="font-medium text-teal-700 hover:underline">{{ batch.id }}</NuxtLink>
              <p class="mt-1 text-xs text-slate-500">{{ batch.label }}</p>
            </td>
            <td class="font-mono text-sm">{{ batch.projectId }}</td>
            <td><UBadge :color="batch.status === 'awaiting_review' ? 'amber' : batch.status === 'voided' ? 'gray' : 'blue'" variant="soft">{{ batchStatusLabels[batch.status] }}</UBadge></td>
            <td>{{ batch.unresolvedConflictGroupIds.length }}</td>
            <td class="text-xs text-slate-500">{{ batch.mergedAt ? batch.mergedAt.slice(0, 16).replace('T', ' ') : '—' }}</td>
          </tr>
          <tr v-if="!store.batches.some((item) => ['checked_out', 'awaiting_review', 'voided'].includes(item.status))">
            <td colspan="5" class="py-8 text-center text-sm text-slate-500">当前没有在途批次。</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">审批时间线</h2>
      <p class="mt-1 text-xs text-slate-500">共 {{ entries.length }} 条记录（离线带回的记录已标记）</p>
    </div>
    <div class="space-y-5 p-5">
      <article v-for="entry in entries" :key="entry.id" class="audit-item">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">
            {{ entry.action }} · {{ entry.actor }}
            <UBadge v-if="entry.offline" color="amber" variant="soft" size="sm" class="ml-2">离线带回</UBadge>
          </p>
          <span class="text-xs text-slate-500">{{ entry.createdAt.slice(0, 16).replace('T', ' ') }}</span>
        </div>
        <p class="mt-1 text-sm text-slate-600">{{ entry.detail }}</p>
        <p class="mt-1 text-xs text-slate-500">{{ entry.projectId }} · {{ entry.projectName }}</p>
      </article>
      <p v-if="!entries.length" class="py-10 text-center text-sm text-slate-500">没有符合条件的审计记录。</p>
    </div>
  </section>
</template>
