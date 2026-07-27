<template>
  <section class="delivery-board">
    <header class="delivery-heading">
      <div>
        <span>EPISODE DELIVERY</span>
        <h2>{{ delivery?.episode?.title || '分集交付' }}</h2>
        <p>只有当前声音版本已经进入每条正式视频时，整集才允许合并。</p>
      </div>
      <div class="delivery-count">
        <strong>{{ delivery?.ready_count || 0 }}/{{ delivery?.total_count || 0 }}</strong>
        <span>分镜可交付</span>
      </div>
    </header>

    <div v-if="!delivery?.items?.length" class="delivery-empty">
      <span>还没有可检查的分镜</span>
      <p>先创建分镜并完成脚本，交付看板会逐项显示声音、动作和正式视频状态。</p>
    </div>

    <template v-else>
      <div class="delivery-stage">
        <div class="delivery-media">
          <video
            v-if="selectedItem?.video_ready && selectedItem?.video_url"
            :key="selectedItem.video_generation_id"
            controls
            preload="metadata"
            :src="mediaUrl(selectedItem.video_local_path || selectedItem.video_url)"
          />
          <div v-else class="media-placeholder">
            <span>SHOT {{ String(selectedItem?.shot_number || 0).padStart(2, '0') }}</span>
            <strong>{{ selectedItem?.title || '选择一个分镜' }}</strong>
            <p>{{ primaryBlocker?.label || '正式视频完成后可在这里播放检查。' }}</p>
          </div>
        </div>

        <aside class="delivery-decision">
          <span>{{ delivery.ready ? 'READY TO MERGE' : 'NEXT REQUIRED ACTION' }}</span>
          <h3>{{ delivery.ready ? '四镜已经可以合并' : primaryBlocker?.label || '选择一个待处理分镜' }}</h3>
          <p v-if="delivery.ready">声音、字幕和正式视频均来自当前版本。合并会建立新的可追溯整集版本。</p>
          <p v-else>{{ selectedItem?.title }} 当前有 {{ selectedItem?.blockers?.length || 0 }} 个阻断项，已完成结果不会因为局部修复被删除。</p>
          <button
            v-if="delivery.ready"
            type="button"
            class="primary"
            :disabled="busy || mergeInProgress"
            @click="$emit('merge')"
          >
            {{ mergeInProgress ? '正在合并有声整集…' : '合并有声整集' }}
          </button>
          <button
            v-else-if="selectedItem && primaryBlocker"
            type="button"
            class="primary"
            :disabled="busy"
            @click="$emit('fix', { item: selectedItem, blocker: primaryBlocker })"
          >
            {{ primaryBlocker.label }}
          </button>
          <button type="button" class="secondary" :disabled="busy" @click="$emit('refresh')">刷新交付状态</button>
        </aside>
      </div>

      <div v-if="delivery.blockers?.length" class="blocker-summary" role="status">
        <strong>整集暂不可合并</strong>
        <span>{{ blockerSummary }}</span>
      </div>

      <div class="delivery-table" role="table" aria-label="纸片分镜交付状态">
        <div class="delivery-row table-head" role="row">
          <span role="columnheader">分镜</span>
          <span role="columnheader">脚本</span>
          <span role="columnheader">素材 / 动作</span>
          <span role="columnheader">声音 / 字幕</span>
          <span role="columnheader">正式视频</span>
          <span role="columnheader">操作</span>
        </div>
        <button
          v-for="item in delivery.items"
          :key="item.paper_storyboard_id"
          type="button"
          class="delivery-row"
          :class="{ selected: Number(item.paper_storyboard_id) === Number(selectedItem?.paper_storyboard_id) }"
          role="row"
          @click="selectedId = Number(item.paper_storyboard_id)"
        >
          <span class="shot-cell" role="cell">
            <i>{{ String(item.shot_number).padStart(2, '0') }}</i>
            <strong>{{ item.title }}</strong>
          </span>
          <StatusText role="cell" :ready="item.script_ready" :label="item.script_ready ? '已保存' : '待补充'" />
          <StatusText role="cell" :ready="productionReady(item)" :label="productionLabel(item.production_status)" />
          <StatusText
            role="cell"
            :ready="item.audio_ready"
            :label="audioLabel(item)"
            :detail="subtitleLabel(item)"
          />
          <StatusText role="cell" :ready="item.video_ready && item.audio_embedded" :label="videoLabel(item)" />
          <span class="row-action" role="cell">
            {{ item.merge_ready ? '播放' : item.blockers?.[0]?.label || '查看' }}
          </span>
        </button>
      </div>

      <section class="delivery-history">
        <header>
          <div>
            <span>DELIVERY VERSIONS</span>
            <h3>整集版本</h3>
          </div>
          <strong>{{ delivery.merges?.length || 0 }} 个历史版本</strong>
        </header>
        <div v-if="!delivery.merges?.length" class="history-empty">四镜全部就绪后生成第一个有声整集版本。</div>
        <article v-for="merge in delivery.merges" :key="merge.id" class="merge-version">
          <div>
            <span>版本 #{{ merge.id }}</span>
            <strong>{{ mergeStatusLabel(merge.status) }}</strong>
            <small>{{ formatTime(merge.completed_at || merge.created_at) }}</small>
          </div>
          <p v-if="merge.error_msg">{{ merge.error_msg }}</p>
          <div class="merge-actions">
            <a v-if="merge.status === 'completed' && merge.merged_url" :href="mediaUrl(merge.merged_url)" target="_blank" rel="noreferrer">播放</a>
            <a v-if="merge.status === 'completed' && merge.merged_url" :href="mediaUrl(merge.merged_url)" download>下载 MP4</a>
            <a v-if="merge.status === 'completed' && merge.subtitle_url" :href="mediaUrl(merge.subtitle_url)" download>下载 SRT</a>
          </div>
        </article>
      </section>
    </template>
  </section>
