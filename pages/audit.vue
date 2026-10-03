<script setup lang="ts">
import { liveEvidence } from '~/services/review-batch';
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
onMounted(() => store.hydrate());
const selectedProject = ref('all');
const projectOptions = computed(() => [
  { label: '全部项目', value: 'all' },
  ...store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id }))
]);

const scopedProjects = computed(() =>
  store.projects.filter((project) => selectedProject.value === 'all' || project.id === selectedProject.value)
);

const entries = computed(() =>
  scopedProjects.value
    .flatMap((project) =>
      project.audit.map((entry) => ({
        ...entry,
        projectId: project.id,
        projectName: project.name
      }))
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
);

function exportAudit() {
  const batch = store.activeBatch;
  // 提交包只认同一份有效批次，并只携带有效证据行（被裁定弃用版本不进入提交包）
  const payload = {
    kind: 'vehicle-type-approval-submission-package',
    generatedAt: new Date().toISOString(),
    batch: {
      id: batch.meta.id,
      label: batch.meta.label,
      baselineToken: batch.meta.baselineToken,
      conflictsPending: batch.meta.conflictsPending
    },
    scope: selectedProject.value,
    projects: scopedProjects.value.map((project) => ({
      id: project.id,
      status: project.status,
      frozen: project.status === 'approved',
      maintenanceVersion: project.maintenanceVersion,
      softwareVersion: project.softwareVersion,
      versions: project.versions,
      regulations: project.regulations,
      evidence: liveEvidence(project),
      audit: project.audit
    }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `submission-${batch.meta.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">审计与提交包</h1>
      <p class="mt-1 text-sm text-slate-600">提交包只携带当前唯一有效批次及其有效证据版本，完整保留在线/离线变更轨迹。</p>
    </div>
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-[300px]">
        <UFormGroup label="审计范围">
          <USelect v-model="selectedProject" :options="projectOptions" />
        </UFormGroup>
      </div>
      <UButton color="primary" :disabled="store.pendingConflictCount > 0" @click="exportAudit">导出提交包</UButton>
    </div>
  </div>

  <BatchBanner />

  <div v-if="store.pendingConflictCount > 0" class="mb-4 border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    存在 {{ store.pendingConflictCount }} 项未决合并冲突（双版本/冻结拦截/基线漂移），请先在复核批次台裁定后再导出提交包。
  </div>

  <section class="border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">审批时间线</h2>
      <p class="mt-1 text-xs text-slate-500">共 {{ entries.length }} 条记录 · 批次 {{ store.activeBatch.meta.id }}</p>
    </div>
    <div class="space-y-5 p-5">
      <article v-for="entry in entries" :key="entry.id" class="audit-item">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">
            {{ entry.action }} · {{ entry.actor }}
            <UBadge v-if="entry.origin === 'offline'" color="violet" variant="soft" size="sm" class="ml-2">离线回网</UBadge>
            <UBadge v-else-if="entry.origin === 'system'" color="gray" variant="soft" size="sm" class="ml-2">系统</UBadge>
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
