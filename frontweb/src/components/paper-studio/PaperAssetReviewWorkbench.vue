<template>
  <section v-if="slots.length" class="asset-workbench" aria-labelledby="asset-review-title">
    <header class="workbench-heading">
      <div>
        <span>SEMANTIC ASSET REVIEW</span>
        <h3 id="asset-review-title">逐张检查正式纸片素材</h3>
        <p>每张素材单独批准。替换、重新生成或修正 Mask 只会使当前槽位及下游预览失效。</p>
      </div>
      <div class="review-progress">
        <strong>{{ progress.approved }}/{{ progress.total }}</strong>
        <span>{{ progress.complete ? '全部已批准' : `还需审核 ${progress.remaining} 张` }}</span>
      </div>
    </header>

    <div class="workbench-body">
      <nav class="slot-rail" aria-label="正式素材槽位">
        <button
          v-for="slot in slots"
          :key="slot.id"
          type="button"
          :class="{ active: slot.id === selectedSlot?.id, approved: isApproved(slot.current_version), failed: slot.status === 'failed' }"
          @click="selectSlot(slot.id)"
        >
          <span class="slot-index">{{ String(slot.index + 1).padStart(2, '0') }}</span>
          <span class="slot-copy">
            <strong>{{ slotLabel(slot) }}</strong>
            <small>{{ versionStatus(slot) }}</small>
          </span>
          <i>{{ isApproved(slot.current_version) ? '✓' : slot.status === 'failed' ? '!' : '·' }}</i>
        </button>
      </nav>

      <main class="asset-inspector-stage">
        <div class="stage-toolbar">
          <div class="background-switch" aria-label="预览背景">
            <button v-for="item in backgrounds" :key="item.value" type="button" :class="{ active: background === item.value }" @click="background = item.value">{{ item.label }}</button>
          </div>
          <div class="zoom-control">
            <button type="button" @click="zoom = Math.max(0.5, zoom - 0.25)">−</button>
            <span>{{ Math.round(zoom * 100) }}%</span>
            <button type="button" @click="zoom = Math.min(3, zoom + 0.25)">＋</button>
          </div>
        </div>

        <div class="media-stage" :class="background">
          <div v-if="selectedVersion?.preview_url" class="image-plane" :style="{ transform: `scale(${zoom})` }">
            <img
              ref="previewImage"
              :src="selectedVersion.preview_url"
              :alt="`${slotLabel(selectedSlot)} 当前版本`"
              draggable="false"
              @click="addMaskPoint"
            />
            <span
              v-for="(point, index) in maskPoints"
              :key="`${point.kind}-${index}`"
              class="mask-point"
              :class="point.kind"
              :style="pointStyle(point)"
              :title="point.kind === 'foreground' ? '保留主体' : '擦除背景'"
            />
          </div>
          <div v-else class="media-empty">
            <strong>{{ selectedSlot?.status === 'generating' ? '正在生成当前槽位' : '当前槽位还没有可审核版本' }}</strong>
            <p>{{ selectedSlot?.status === 'failed' ? '可以只重新生成这一张，或直接上传替换素材。' : '等待任务完成后会在这里显示正式素材。' }}</p>
          </div>
        </div>

        <div v-if="selectedSlot?.versions?.length > 1" class="version-strip">
          <span>版本历史</span>
          <button
            v-for="version in selectedSlot.versions"
            :key="version.id"
            type="button"
            :class="{ current: version.id === selectedVersion?.id }"
            @click="historyVersionId = version.id"
          >
            <img v-if="version.preview_url" :src="version.preview_url" alt="历史素材版本" />
            <i>V{{ version.attempt_index }}</i>
          </button>
          <small v-if="historyVersionId && historyVersionId !== selectedSlot.current_version?.id">历史版本仅用于比较；审核操作始终作用于当前版本。</small>
        </div>
      </main>

      <aside class="decision-panel">
        <div class="selected-title">
          <span>{{ selectedSlot?.family_key }}</span>
          <h4>{{ slotLabel(selectedSlot) }}</h4>
          <p>{{ selectedSlot?.generation_purpose }}</p>
        </div>

        <dl v-if="selectedSlot?.current_version">
          <div><dt>版本</dt><dd>V{{ selectedSlot.current_version.attempt_index }}</dd></div>
          <div><dt>来源</dt><dd>{{ derivationLabel(selectedSlot.current_version.derivation_kind) }}</dd></div>
          <div><dt>技术门禁</dt><dd :class="selectedSlot.current_version.quality_report_json?.pass === false ? 'warn' : 'pass'">{{ selectedSlot.current_version.quality_report_json?.pass === false ? '需修正' : '已通过' }}</dd></div>
          <div v-if="selectedSlot.current_version.quality_report_json?.transparent_ratio != null"><dt>透明区域</dt><dd>{{ percent(selectedSlot.current_version.quality_report_json.transparent_ratio) }}</dd></div>
          <div v-if="selectedSlot.current_version.quality_report_json?.visible_ratio != null"><dt>可见主体</dt><dd>{{ percent(selectedSlot.current_version.quality_report_json.visible_ratio) }}</dd></div>
          <div><dt>人工审核</dt><dd :class="isApproved(selectedSlot.current_version) ? 'pass' : ''">{{ reviewLabel(selectedSlot.current_version.latest_review_decision) }}</dd></div>
        </dl>

        <section v-if="canPatchMask" class="mask-tools">
          <div class="section-heading"><strong>Mask 点选修正</strong><small>本地处理，不调用图片 API</small></div>
          <p>选择“保留主体”或“擦除背景”，再点击大图标记位置。提交后会生成新版本，可继续撤回或修正。</p>
          <div class="mask-modes">
            <button type="button" :class="{ active: maskMode === 'foreground' }" @click="maskMode = 'foreground'">保留主体</button>
            <button type="button" :class="{ active: maskMode === 'background' }" @click="maskMode = 'background'">擦除背景</button>
          </div>
          <label><span>笔刷半径 {{ Math.round(radius * 100) }}%</span><input v-model.number="radius" type="range" min="0.01" max="0.16" step="0.01" /></label>
          <label><span>羽化 {{ Math.round(feather * 100) }}%</span><input v-model.number="feather" type="range" min="0" max="1" step="0.05" /></label>
          <div class="mask-actions">
            <button type="button" :disabled="!maskPoints.length" @click="maskPoints.pop()">撤销一点</button>
            <button type="button" :disabled="!maskPoints.length" @click="maskPoints = []">清空</button>
            <button type="button" class="apply-mask" :disabled="busy || !maskPoints.length" @click="applyMask">应用 {{ maskPoints.length }} 个点</button>
          </div>
        </section>

        <div class="replacement-actions">
          <input ref="replacementInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="uploadReplacement" />
          <button type="button" :disabled="busy || !selectedSlot" @click="replacementInput?.click()">上传替换{{ canPatchMask ? '（透明 PNG）' : '' }}</button>
          <button type="button" :disabled="busy || !canRegenerate" @click="$emit('regenerate', selectedSlot)">只重新生成这一张</button>
          <button v-if="canRematte" type="button" :disabled="busy" @click="$emit('rematte', selectedSlot.current_version)">重新自动抠图</button>
        </div>

        <div class="review-actions">
          <button type="button" class="reject" :disabled="busy || !selectedSlot?.current_version" @click="$emit('reject', reviewTarget)">退回当前素材</button>
          <button type="button" class="approve" :disabled="busy || !canApprove" @click="$emit('approve', reviewTarget)">
            {{ isApproved(selectedSlot?.current_version) ? '此素材已批准' : '批准此素材' }}
          </button>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  shot: { type: Object, default: null },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['approve', 'reject', 'rematte', 'regenerate', 'upload', 'patch-mask'])

