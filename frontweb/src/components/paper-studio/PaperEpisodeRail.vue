<template>
  <nav class="episode-rail" aria-label="分集">
    <div class="rail-label">
      <span>纸片分集</span>
      <button type="button" @click="$emit('create')">＋</button>
    </div>
    <button
      v-for="episode in episodes"
      :key="episode.id"
      type="button"
      class="episode-item"
      :class="{ active: Number(episode.id) === Number(selectedId) }"
      @click="$emit('select', episode.id)"
    >
      <span class="episode-number">{{ String(episode.episode_number || 0).padStart(2, '0') }}</span>
      <span class="episode-copy">
        <strong>{{ episode.title || `第 ${episode.episode_number} 集` }}</strong>
        <small>{{ episode.storyboard_count || 0 }} 个分镜 · {{ statusLabel(episode.status) }}</small>
      </span>
    </button>
    <button v-if="!episodes.length" type="button" class="empty" @click="$emit('create')">
      创建第一个纸片分集
    </button>
  </nav>
</template>

<script setup>
defineProps({
  episodes: { type: Array, default: () => [] },
  selectedId: { type: [Number, String], default: null },
})
defineEmits(['select', 'create'])

function statusLabel(status) {
  return { draft: '草稿', merging: '合并中', merge_failed: '合并失败', published: '已发布', archived: '已归档' }[status] || status
}
</script>

<style scoped>
.episode-rail { padding: 18px 12px; }
.rail-label { display: flex; align-items: center; justify-content: space-between; padding: 0 10px 10px; color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
.rail-label button { width: 24px; height: 24px; border: 1px solid var(--paper-line); border-radius: 50%; background: transparent; color: var(--paper-accent); cursor: pointer; }
.rail-label button:hover { border-color: var(--paper-accent); background: var(--paper-hover); }
.episode-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px; border: 0; border-radius: 7px; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; transition: background .16s ease, color .16s ease; }
.episode-item:hover { color: var(--paper-text); background: var(--paper-hover); }
.episode-item.active { color: var(--paper-text); background: var(--paper-active); }
.episode-number { width: 25px; color: var(--paper-dim); font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.active .episode-number { color: var(--paper-accent); }
.episode-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.episode-copy strong { font-size: var(--paper-fs-base); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.episode-copy small { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.empty { width: 100%; padding: 16px 10px; border: 1px dashed var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-base); cursor: pointer; }
.empty:hover { border-color: var(--paper-accent); color: var(--paper-accent); }
</style>