</template>

<script>
import { defineComponent, h } from 'vue'

const StatusText = defineComponent({
  name: 'StatusText',
  props: {
    ready: { type: Boolean, default: false },
    label: { type: String, default: '' },
    detail: { type: String, default: '' },
  },
  setup(props, { attrs }) {
    return () => h('span', { ...attrs, class: ['status-text', props.ready ? 'ready' : 'attention'] }, [
      h('i', { 'aria-hidden': 'true' }),
      h('strong', props.label),
      props.detail ? h('small', props.detail) : null,
    ])
  },
})

export default { components: { StatusText } }
</script>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  delivery: { type: Object, default: null },
  busy: { type: Boolean, default: false },
})

defineEmits(['fix', 'merge', 'refresh'])

const selectedId = ref(null)
watch(() => props.delivery?.items, (items) => {
  const available = items || []
  if (!available.some((item) => Number(item.paper_storyboard_id) === Number(selectedId.value))) {
    selectedId.value = Number(available.find((item) => !item.merge_ready)?.paper_storyboard_id || available[0]?.paper_storyboard_id || 0) || null
  }
}, { immediate: true })

const selectedItem = computed(() => props.delivery?.items?.find((item) => Number(item.paper_storyboard_id) === Number(selectedId.value)) || props.delivery?.items?.[0] || null)
const primaryBlocker = computed(() => selectedItem.value?.blockers?.[0] || null)
const mergeInProgress = computed(() => ['pending', 'processing'].includes(props.delivery?.latest_merge?.status))
const blockerSummary = computed(() => {
  const blockers = props.delivery?.blockers || []
  return blockers.slice(0, 4).map((item) => `分镜 ${String(item.shot_number).padStart(2, '0')}：${item.label}`).join('；')
    + (blockers.length > 4 ? `；另有 ${blockers.length - 4} 项` : '')
})

function productionReady(item) {
  return ['proof_ready', 'preview_ready', 'approved', 'rendering', 'rendered', 'published'].includes(item?.production_status)
}