const selectedSlotId = ref(null)
const historyVersionId = ref(null)
const background = ref('checker')
const zoom = ref(1)
const previewImage = ref(null)
const replacementInput = ref(null)
const maskMode = ref('background')
const maskPoints = ref([])
const radius = ref(0.05)
const feather = ref(0.35)
const backgrounds = [
  { value: 'checker', label: '透明棋盘' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const slots = computed(() => (props.shot?.families || []).flatMap((family) => family.slots.map((slot) => ({ ...slot, family_key: family.family_key })))
  .map((slot, index) => ({ ...slot, index })))
const selectedSlot = computed(() => slots.value.find((slot) => Number(slot.id) === Number(selectedSlotId.value)) || slots.value[0] || null)
const selectedVersion = computed(() => selectedSlot.value?.versions?.find((version) => Number(version.id) === Number(historyVersionId.value))
  || selectedSlot.value?.current_version || null)
const progress = computed(() => props.shot?.asset_review_progress || { total: 0, approved: 0, remaining: 0, complete: false })
const reviewTarget = computed(() => selectedSlot.value?.current_version ? {
  ...selectedSlot.value.current_version,
  slot_id: selectedSlot.value.id,
  slot_key: selectedSlot.value.slot_key,
  asset_type: selectedSlot.value.asset_type,
} : null)
const canPatchMask = computed(() => selectedSlot.value?.current_version
  && selectedSlot.value.asset_type !== 'environment'
  && selectedSlot.value.asset_type !== 'occlusion-mask'
  && historyVersionId.value === selectedSlot.value.current_version.id)
const canRematte = computed(() => canPatchMask.value && selectedSlot.value.current_version.alpha_local_path)
const canRegenerate = computed(() => selectedSlot.value
  && selectedSlot.value.asset_type !== 'occlusion-mask'
  && selectedSlot.value.constraints_json?.derivation !== 'registered_alpha_band')
const canApprove = computed(() => props.shot?.status === 'asset_review'
  && selectedSlot.value?.current_version?.status === 'accepted'
  && !isApproved(selectedSlot.value.current_version)
  && historyVersionId.value === selectedSlot.value.current_version.id)

watch(() => props.shot?.id, () => {
  selectedSlotId.value = slots.value[0]?.id || null
  resetVersion()
}, { immediate: true })
watch(slots, () => {
  if (!slots.value.some((slot) => Number(slot.id) === Number(selectedSlotId.value))) selectedSlotId.value = slots.value[0]?.id || null
  if (!historyVersionId.value) historyVersionId.value = selectedSlot.value?.current_version?.id || null
}, { deep: true })
watch(() => selectedSlot.value?.current_version?.id, () => resetVersion(false))

function resetVersion(resetZoom = true) {
  historyVersionId.value = selectedSlot.value?.current_version?.id || null
  maskPoints.value = []
  if (resetZoom) zoom.value = 1
}
function selectSlot(slotId) { selectedSlotId.value = slotId; resetVersion() }
function isApproved(version) { return version?.latest_review_decision?.decision === 'approved' }
function slotLabel(slot) {
  if (!slot) return '未选择素材'
  return slot.constraints_json?.label || slot.constraints_json?.state || slot.slot_key
}
function versionStatus(slot) {
  if (isApproved(slot.current_version)) return '已批准'
  return { planned: '待生成', generating: '生成中', ready: '待审核', failed: '需处理' }[slot.status] || slot.status
}
function derivationLabel(value) { return { image_api: '图片 API', user_upload: '用户上传', mask_patch: 'Mask 修订', matte_refinement: '重新抠图', procedural_mask: '本地程序层', derived_occluder: '本地派生层', imported_source: '项目素材' }[value] || value }
function reviewLabel(decision) { return { approved: '已批准', rejected: '已退回', replaced: '已被新版本替换' }[decision?.decision] || '待你审核' }
function percent(value) { return `${Math.round(Number(value || 0) * 100)}%` }
function pointStyle(point) {
  const size = Math.max(10, point.radius * 200)
  return { left: `${point.x * 100}%`, top: `${point.y * 100}%`, width: `${size}px`, height: `${size}px` }
}
function addMaskPoint(event) {
  if (!canPatchMask.value || props.busy) return
  const rect = previewImage.value?.getBoundingClientRect()
  if (!rect?.width || !rect?.height) return
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  maskPoints.value.push({ kind: maskMode.value, x: Number(x.toFixed(5)), y: Number(y.toFixed(5)), radius: Number(radius.value), strength: 1 })
}
function applyMask() {
  if (!reviewTarget.value || !maskPoints.value.length) return
  emit('patch-mask', { asset: reviewTarget.value, points: [...maskPoints.value], feather: Number(feather.value) })
}
function uploadReplacement(event) {
  const file = event.target.files?.[0]
  if (file && selectedSlot.value) emit('upload', { slot: selectedSlot.value, file })
  event.target.value = ''
}
</script>

<style scoped>
.asset-workbench { margin-top: 30px; border-top: 1px solid var(--paper-line); padding-top: 24px; }
.workbench-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 16px; }
.workbench-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .14em; }
.workbench-heading h3 { margin: 6px 0 0; color: var(--paper-text); font: 600 20px Georgia, 'Songti SC', serif; }
.workbench-heading p { margin: 6px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-sm); }
.review-progress { min-width: 110px; text-align: right; }
.review-progress strong { display: block; color: var(--paper-text); font: 600 21px ui-monospace, monospace; }
.review-progress span { color: var(--paper-muted); font-size: var(--paper-fs-xs); }
.workbench-body { display: grid; grid-template-columns: 152px minmax(320px, 1fr) 248px; min-height: 520px; border: 1px solid var(--paper-line); background: #141512; }
.slot-rail { overflow-y: auto; border-right: 1px solid var(--paper-line); background: #191a17; }
.slot-rail button { width: 100%; display: grid; grid-template-columns: 23px minmax(0, 1fr) 14px; align-items: center; gap: 7px; padding: 11px 9px; border: 0; border-bottom: 1px solid #292a26; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.slot-rail button:hover, .slot-rail button.active { background: #242520; color: var(--paper-text); }
.slot-rail button.active { box-shadow: inset 2px 0 var(--paper-accent); }
.slot-rail button.approved i { color: #83a982; }
.slot-rail button.failed i { color: #d48676; }
.slot-index { color: var(--paper-dim); font: 700 var(--paper-fs-xs) ui-monospace, monospace; }
.slot-copy { min-width: 0; display: grid; gap: 3px; }
.slot-copy strong, .slot-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot-copy strong { font-size: var(--paper-fs-sm); }
.slot-copy small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.slot-rail i { justify-self: end; font-style: normal; }
.asset-inspector-stage { min-width: 0; display: grid; grid-template-rows: auto minmax(380px, 1fr) auto; overflow: hidden; }
.stage-toolbar { min-height: 39px; display: flex; align-items: center; justify-content: space-between; padding: 0 11px; border-bottom: 1px solid var(--paper-line); background: #191a17; }
.background-switch, .zoom-control { display: flex; align-items: center; gap: 3px; }
.stage-toolbar button { padding: 5px 7px; border: 0; background: transparent; color: var(--paper-dim); font-size: var(--paper-fs-xs); cursor: pointer; }
.stage-toolbar button:hover, .stage-toolbar button.active { background: var(--paper-hover); color: var(--paper-text); }
.zoom-control span { min-width: 36px; color: var(--paper-muted); font: var(--paper-fs-xs) ui-monospace, monospace; text-align: center; }
.media-stage { min-height: 380px; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 24px; }
.media-stage.checker { background-color: #d8d8d5; background-image: linear-gradient(45deg, #bdbdb9 25%, transparent 25%), linear-gradient(-45deg, #bdbdb9 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #bdbdb9 75%), linear-gradient(-45deg, transparent 75%, #bdbdb9 75%); background-position: 0 0, 0 10px, 10px -10px, -10px 0; background-size: 20px 20px; }
.media-stage.light { background: #e7e3da; }
.media-stage.dark { background: #0c0d0b; }
.image-plane { position: relative; max-width: 100%; transform-origin: center; transition: transform .18s ease; }
.image-plane img { display: block; max-width: 100%; max-height: 650px; width: auto; height: auto; cursor: crosshair; }
.mask-point { position: absolute; border: 2px solid currentColor; border-radius: 50%; transform: translate(-50%, -50%); pointer-events: none; box-shadow: 0 0 0 1px rgb(0 0 0 / 55%); }
.mask-point.foreground { color: #7bb07e; background: rgb(123 176 126 / 20%); }
.mask-point.background { color: #d87969; background: rgb(216 121 105 / 18%); }
.media-empty { max-width: 280px; text-align: center; }
.media-empty strong { color: var(--paper-text); font: 500 17px Georgia, serif; }
.media-empty p { margin: 8px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.6; }
.version-strip { display: flex; align-items: center; gap: 7px; min-height: 64px; overflow-x: auto; padding: 7px 10px; border-top: 1px solid var(--paper-line); background: #191a17; }
.version-strip > span { flex-shrink: 0; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.version-strip button { position: relative; width: 54px; height: 44px; flex-shrink: 0; overflow: hidden; padding: 0; border: 1px solid var(--paper-line); background: #111; cursor: pointer; }
.version-strip button.current { border-color: var(--paper-accent); }
.version-strip img { width: 100%; height: 100%; object-fit: contain; }
.version-strip i { position: absolute; right: 2px; bottom: 2px; padding: 1px 3px; background: rgb(0 0 0 / 72%); color: #ddd; font: var(--paper-fs-xs) ui-monospace, monospace; }
.version-strip small { min-width: 180px; color: #b98c6d; font-size: var(--paper-fs-xs); }
.decision-panel { display: flex; flex-direction: column; overflow-y: auto; padding: 18px; border-left: 1px solid var(--paper-line); background: #1b1c19; }
.selected-title > span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .12em; }
.selected-title h4 { margin: 6px 0 0; color: var(--paper-text); font: 600 17px Georgia, 'Songti SC', serif; }
.selected-title p { margin: 5px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-xs); line-height: 1.5; }
dl { margin: 16px 0 0; border-top: 1px solid var(--paper-line); }
dl div { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid #2a2b27; font-size: var(--paper-fs-xs); }
dt { color: var(--paper-dim); }
dd { margin: 0; color: var(--paper-muted); text-align: right; }
dd.pass { color: #83a982; }
dd.warn { color: #d48676; }
.mask-tools { margin-top: 16px; padding-top: 15px; border-top: 1px solid var(--paper-line); }
.section-heading { display: grid; gap: 3px; }
.section-heading strong { color: var(--paper-text); font-size: var(--paper-fs-sm); }
.section-heading small { color: #7fa77f; font-size: var(--paper-fs-xs); }
.mask-tools p { margin: 7px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-xs); line-height: 1.55; }
.mask-modes, .mask-actions, .replacement-actions, .review-actions { display: flex; gap: 5px; }
.mask-modes { margin-top: 10px; }
.mask-tools button, .replacement-actions button, .review-actions button { padding: 7px 8px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-xs); cursor: pointer; }
.mask-modes button.active { border-color: var(--paper-accent); color: var(--paper-text); }
.mask-tools label { display: grid; gap: 3px; margin-top: 8px; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.mask-tools input { width: 100%; accent-color: var(--paper-accent); }
.mask-actions { margin-top: 9px; flex-wrap: wrap; }
.mask-actions .apply-mask { flex: 1 1 100%; background: #303127; color: var(--paper-text); }
.replacement-actions { margin-top: auto; padding-top: 18px; flex-direction: column; }
.replacement-actions button:hover:not(:disabled) { border-color: #777268; color: var(--paper-text); }
.review-actions { margin-top: 8px; }
.review-actions button { flex: 1; padding: 9px 6px; }
.review-actions .reject { color: #c78a7e; }
.review-actions .approve { border-color: var(--paper-accent); background: var(--paper-accent); color: #211c13; font-weight: 800; }
button:disabled { opacity: .38; cursor: not-allowed; }
@media (max-width: 1180px) {
  .workbench-body { grid-template-columns: 132px minmax(300px, 1fr); }
  .decision-panel { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--paper-line); }
}
</style>
