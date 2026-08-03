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
        class="paper-storyboard-row"
        :class="{
          active: Number(storyboard.id) === Number(currentId),
          selected: isSelected(storyboard.id),
        }"
      >
        <button
          type="button"
          class="row-main"
          :aria-current="Number(storyboard.id) === Number(currentId) ? 'true' : undefined"
          @click="$emit('select', storyboard.id)"
        >
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
            :checked="isSelected(storyboard.id)"
            :aria-label="`${storyboard.title}：加入下一次生产版本`"
            @change="$emit('toggle', storyboard.id)"
          />
          <span>制作</span>
        </label>
        <div v-if="Number(storyboard.id) === Number(currentId)" class="row-tools">
          <button type="button" :disabled="busy" title="查看全部历史版本" @click="$emit('history', storyboard.id)">历</button>
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
import { storyboardStatusLabel } from '@/utils/paperStudioLabels'

const props = defineProps({
  episodeId: { type: [Number, String], default: null },
  storyboards: { type: Array, default: () => [] },
  currentId: { type: [Number, String], default: null },
  selectedIds: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})

defineEmits(['create', 'select', 'toggle', 'move', 'history'])

function isSelected(id) {
  return props.selectedIds.some((selectedId) => Number(selectedId) === Number(id))
}

function statusLabel(status) {
  return storyboardStatusLabel(status)
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
.storyboard-list { display: flex; flex-direction: column; gap: 3px; padding: 0 2px; }
.paper-storyboard-row { position: relative; min-height: 56px; border: 1px solid transparent; border-radius: 7px; background: transparent; transition: background .16s ease, border-color .16s ease, box-shadow .16s ease; }
.paper-storyboard-row::after { content: ''; position: absolute; right: 9px; bottom: -2px; left: 9px; height: 1px; background: var(--paper-line-soft); opacity: .72; pointer-events: none; }
.paper-storyboard-row:last-child::after { display: none; }
.paper-storyboard-row:hover { background: color-mix(in srgb, var(--paper-hover) 72%, transparent); }
.paper-storyboard-row.active { border-color: color-mix(in srgb, var(--paper-accent) 26%, var(--paper-line)); background: var(--paper-active); box-shadow: inset 2px 0 var(--paper-accent); }
.paper-storyboard-row.active::after { opacity: 0; }
.row-main { width: 100%; min-width: 0; min-height: 56px; display: grid; grid-template-columns: 24px 54px minmax(0, 1fr); align-items: center; gap: 8px; padding: 9px 44px 9px 8px; border: 0; border-radius: inherit; outline: 0; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.row-main:focus-visible { box-shadow: inset 0 0 0 1px var(--paper-accent); }
.shot-number { color: var(--paper-dim); font: 700 var(--paper-fs-sm) ui-monospace, monospace; }
.active .shot-number { color: var(--paper-accent); }
.thumb { width: 54px; height: 34px; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--paper-line-soft); border-radius: 4px; background: #131412; color: #655f54; }
.thumb img { width: 100%; height: 100%; object-fit: cover; filter: saturate(.76) brightness(.86); transition: filter .16s ease; }
.paper-storyboard-row:hover .thumb img, .paper-storyboard-row.active .thumb img { filter: saturate(.9) brightness(.98); }
.thumb i { font: 600 15px Georgia, serif; font-style: normal; }
.copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.copy strong, .copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copy strong { color: var(--paper-muted); font-size: var(--paper-fs-sm); font-weight: 650; transition: color .16s ease; }
.paper-storyboard-row:hover .copy strong, .paper-storyboard-row.active .copy strong { color: var(--paper-text); }
.copy small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.run-select { position: absolute; top: 9px; right: 8px; display: grid; justify-items: center; gap: 3px; color: var(--paper-dim); font-size: var(--paper-fs-xs); cursor: pointer; transition: color .16s ease; }
.run-select input { width: 15px; height: 15px; display: grid; place-content: center; margin: 0; appearance: none; border: 1px solid #57564f; border-radius: 3px; outline: 0; background: #171816; cursor: pointer; transition: background .16s ease, border-color .16s ease, box-shadow .16s ease; }
.run-select input::before { content: ''; width: 4px; height: 7px; border-right: 2px solid #231f17; border-bottom: 2px solid #231f17; opacity: 0; transform: translateY(-1px) rotate(45deg) scale(.7); transition: opacity .12s ease, transform .12s ease; }
.run-select input:checked { border-color: var(--paper-accent); background: var(--paper-accent); }
.run-select input:checked::before { opacity: 1; transform: translateY(-1px) rotate(45deg) scale(1); }
.run-select input:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--paper-accent) 28%, transparent); }
.paper-storyboard-row.selected .run-select { color: #a9956c; }
.row-tools { position: absolute; right: 5px; bottom: 4px; display: flex; gap: 2px; opacity: 0; transition: opacity .16s ease; }
.paper-storyboard-row:hover .row-tools, .paper-storyboard-row.active .row-tools { opacity: 1; }
.row-tools button { min-width: 18px; height: 17px; padding: 0 3px; border: 0; background: #171816; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.row-tools button:disabled { opacity: .25; }
.empty-shot { width: 100%; min-height: 138px; display: grid; place-items: center; align-content: center; gap: 7px; padding: 18px; border: 1px dashed var(--paper-line); background: transparent; color: var(--paper-muted); text-align: center; cursor: pointer; }
.empty-shot:hover { border-color: var(--paper-accent); color: var(--paper-accent); }
.empty-shot span { font-size: var(--paper-fs-display); font-weight: 300; }
.empty-shot strong { font-size: var(--paper-fs-base); }
.empty-shot small { max-width: 190px; color: var(--paper-dim); font-size: var(--paper-fs-xs); line-height: 1.6; }
.empty-shot.muted { cursor: default; }
.empty-shot.muted:hover { border-color: var(--paper-line); color: var(--paper-muted); }
</style>
