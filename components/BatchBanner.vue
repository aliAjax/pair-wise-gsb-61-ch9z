<script setup lang="ts">
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
onMounted(() => store.hydrate());

const active = computed(() => store.activeBatch);
</script>

<template>
  <section class="mb-5 space-y-3">
    <div
      v-if="store.recovery.pending"
      class="border-2 border-red-300 bg-red-50 p-4"
      role="alert"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-sm font-semibold text-red-900">批次写入未完成，已按完整批次保留待恢复</p>
          <p class="mt-1 text-sm text-red-800">{{ store.recovery.error }}</p>
          <p class="mt-1 text-xs text-red-700">
            当前列表、详情和提交包仍只读取上一份有效批次；待提交批次未进入视图。
          </p>
        </div>
        <div class="flex shrink-0 gap-2">
          <UButton size="sm" color="red" @click="store.retryLastWrite()">按完整批次重试提交</UButton>
          <UButton size="sm" color="gray" variant="ghost" @click="store.discardPendingWrite()">放弃待提交批次</UButton>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border border-teal-200 bg-teal-50 px-4 py-2.5">
      <div class="flex min-w-0 flex-wrap items-center gap-3 text-sm">
        <span class="font-semibold text-teal-900">当前有效复核批次</span>
        <span class="font-mono text-xs text-teal-800">{{ active.meta.id }}</span>
        <UBadge color="teal" variant="soft">{{ active.meta.label }}</UBadge>
        <span class="text-xs text-teal-700">
          {{ active.projects.length }} 个认证项目 · 生成于 {{ active.meta.createdAt.slice(0, 16).replace('T', ' ') }}
        </span>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <UBadge v-if="store.pendingConflictCount" color="amber" variant="solid">
          {{ store.pendingConflictCount }} 项合并冲突待复核
        </UBadge>
        <UBadge v-else color="green" variant="soft">无未决冲突</UBadge>
        <NuxtLink to="/review-batches" class="font-medium text-teal-800 hover:underline">批次与离线复核台 →</NuxtLink>
      </div>
    </div>
  </section>
</template>
