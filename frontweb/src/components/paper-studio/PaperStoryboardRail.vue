<template>
  <section class="storyboard-rail" aria-label="纸片分镜">
    <div class="rail-heading">
      <div>
        <span>纸片分镜</span>
        <small>{{ storyboards.length }} SHOTS</small>
      </div>
      <button type="button" :disabled="!episodeId || busy" @click="$emit('create')">＋ 新增</button>
    </div>

    <div v-if="storyboards.length" class="storyboard-list">
      <article
        v-for="(storyboard, index) in storyboards"
        :key="storyboard.id"
        class="storyboard-row"
        :class="{ active: Number(storyboard.id) === Number(currentId) }"
      >
        <button type="button" class="row-main" @click="$emit('select', storyboard.id)">
          <span class="shot-number">{{ String(storyboard.shot_number).padStart(2, '0') }}</span>
          <span class="thumb">
            <img v-if="storyboard.preview_url" :src="storyboard.preview_url" alt="" />
            <i v-else>稿</i>
          </span>
          <span class="copy">
            <strong>{{ storyboard.title }}</strong>
            <small>{{ storyboard.duration }}s · {{ statusLabel(storyboard.status) }}</small>
          </span>
        </button>
        <label class="run-select" title="加入下一次生产版本">
          <input
            type="checkbox"
            :checked="selectedIds.map(Number).includes(Number(storyboard.id))"
            @change="$emit('toggle', storyboard.id)"
          />
          <span>制作</span>
        </label>
        <div v-if="Number(storyboard.id) === Number(currentId)" class="row-tools">
          <button type="button" :disabled="index === 0 || busy" title="上移" @click="$emit('move', storyboard.id, -1)">↑</button>
          <button type="button" :disabled="index === storyboards.length - 1 || busy" title="下移" @click="$emit('move', storyboard.id, 1)">↓</button>
        </div>
      </article>
    </div>

    <button v-else-if="episodeId" type="button" class="empty-shot" @click="$emit('create')">
      <span>＋</span>
      <strong>创建第一条纸片分镜</strong>
      <small>在这里写脚本、生成参考图，再建立生产版本</small>
    </button>
    <div v-else class="empty-shot muted">
      <strong>先创建纸片分集</strong>
      <small>纸片工作室的数据不会自动写入旧工作台</small>
    </div>
  </section>
</template>

<script setup>
defineProps({
  episodeId: { type: [Number, String], default: null },
  storyboards: { type: Array, default: () => [] },
  currentId: { type: [Number, String], default: null },
  selectedIds: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})

defineEmits(['create', 'select', 'toggle', 'move'])

function statusLabel(status) {
  return { draft: '草稿', ready: '参考图就绪', in_production: '制作中', published: '已发布', archived: '已归档' }[status] || status
}
</script>

<style scoped>
.storyboard-rail { min-height: 0; padding: 14px 10px 18px; border-top: 1px solid var(--paper-line); }
.rail-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 8px 10px; }
.rail-heading div { display: flex; align-items: baseline; gap: 7px; }
.rail-heading span { color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .12em; }
.rail-heading small { color: #5e5a53; font: 700 var(--paper-fs-xs) ui-monospace, monospace; }
.rail-heading button { border: 0; background: transparent; color: var(--paper-accent); font-size: var(--paper-fs-sm); cursor: pointer; }
.rail-heading button:disabled { opacity: .35; cursor: not-allowed; }
.storyboard-list { display: flex; flex-direction: column; }
.storyboard-row { position: relative; border-top: 1px solid var(--paper-line-soft); transition: background .16s ease; }
.storyboard-row:last-child { border-bottom: 1px solid var(--paper-line-soft); }
.storyboard-row:hover, .storyboard-row.active { background: var(--paper-hover) !important; }
.storyboard-row.active::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--paper-accent); }
.row-main { width: 100%; min-width: 0; display: grid; grid-template-columns: 24px 54px minmax(0, 1fr); align-items: center; gap: 8px; padding: 9px 42px 9px 8px; border: 0; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.shot-number { color: var(--paper-dim); font: 700 var(--paper-fs-sm) ui-monospace, monospace; }
.thumb { width: 54px; height: 34px; display: grid; place-items: center; overflow: hidden; background: #131412; color: #655f54; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb i { font: 600 15px Georgia, serif; font-style: normal; }
.copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.copy strong, .copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copy strong { color: var(--paper-text); font-size: var(--paper-fs-sm); }
.copy small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.run-select { position: absolute; right: 8px; top: 13px; display: grid; justify-items: center; gap: 2px; color: var(--paper-dim); font-size: var(--paper-fs-xs); cursor: pointer; }
.run-select input { width: 13px; height: 13px; accent-color: var(--paper-accent); }
.row-tools { position: absolute; right: 5px; bottom: 4px; display: flex; gap: 2px; opacity: 0; transition: opacity .16s ease; }
.storyboard-row:hover .row-tools, .storyboard-row.active .row-tools { opacity: 1; }
.row-tools button { width: 18px; height: 17px; padding: 0; border: 0; background: #171816; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.row-tools button:disabled { opacity: .25; }
.empty-shot { width: 100%; min-height: 138px; display: grid; place-items: center; align-content: center; gap: 7px; padding: 18px; border: 1px dashed var(--paper-line); background: transparent; color: var(--paper-muted); text-align: center; cursor: pointer; }
.empty-shot:hover { border-color: var(--paper-accent); color: var(--paper-accent); }
.empty-shot span { font-size: var(--paper-fs-display); font-weight: 300; }
.empty-shot strong { font-size: var(--paper-fs-base); }
.empty-shot small { max-width: 190px; color: var(--paper-dim); font-size: var(--paper-fs-xs); line-height: 1.6; }
.empty-shot.muted { cursor: default; }
.empty-shot.muted:hover { border-color: var(--paper-line); color: var(--paper-muted); }
</style>
