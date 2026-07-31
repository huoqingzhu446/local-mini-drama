<template>
  <section v-if="slots.length" class="asset-workbench" aria-labelledby="asset-review-title">
    <header class="workbench-heading">
      <div>
        <span>SEMANTIC ASSET REVIEW</span>
        <h3 id="asset-review-title">检查会进入正式视频的素材</h3>
        <p v-if="showReferenceCompare">{{ referenceReviewIntro }}</p>
        <p v-else>图片素材由你逐张批准；标记为“自动过渡”的状态由本地动作生成，不调用图片 API，也不需要重复审核。</p>
      </div>
      <div class="review-progress">
        <strong>{{ progress.approved }}/{{ progress.total }}</strong>
        <span>{{ progress.complete ? (automaticCount ? `全部就绪 · ${automaticCount} 个自动过渡` : '全部已批准') : `还需审核 ${progress.remaining} 张` }}</span>
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
          <div v-if="showReferenceCompare" class="comparison-criteria" aria-label="对照检查项">{{ referenceCriteria }}</div>
          <div v-else class="background-switch" aria-label="预览背景">
            <button v-for="item in backgrounds" :key="item.value" type="button" :class="{ active: background === item.value }" @click="background = item.value">{{ item.label }}</button>
          </div>
          <div class="zoom-control">
            <button type="button" @click="zoom = Math.max(0.5, zoom - 0.25)">−</button>
            <span>{{ Math.round(zoom * 100) }}%</span>
            <button type="button" @click="zoom = Math.min(3, zoom + 0.25)">＋</button>
          </div>
        </div>

        <div class="media-stage" :class="background">
          <div v-if="showReferenceCompare" class="comparison-grid">
            <figure class="comparison-panel reference-panel">
              <figcaption><strong>{{ styleOnlyReference ? '风格参考' : '构图参考' }}</strong><span>{{ styleOnlyReference ? '视觉身份基准' : '画面基准' }}</span></figcaption>
              <div class="comparison-image" :style="{ transform: `scale(${zoom})` }">
                <img :src="referencePreviewUrl" alt="已选择的分镜构图参考" draggable="false" />
              </div>
            </figure>
            <figure class="comparison-panel formal-panel" :class="{ blocked: !referenceGatePassed }">
              <figcaption><strong>正式素材</strong><span>{{ referenceGatePassed ? '已携带参考生成' : '缺少参考依据' }}</span></figcaption>
              <div class="comparison-image" :style="{ transform: `scale(${zoom})` }">
                <img ref="previewImage" :src="selectedVersion.preview_url" :alt="`${slotLabel(selectedSlot)} 当前版本`" draggable="false" />
              </div>
            </figure>
          </div>
          <div v-else-if="selectedVersion?.preview_url" class="image-plane" :style="{ transform: `scale(${zoom})` }">
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
            <strong>{{ selectedSlot?.status === 'generating' ? '正在生成当前槽位' : isAutomaticFallbackSlot(selectedSlot) ? '这个状态由系统自动过渡' : '当前槽位还没有可审核版本' }}</strong>
            <p>{{ selectedSlot?.status === 'failed' ? '可以只重新生成这一张，或直接上传替换素材。' : isAutomaticFallbackSlot(selectedSlot) ? '进入环境动态阶段时，系统会复用相邻已批准素材并应用本地运动，不产生图片费用。' : '等待任务完成后会在这里显示正式素材。' }}</p>
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
          <span>{{ assetTypeLabel(selectedSlot) }}</span>
          <h4>{{ slotLabel(selectedSlot) }}</h4>
          <p>{{ purposeLabel(selectedSlot) }}</p>
        </div>

        <dl v-if="selectedSlot" class="slot-definition">
          <div><dt>素材类型</dt><dd>{{ assetTypeLabel(selectedSlot) }}</dd></div>
          <div v-if="selectedSlot.constraints_json?.identity"><dt>内容主体</dt><dd>{{ selectedSlot.constraints_json.identity }}</dd></div>
          <div v-if="selectedSlot.constraints_json?.state"><dt>状态/阶段</dt><dd>{{ stateLabel(selectedSlot.constraints_json.state) }}</dd></div>
          <div v-if="selectedSlot.constraints_json?.scene_key"><dt>所属场景</dt><dd>{{ selectedSlot.constraints_json.label || selectedSlot.constraints_json.scene_key }}</dd></div>
          <div v-if="selectedSlot.constraints_json?.environment_description"><dt>场景要求</dt><dd>{{ selectedSlot.constraints_json.environment_description }}</dd></div>
          <div v-if="isEnvironmentSlot && selectedSlot.constraints_json?.reference_role"><dt>参考用途</dt><dd>{{ styleOnlyReference ? '只锁时代、天气、色调和媒介' : '锁定构图与视觉风格' }}</dd></div>
          <div><dt>内部槽位</dt><dd>{{ selectedSlot.slot_key }}</dd></div>
        </dl>

        <dl v-if="selectedSlot?.current_version">
          <div><dt>版本</dt><dd>V{{ selectedSlot.current_version.attempt_index }}</dd></div>
          <div><dt>来源</dt><dd>{{ derivationLabel(selectedSlot.current_version.derivation_kind) }}</dd></div>
          <div><dt>技术门禁</dt><dd :class="selectedSlot.current_version.quality_report_json?.pass === false ? 'warn' : 'pass'">{{ selectedSlot.current_version.quality_report_json?.pass === false ? '需修正' : '已通过' }}</dd></div>
          <div v-if="isEnvironmentSlot && referencePreviewUrl"><dt>构图参考</dt><dd :class="referenceGatePassed ? 'pass' : 'warn'">{{ referenceGatePassed ? '已随请求传入' : '未随请求传入' }}</dd></div>
          <div v-if="selectedSlot.current_version.quality_report_json?.transparent_ratio != null"><dt>透明区域</dt><dd>{{ percent(selectedSlot.current_version.quality_report_json.transparent_ratio) }}</dd></div>
          <div v-if="selectedSlot.current_version.quality_report_json?.visible_ratio != null"><dt>可见主体</dt><dd>{{ percent(selectedSlot.current_version.quality_report_json.visible_ratio) }}</dd></div>
          <div><dt>{{ isAutomaticVersion(selectedSlot.current_version) ? '采用方式' : '人工审核' }}</dt><dd :class="isApproved(selectedSlot.current_version) ? 'pass' : ''">{{ reviewLabel(selectedSlot.current_version.latest_review_decision) }}</dd></div>
        </dl>

        <section v-if="isEnvironmentSlot && referencePreviewUrl" class="reference-review" :class="{ blocked: !referenceGatePassed }">
          <strong>{{ referenceGatePassed ? '请完成画面一致性确认' : '这版素材不能批准' }}</strong>
          <p v-if="referenceGatePassed">{{ referenceReviewInstruction }}</p>
          <p v-else>这版素材生成时没有携带已选构图参考。{{ canRegenerate ? '请点“只重新生成这一张”，系统会带上参考图重新生成。' : '请先点“退回这版错误素材”，回到素材阶段后再只重生成这一张。' }}</p>
        </section>

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
          <button type="button" :disabled="busy || generationActive || !selectedSlot" @click="replacementInput?.click()">上传替换{{ canPatchMask ? '（透明 PNG）' : '' }}</button>
          <button type="button" :disabled="busy || generationActive || !canRegenerate" :title="regenerationHint" @click="$emit('regenerate', selectedSlot)">{{ regenerateButtonLabel }}</button>
          <button v-if="canRematte" type="button" :disabled="busy || generationActive" @click="$emit('rematte', selectedSlot.current_version)">重新自动抠图</button>
        </div>
        <small v-if="generationStatusMessage" class="generation-status">{{ generationStatusMessage }}</small>
        <small v-if="regenerationHint" class="recovery-hint">{{ regenerationHint }}</small>

        <div class="review-actions">
          <button type="button" class="reject" :disabled="busy || generationActive || !selectedSlot?.current_version" @click="$emit('reject', reviewTarget)">{{ !referenceGatePassed ? '退回这版错误素材' : '退回当前素材' }}</button>
          <button type="button" class="approve" :disabled="busy || generationActive || !canApprove" @click="$emit('approve', reviewTarget)">
            {{ isApproved(selectedSlot?.current_version) ? '此素材已批准' : '批准此素材' }}
          </button>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import {
  paperAssetPurposeLabel,
  paperAssetSlotLabel,
  paperAssetStateLabel,
  paperAssetTypeLabel,
} from '../../utils/paperAssetLabels.js'