function productionLabel(status) {
  return {
    not_started: '尚未制作', pending: '等待分析', analyzed: '计划待确认', plan_confirmed: '等待素材',
    asset_pending: '素材生成中', asset_review: '素材待审核', asset_failed: '素材需修复', asset_ready: '素材已批准',
    motion_failed: '动作需修复', motion_ready: '动作已规划', proof_failed: '动态未通过', proof_ready: '动态已通过',
    preview_ready: '预览待批准', approved: '预览已批准', rendering: '正式渲染中', render_failed: '渲染失败',
    rendered: '待发布', published: '已发布',
  }[status] || status || '尚未制作'
}

function audioLabel(item) {
  if (item.audio_mode === 'silent' && item.audio_ready) return '明确静音'
  return item.audio_ready ? '音频完整' : '音频待补'
}

function subtitleLabel(item) {
  if (item.audio_mode === 'silent') return '无字幕'
  if (!item.audio_ready) return '等待音频'
  return item.subtitle_ready ? '字幕已生成' : '字幕已关闭'
}

function videoLabel(item) {
  if (!item.video_ready) return item.blockers?.some((entry) => entry.key === 'video_file') ? '文件缺失' : '未发布'
  if (!item.audio_embedded) return '声音版本已变化'
  return '当前有声版本'
}

function mergeStatusLabel(status) {
  return { pending: '等待合并', processing: '正在合并', failed: '合并失败', completed: '可交付', stale: '历史版本' }[status] || status
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : ''
}

function mediaUrl(value) {
  if (!value) return ''
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/static/')) return value
  return `/static/${String(value).replace(/^\/+/, '')}`
}
</script>

