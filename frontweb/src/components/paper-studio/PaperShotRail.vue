<template>
  <div class="shot-rail" aria-label="分镜">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      class="shot-item"
      :class="{ active: item.active, selected: item.selected }"
      @click="onSelect(item)"
    >
      <span class="shot-index">{{ String(item.number).padStart(2, '0') }}</span>
      <span class="shot-thumb">
        <img v-if="item.image" :src="item.image" alt="" />
        <span v-else class="shot-placeholder">P</span>
        <span v-if="mode === 'select'" class="selection-mark">{{ item.selected ? '✓' : '+' }}</span>
      </span>
      <span class="shot-copy">
        <strong>{{ item.title }}</strong>
        <small>{{ item.meta }}</small>
      </span>
      <span v-if="mode === 'run'" class="shot-state" :data-state="item.status">{{ statusLabel(item.status) }}</span>
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { shotStatusLabel } from '@/utils/paperStudioLabels'

const props = defineProps({
  mode: { type: String, default: 'select' },
  storyboards: { type: Array, default: () => [] },
  runShots: { type: Array, default: () => [] },
  selectedIds: { type: Array, default: () => [] },
  currentShotId: { type: [Number, String], default: null },
})
const emit = defineEmits(['toggle', 'select-shot'])

function imageUrl(value) {
  if (!value) return ''
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/static/')) return value
  return `/static/${String(value).replace(/^\/+/, '')}`
}

const items = computed(() => {
  if (props.mode === 'run') {
    return props.runShots.map((shot, index) => ({
      key: shot.id,
      id: Number(shot.id),
      number: shot.storyboard?.storyboard_number || index + 1,
      title: shot.storyboard?.title || `分镜 ${index + 1}`,
      meta: shot.storyboard?.action || `${shot.storyboard?.duration || 0}s`,
      image: imageUrl(shot.storyboard?.local_path || shot.storyboard?.image_url),
      status: shot.status,
      active: Number(shot.id) === Number(props.currentShotId),
      selected: false,
    }))
  }
  const selected = new Set(props.selectedIds.map(Number))
  return props.storyboards.map((shot, index) => ({
    key: shot.id,
    id: Number(shot.id),
    number: shot.storyboard_number || index + 1,
    title: shot.title || `分镜 ${index + 1}`,
    meta: shot.action || `${shot.duration || 0}s`,
    image: imageUrl(shot.local_path || shot.image_url),
    status: 'pending',
    active: false,
    selected: selected.has(Number(shot.id)),
  }))
})

function onSelect(item) {
  if (props.mode === 'run') emit('select-shot', item.id)
  else emit('toggle', item.id)
}

function statusLabel(status) {
  return shotStatusLabel(status, { compact: true })
}
</script>

<style scoped>
.shot-rail { display: flex; gap: 8px; padding: 12px 16px; overflow-x: auto; scrollbar-width: thin; }
.shot-item { position: relative; min-width: 188px; max-width: 220px; height: 64px; display: grid; grid-template-columns: 22px 48px minmax(0, 1fr); align-items: center; gap: 8px; padding: 7px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; transition: background .16s ease, border-color .16s ease, transform .16s ease; }
.shot-item:hover { background: var(--paper-hover); transform: translateY(-1px); }
.shot-item.selected, .shot-item.active { background: var(--paper-active); border-color: color-mix(in srgb, var(--paper-accent) 34%, transparent); color: var(--paper-text); }
.shot-index { color: var(--paper-dim); font: 600 var(--paper-fs-sm) ui-monospace, SFMono-Regular, Menlo, monospace; }
.shot-thumb { position: relative; width: 48px; height: 42px; overflow: hidden; border-radius: 5px; background: #171716; }
.shot-thumb img { width: 100%; height: 100%; object-fit: cover; filter: saturate(.72); }
.shot-placeholder { display: grid; place-items: center; width: 100%; height: 100%; color: #625d52; font: 700 18px Georgia, serif; }
.selection-mark { position: absolute; right: 3px; bottom: 3px; width: 16px; height: 16px; display: grid; place-items: center; border-radius: 50%; background: var(--paper-accent); color: #1d1a15; font-size: var(--paper-fs-sm); font-weight: 800; }
.shot-copy { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.shot-copy strong, .shot-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shot-copy strong { font-size: var(--paper-fs-base); }
.shot-copy small { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.shot-state { position: absolute; right: 7px; top: 5px; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.shot-state[data-state$="failed"], .shot-state[data-state="stale"] { color: #d17a69; }
.shot-state[data-state="published"] { color: #83a982; }
</style>