const props = defineProps({
  shot: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  regeneratingSlotId: { type: Number, default: null },
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
const isEnvironmentSlot = computed(() => selectedSlot.value?.asset_type === 'environment')
const styleOnlyReference = computed(() => selectedSlot.value?.constraints_json?.reference_role === 'style_only')
const referenceCriteria = computed(() => styleOnlyReference.value
  ? '场景语义 · 时代 · 天气 · 光向 · 色调 · 媒介'
  : '构图 · 时代 · 天气 · 损毁 · 色调 · 媒介 · 地点')
const referenceReviewIntro = computed(() => styleOnlyReference.value
  ? '左边只用于统一时代、天气、色调和纸片媒介；右边必须服从当前场景要求，不能照搬左图地点和构图。'
  : '左边是已选构图参考，右边是正式素材；构图、时代、天气、损毁状态、色调和纸片媒介都一致后再批准。')
const referenceReviewInstruction = computed(() => styleOnlyReference.value
  ? '确认右图准确表现当前所属场景，同时与左图保持相同年代、天气家族、光线方向、色调和纸片质感；左右地点和构图不应相同。'
  : '对照左右两图，确认构图、时代、地点、天气、损毁状态、色调和纸片质感没有明显漂移。')
const referencePreviewUrl = computed(() => mediaUrl(props.shot?.storyboard?.local_path || props.shot?.storyboard?.image_url))
const showReferenceCompare = computed(() => Boolean(isEnvironmentSlot.value && referencePreviewUrl.value && selectedVersion.value?.preview_url))
const referenceGateRequired = computed(() => Boolean(
  isEnvironmentSlot.value
  && referencePreviewUrl.value
  && selectedSlot.value?.current_version?.derivation_kind === 'image_api',
))
const referenceGatePassed = computed(() => !referenceGateRequired.value || Boolean(
  selectedSlot.value?.current_version?.quality_report_json?.reference_gate_passed !== false
  && Number(selectedSlot.value?.current_version?.quality_report_json?.reference_count || 0) > 0,
))
const progress = computed(() => props.shot?.asset_review_progress || { total: 0, approved: 0, remaining: 0, complete: false })
const automaticCount = computed(() => slots.value.filter((slot) => isAutomaticVersion(slot.current_version)).length)
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
const activeGenerationStep = computed(() => (props.shot?.steps || []).find((step) => (
  step.step_key === 'generate_layout_master' && ['queued', 'running'].includes(step.status)
)) || null)
const generationActive = computed(() => Boolean(props.regeneratingSlotId || activeGenerationStep.value))
function slotGenerationStatus(slot) {
  if (Number(props.regeneratingSlotId) === Number(slot?.id)) return 'submitting'
  if (slot?.status === 'generating') return 'running'
  const step = activeGenerationStep.value
  if (!step) return null
  const slotIds = step.authorized_slot_ids || []
  if (slotIds.length && !slotIds.map(Number).includes(Number(slot?.id))) return null
  return step.status
}
const selectedGenerationStatus = computed(() => slotGenerationStatus(selectedSlot.value))
const regenerateButtonLabel = computed(() => ({
  submitting: '正在提交重新生成…',
  queued: '重新生成已排队',
  running: '正在重新生成…',
}[selectedGenerationStatus.value] || (generationActive.value ? '本镜头素材生成中' : '只重新生成这一张')))
const generationStatusMessage = computed(() => {
  if (!generationActive.value) return ''
  if (selectedGenerationStatus.value === 'submitting') return '正在创建当前槽位的生成任务，请勿重复点击。'
  if (selectedGenerationStatus.value === 'queued') return '当前槽位已经进入生成队列，后台开始处理后会自动刷新。'
  if (selectedGenerationStatus.value === 'running') return '当前槽位正在生成，新版本返回前会保留现有素材。'
  return '当前镜头已有素材生成任务，完成前不能再次提交。'
})
const regenerationStates = new Set(['plan_confirmed', 'asset_review', 'asset_failed'])
const canRegenerate = computed(() => selectedSlot.value
  && regenerationStates.has(props.shot?.status)
  && selectedSlot.value.asset_type !== 'occlusion-mask'
  && selectedSlot.value.constraints_json?.derivation !== 'registered_alpha_band')
const regenerationHint = computed(() => {
  if (!selectedSlot.value || canRegenerate.value) return ''
  if (props.shot?.status === 'motion_failed' && isAutomaticFallbackSlot(selectedSlot.value)) return '请使用右侧主按钮“自动补齐环境过渡并继续”，无需再次调用图片 API。'
  if (!regenerationStates.has(props.shot?.status)) return '当前已进入动作或渲染阶段；需要换图时请上传替换，系统会安全退回素材审核。'
  return ''
})
const canApprove = computed(() => props.shot?.status === 'asset_review'
  && selectedSlot.value?.current_version?.status === 'accepted'
  && !isAutomaticVersion(selectedSlot.value.current_version)
  && !isApproved(selectedSlot.value.current_version)
  && referenceGatePassed.value
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
function isAutomaticVersion(version) { return version?.derivation_kind === 'procedural_state_fallback' }
function isAutomaticFallbackSlot(slot) { return slot?.constraints_json?.fallback === 'procedural' && !slot?.required_for_gate }
function slotLabel(slot) {
  return paperAssetSlotLabel(slot)
}
function assetTypeLabel(slot) { return paperAssetTypeLabel(slot) }
function purposeLabel(slot) { return paperAssetPurposeLabel(slot) }
function stateLabel(state) { return paperAssetStateLabel(state) }
function versionStatus(slot) {
  const generation = slotGenerationStatus(slot)
  if (generation === 'submitting') return '提交中'
  if (generation === 'queued') return '已排队'
  if (generation === 'running') return '生成中'
  if (isAutomaticVersion(slot.current_version)) return '自动过渡'
  if (!slot.current_version && isAutomaticFallbackSlot(slot)) return '将自动补间'
  if (isApproved(slot.current_version)) return '已批准'
  return { planned: '待生成', generating: '生成中', ready: '待审核', failed: '需处理' }[slot.status] || slot.status
}
function derivationLabel(value) { return { image_api: '图片 API', user_upload: '用户上传', mask_patch: 'Mask 修订', matte_refinement: '重新抠图', procedural_mask: '本地程序层', procedural_state_fallback: '本地自动过渡', derived_occluder: '本地派生层', imported_source: '项目素材' }[value] || value }
function reviewLabel(decision) {
  if (decision?.reviewer === 'system_procedural_fallback') return '系统自动采用'
  return { approved: '已批准', rejected: '已退回', replaced: '已被新版本替换' }[decision?.decision] || '待你审核'
}
function mediaUrl(value) {
  const media = String(value || '').trim()
  if (!media || /^(?:data:|https?:\/\/|\/static\/)/i.test(media)) return media || null
  return `/static/${media.replace(/^\/+/, '')}`
}
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
.comparison-criteria { color: var(--paper-muted); font-size: var(--paper-fs-xs); letter-spacing: .04em; }
.zoom-control span { min-width: 36px; color: var(--paper-muted); font: var(--paper-fs-xs) ui-monospace, monospace; text-align: center; }
.media-stage { min-height: 380px; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 24px; }
.media-stage.checker { background-color: #d8d8d5; background-image: linear-gradient(45deg, #bdbdb9 25%, transparent 25%), linear-gradient(-45deg, #bdbdb9 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #bdbdb9 75%), linear-gradient(-45deg, transparent 75%, #bdbdb9 75%); background-position: 0 0, 0 10px, 10px -10px, -10px 0; background-size: 20px 20px; }
.media-stage.light { background: #e7e3da; }
.media-stage.dark { background: #0c0d0b; }
.image-plane { position: relative; max-width: 100%; transform-origin: center; transition: transform .18s ease; }
.image-plane img { display: block; max-width: 100%; max-height: 650px; width: auto; height: auto; cursor: crosshair; }
.comparison-grid { width: 100%; align-self: stretch; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: #34352f; }
.comparison-panel { min-width: 0; min-height: 380px; display: grid; grid-template-rows: 38px minmax(0, 1fr); margin: 0; overflow: hidden; background: #10110f; }
.comparison-panel figcaption { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 12px; border-bottom: 1px solid #30312c; background: #191a17; }
.comparison-panel figcaption strong { color: var(--paper-text); font-size: var(--paper-fs-sm); }
.comparison-panel figcaption span { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.comparison-panel.formal-panel figcaption { box-shadow: inset 0 -2px var(--paper-accent); }
.comparison-panel.blocked figcaption { box-shadow: inset 0 -2px #c86f5e; }
.comparison-panel.blocked figcaption span { color: #d48676; }
.comparison-image { min-height: 0; display: flex; align-items: center; justify-content: center; padding: 16px; transform-origin: center; transition: transform .18s ease; }
.comparison-image img { display: block; max-width: 100%; max-height: 570px; object-fit: contain; }
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
.reference-review { margin-top: 15px; padding: 12px 0; border-top: 1px solid var(--paper-line); border-bottom: 1px solid var(--paper-line); }
.reference-review strong { color: var(--paper-text); font-size: var(--paper-fs-sm); }
.reference-review p { margin: 6px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-xs); line-height: 1.55; }
.reference-review.blocked { border-color: rgb(200 111 94 / 55%); }
.reference-review.blocked strong, .reference-review.blocked p { color: #d79a8d; }
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
.generation-status { display: block; margin-top: 8px; padding: 8px 9px; border-left: 2px solid var(--paper-accent); background: rgb(223 177 79 / 7%); color: #d4bd86; font-size: var(--paper-fs-xs); line-height: 1.5; }
.recovery-hint { display: block; margin-top: 7px; color: #c8aa6f; font-size: var(--paper-fs-xs); line-height: 1.5; }
.review-actions { margin-top: 8px; }
.review-actions button { flex: 1; padding: 9px 6px; }
.review-actions .reject { color: #c78a7e; }
.review-actions .approve { border-color: var(--paper-accent); background: var(--paper-accent); color: #211c13; font-weight: 800; }
button:disabled { opacity: .38; cursor: not-allowed; }
@media (max-width: 1180px) {
  .workbench-body { grid-template-columns: 132px minmax(300px, 1fr); }
  .decision-panel { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--paper-line); }
}
@media (max-width: 760px) {
  .comparison-grid { grid-template-columns: 1fr; }
  .comparison-panel { min-height: 300px; }
}
</style>
