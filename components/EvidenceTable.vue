<script setup lang="ts">
import type { EvidenceItem, EvidenceStatus } from '~/types/certification';

const props = defineProps<{
  evidence: EvidenceItem[];
  editable?: boolean;
  /** 冻结项目：整表只读 */
  readonly?: boolean;
}>();

const emit = defineEmits<{
  update: [evidenceId: string, status: EvidenceStatus];
}>();

const typeLabels: Record<EvidenceItem['type'], string> = {
  test_report: '测试报告',
  part_list: '部件清单',
  software_report: '软件报告',
  exemption: '豁免材料',
  certificate: '证书'
};

const rows = computed(() => props.evidence.filter((item) => !item.superseded));

// 双版本分组：同 conflictGroup 的在线/离线两版相邻展示
const grouped = computed(() => {
  const groups: (EvidenceItem | EvidenceItem[])[] = [];
  const seen = new Set<string>();
  for (const item of rows.value) {
    if (item.conflictGroup) {
      if (seen.has(item.conflictGroup)) continue;
      seen.add(item.conflictGroup);
      groups.push(rows.value.filter((row) => row.conflictGroup === item.conflictGroup));
    } else {
      groups.push(item);
    }
  }
  return groups;
});
</script>

<template>
  <div class="overflow-x-auto">
    <table class="data-table min-w-[1080px]">
      <thead>
        <tr>
          <th>证据文件</th>
          <th>法规项</th>
          <th>文件 / 软件版本</th>
          <th>配置覆盖</th>
          <th>状态</th>
          <th>复核标记</th>
          <th>审阅说明</th>
          <th v-if="editable">操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="entry in grouped" :key="Array.isArray(entry) ? entry[0].conflictGroup : entry.id">
          <tr
            v-for="item in (Array.isArray(entry) ? entry : [entry])"
            :key="item.id"
            :class="item.pendingReview ? 'bg-amber-50/60' : item.invalidated ? 'bg-red-50/50' : ''"
          >
            <td>
              <p class="font-medium">{{ item.name }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ typeLabels[item.type] }} · {{ item.id }}</p>
              <UBadge
                v-if="item.origin === 'offline'"
                color="violet"
                variant="soft"
                size="sm"
                class="mt-1"
              >离线包改动</UBadge>
            </td>
            <td class="font-mono text-sm">{{ item.regulationId }}</td>
            <td>
              <p>文件 {{ item.version }}</p>
              <p class="mt-1 text-xs" :class="item.invalidated ? 'text-red-700' : 'text-slate-500'">
                软件 {{ item.softwareVersion }}
              </p>
            </td>
            <td class="max-w-[260px] text-sm">{{ item.configurations.join('、') }}</td>
            <td><StatusBadge :status="item.status" /></td>
            <td class="space-y-1">
              <UBadge v-if="item.pendingReview" color="amber" variant="solid" size="sm">待复核双版本</UBadge>
              <UBadge v-if="item.invalidated" color="red" variant="solid" size="sm">基线变更已失效</UBadge>
              <span v-if="!item.pendingReview && !item.invalidated" class="text-xs text-slate-400">—</span>
            </td>
            <td class="max-w-[300px] text-sm text-slate-600">{{ item.note }}</td>
            <td v-if="editable">
              <div v-if="readonly" class="text-xs text-slate-400">冻结项目只读</div>
              <div v-else class="flex min-w-[180px] flex-wrap gap-2">
                <UButton size="xs" color="green" variant="soft" @click="emit('update', item.id, 'accepted')">接受</UButton>
                <UButton size="xs" color="red" variant="soft" @click="emit('update', item.id, 'rejected')">拒绝</UButton>
                <UButton size="xs" color="amber" variant="soft" @click="emit('update', item.id, 'resubmit')">重新抽样</UButton>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="editable ? 8 : 7" class="py-12 text-center text-slate-500">当前项目尚未关联证据。</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