<style scoped>
.delivery-board { min-height: calc(100vh - 72px); padding: 30px 34px 72px; box-sizing: border-box; animation: board-in .2s ease both; }
@keyframes board-in { from { opacity: .7; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.delivery-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; padding-bottom: 24px; border-bottom: 1px solid var(--paper-line); }
.delivery-heading span, .delivery-history header span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .14em; }
.delivery-heading h2 { margin: 7px 0 5px; color: var(--paper-text); font: 600 27px/1.2 Georgia, 'Songti SC', serif; }
.delivery-heading p { margin: 0; color: var(--paper-muted); font-size: var(--paper-fs-base); }
.delivery-count { flex: none; text-align: right; }
.delivery-count strong { display: block; color: var(--paper-text); font: 500 30px/1 Georgia, serif; }
.delivery-count span { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.delivery-empty { min-height: 420px; display: grid; place-content: center; text-align: center; }
.delivery-empty span { color: var(--paper-text); font: 600 20px Georgia, serif; }
.delivery-empty p { max-width: 420px; color: var(--paper-muted); font-size: var(--paper-fs-base); line-height: 1.7; }
.delivery-stage { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(250px, .8fr); min-height: 330px; margin-top: 24px; border: 1px solid var(--paper-line); background: #121310; }
.delivery-media { min-width: 0; display: grid; place-items: center; background: #0f100e; }
.delivery-media video { width: 100%; max-height: 430px; display: block; }
.media-placeholder { display: flex; flex-direction: column; align-items: center; padding: 40px; text-align: center; }
.media-placeholder span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .14em; }
.media-placeholder strong { margin-top: 12px; color: var(--paper-text); font: 600 22px Georgia, serif; }
.media-placeholder p { max-width: 360px; margin: 8px 0 0; color: var(--paper-dim); font-size: var(--paper-fs-base); line-height: 1.6; }
.delivery-decision { display: flex; flex-direction: column; justify-content: center; padding: 27px; border-left: 1px solid var(--paper-line); background: var(--paper-panel); }
.delivery-decision > span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .12em; }
.delivery-decision h3 { margin: 10px 0 8px; color: var(--paper-text); font: 600 21px/1.35 Georgia, 'Songti SC', serif; }
.delivery-decision p { margin: 0 0 16px; color: var(--paper-muted); font-size: var(--paper-fs-base); line-height: 1.65; }
.delivery-decision button { width: 100%; margin-top: 8px; padding: 11px 12px; font-size: var(--paper-fs-base); font-weight: 800; cursor: pointer; }
.delivery-decision .primary { border: 0; background: var(--paper-accent); color: #211c13; }
.delivery-decision .secondary { border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); }
.delivery-decision button:disabled { opacity: .4; cursor: not-allowed; }
.blocker-summary { display: flex; gap: 12px; margin-top: 12px; padding: 11px 13px; border-left: 2px solid #b58b43; background: #262219; color: #d6bd8a; font-size: var(--paper-fs-sm); line-height: 1.5; }
.delivery-table { margin-top: 25px; border-top: 1px solid var(--paper-line); }
.delivery-row { width: 100%; display: grid; grid-template-columns: minmax(150px, 1.4fr) .7fr 1fr 1fr 1fr minmax(100px, .8fr); align-items: center; gap: 12px; min-height: 62px; padding: 0 12px; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--paper-line-soft); background: transparent; color: var(--paper-muted); text-align: left; }
button.delivery-row { cursor: pointer; }
button.delivery-row:hover, button.delivery-row.selected { background: var(--paper-hover); }
button.delivery-row.selected { box-shadow: inset 2px 0 var(--paper-accent); }
.table-head { min-height: 36px; color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .08em; }
.shot-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
.shot-cell i { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; }
.shot-cell strong { overflow: hidden; color: var(--paper-text); font-size: var(--paper-fs-base); text-overflow: ellipsis; white-space: nowrap; }
:deep(.status-text) { min-width: 0; display: grid; grid-template-columns: 7px minmax(0, 1fr); align-items: center; gap: 4px 7px; font-size: var(--paper-fs-sm); }
:deep(.status-text i) { width: 6px; height: 6px; border-radius: 50%; background: #a56f59; }
:deep(.status-text.ready i) { background: #79a17a; }
:deep(.status-text strong) { overflow: hidden; color: var(--paper-muted); font-size: var(--paper-fs-sm); text-overflow: ellipsis; white-space: nowrap; }
:deep(.status-text small) { grid-column: 2; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.row-action { justify-self: end; color: var(--paper-accent); font-size: var(--paper-fs-sm); }
.delivery-history { margin-top: 34px; padding-top: 24px; border-top: 1px solid var(--paper-line); }
.delivery-history header { display: flex; align-items: flex-end; justify-content: space-between; }
.delivery-history h3 { margin: 5px 0 0; color: var(--paper-text); font: 600 19px Georgia, serif; }
.delivery-history header > strong { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.history-empty { margin-top: 16px; padding: 18px 0; color: var(--paper-dim); font-size: var(--paper-fs-base); }
.merge-version { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(120px, 1fr) auto; align-items: center; gap: 18px; min-height: 58px; border-top: 1px solid var(--paper-line-soft); }
.merge-version > div:first-child { display: flex; align-items: baseline; gap: 10px; }
.merge-version span, .merge-version small { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.merge-version strong { color: var(--paper-text); font-size: var(--paper-fs-sm); }
.merge-version p { color: #d48676; font-size: var(--paper-fs-sm); }
.merge-actions { display: flex; gap: 12px; }
.merge-actions a { color: var(--paper-accent); font-size: var(--paper-fs-sm); text-decoration: none; }
@media (max-width: 1050px) {
  .delivery-board { padding: 24px 22px 64px; }
  .delivery-stage { grid-template-columns: 1fr; }
  .delivery-decision { border-top: 1px solid var(--paper-line); border-left: 0; }
  .delivery-row { grid-template-columns: minmax(130px, 1.4fr) .7fr 1fr 1fr 1fr; }
  .delivery-row > :last-child { display: none; }
}
@media (max-width: 760px) {
  .delivery-heading { align-items: flex-start; }
  .delivery-row { grid-template-columns: 1.4fr 1fr 1fr; }
  .delivery-row > :nth-child(2), .delivery-row > :nth-child(3), .delivery-row > :last-child { display: none; }
  .merge-version { grid-template-columns: 1fr; padding: 13px 0; gap: 7px; }
}
</style>
