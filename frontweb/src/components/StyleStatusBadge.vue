<template>
  <el-tag
    v-if="state"
    size="small"
    effect="plain"
    :type="tagType"
    :title="title"
    class="style-status-badge"
  >
    {{ label }}
  </el-tag>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  state: { type: String, default: 'current' },
  version: { type: [String, Number], default: null },
})

const compiled = computed(() => props.state === 'current' || props.state === 'compiled_v2')
const stale = computed(() => props.state && !compiled.value)
const label = computed(() => {
  if (props.state === 'current') return props.version ? `视觉 v${props.version}` : '视觉当前'
  if (props.state === 'compiled_v2') return props.version ? `已编译 v${props.version}` : '已按 V2 编译'
  if (props.state === 'manual_override') return '手动提示词'
  if (props.state === 'stale_style') return '风格过期'
  if (props.state === 'stale_scene') return '内容过期'
  if (props.state === 'stale_reference') return '引用过期'
  return '待重编译'
})
const tagType = computed(() => stale.value ? (props.state === 'manual_override' ? 'warning' : 'danger') : 'success')
const title = computed(() => stale.value ? '当前提示词或引用包需要按活动视觉版本重新编译' : '提示词与活动视觉版本一致')
</script>

<style scoped>
.style-status-badge { margin-left: 6px; vertical-align: middle; }
</style>
