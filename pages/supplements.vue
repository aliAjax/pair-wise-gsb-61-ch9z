<script setup lang="ts">
import { validateEvidenceUpgrade } from '~/services/validators';
import { isFrozenProject, liveEvidence } from '~/services/review-batch';
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
onMounted(() => store.hydrate());
const selectedProjectId = ref('');
const selectedEvidence = ref<string[]>([]);
const note = ref('');
const message = ref('');
const error = ref('');

const needsSupplement = (status: string, invalidated?: boolean) =>
  invalidated || ['rejected', 'resubmit', 'missing'].includes(status);

const projectOptions = computed(() =>
  store.projects
    .filter((project) => !isFrozenProject(project))
    .filter((project) => liveEvidence(project).some((evidence) => needsSupplement(evidence.status, evidence.invalidated)))
    .map((project) => ({
      label: `${project.id} · ${project.name}`,
      value: project.id
    }))
);

const current = computed(() => store.projects.find((project) => project.id === selectedProjectId.value));
const pendingEvidence = computed(() =>
  current.value ? liveEvidence(current.value).filter((item) => needsSupplement(item.status, item.invalidated)) : []
);

function submit() {
  message.value = '';
  error.value = '';
  if (!current.value) {
    error.value = '请选择需要补件的认证项目';
    return;
  }
  const errors = validateEvidenceUpgrade(current.value, selectedEvidence.value, note.value);
  if (errors.length) {
    error.value = errors.join('；');
    return;
  }
  const count = store.bulkSupplement(current.value.id, selectedEvidence.value, note.value);
  if (!count) return;
  selectedEvidence.value = [];
  note.value = '';
  message.value = `已完成 ${count} 项证据补件，写入新复核批次并同步到当前软件基线。`;
}

watch(projectOptions, (options) => {
  if (!selectedProjectId.value || !options.some((option) => option.value === selectedProjectId.value)) {
    selectedProjectId.value = options[0]?.value ?? '';
  }
}, { immediate: true });
</script>

<template>
  <div class="mb-6">
    <h1 class="text-2xl font-semibold">批量补件工作区</h1>
    <p class="mt-1 text-sm text-slate-600">软件基线变更后失效重算项与退回项统一更新到当前基线，冻结（已批准）项目不参与补件。</p>
  </div>

  <BatchBanner />

  <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
  <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>

  <div class="grid gap-6 xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]">
    <section class="border border-slate-200 bg-white p-5">
      <UFormGroup label="认证项目">
        <USelect v-model="selectedProjectId" :options="projectOptions" />
      </UFormGroup>
      <div v-if="current" class="mt-5 space-y-3 text-sm">
        <div>
          <p class="text-slate-500">车型配置</p>
          <p class="mt-1 font-medium">{{ current.modelCode }} · {{ current.configuration }}</p>
        </div>
        <div>
          <p class="text-slate-500">当前版本基线</p>
          <p class="mt-1 font-medium">{{ current.maintenanceVersion }} / SW {{ current.softwareVersion }}</p>
        </div>
        <div>
          <p class="text-slate-500">待补件 / 失效重算数量</p>
          <p class="metric-value mt-1 text-2xl font-semibold">{{ pendingEvidence.length }}</p>
        </div>
      </div>
    </section>

    <section class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">选择待补件证据</h2>
        <p class="mt-1 text-xs text-slate-500">提交后证据状态变为已提交、软件版本对齐项目基线，失效标记清除。</p>
      </div>
      <form class="p-4" @submit.prevent="submit">
        <div class="space-y-3">
          <label v-for="item in pendingEvidence" :key="item.id" class="flex gap-3 border border-slate-200 p-4"
            :class="item.invalidated ? 'border-red-200 bg-red-50/50' : ''"
          >
            <input v-model="selectedEvidence" type="checkbox" :value="item.id" class="mt-1" />
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center justify-between gap-2">
                <strong class="text-sm">{{ item.name }}</strong>
                <span class="flex items-center gap-1">
                  <UBadge v-if="item.invalidated" color="red" variant="solid" size="sm">失效重算</UBadge>
                  <StatusBadge :status="item.status" />
                </span>
              </span>
              <span class="mt-2 block text-sm text-slate-600">{{ item.note }}</span>
              <span class="mt-2 block text-xs text-slate-500">
                {{ item.regulationId }} · 文件 {{ item.version }} · 软件 {{ item.softwareVersion }} · {{ item.configurations.join('、') }}
              </span>
            </span>
          </label>
          <p v-if="!pendingEvidence.length" class="py-10 text-center text-sm text-slate-500">有效批次内没有待补件证据。</p>
        </div>

        <div class="mt-5">
          <UFormGroup label="批量补件说明">
            <UTextarea v-model="note" :rows="4" placeholder="填写新增测试、说明文件、版本核对和配置覆盖结论" />
          </UFormGroup>
        </div>
        <UButton type="submit" color="primary" class="mt-4">提交批量补件</UButton>
      </form>
    </section>
  </div>
</template>
