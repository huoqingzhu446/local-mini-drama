<template>
  <section class="reference-manager">
    <header class="reference-heading">
      <div>
        <span>COMPOSITION REFERENCE</span>
        <strong>构图参考与约束</strong>
        <p>参考图只约束构图和风格；正式背景、角色和道具仍会拆成独立素材。</p>
      </div>
      <div class="reference-actions">
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="uploadFile" />
        <button type="button" class="quiet" :disabled="busy || !storyboard" @click="fileInput?.click()">上传参考图</button>
        <button type="button" class="primary" :disabled="busy || !storyboard || !ready" @click="$emit('generate')">调用图片 API 生成</button>
      </div>
    </header>

    <div v-if="currentReference" class="reference-canvas-shell">
      <div
        ref="canvas"
        class="reference-canvas"
        :class="{ drawing: Boolean(drawKind) }"
        @pointerdown="startDraw"
        @pointermove="moveDraw"
        @pointerup="finishDraw"
        @pointercancel="cancelDraw"
      >
        <img :src="currentReference.preview_url" :alt="`${storyboard?.title || '纸片分镜'} 构图参考`" draggable="false" />
        <button
          v-for="box in visibleBoxes"
          :key="`${box.kind}:${box.index}`"
          type="button"
          class="constraint-box"
          :class="box.kind"
          :style="boxStyle(box.value)"
          :title="`${kindLabel(box.kind)}：${box.value.label || '未命名'}`"
          @pointerdown.stop
          @click.stop="removeBox(box.kind, box.index)"
        >
          <span>{{ box.value.label || kindLabel(box.kind) }}</span>
          <i>×</i>
        </button>
        <div v-if="draftBox" class="constraint-box draft" :class="drawKind" :style="boxStyle(draftBox)">
          <span>{{ kindLabel(drawKind) }}</span>
        </div>
      </div>

      <aside class="constraint-tools">
        <div>
          <span>构图约束</span>
          <strong>{{ constraintCount }} 项</strong>
        </div>
        <p>选择一种约束后，在图片上拖出矩形。点击已有矩形可删除。</p>
        <div class="constraint-kinds">
          <button
            v-for="item in kinds"
            :key="item.value"
            type="button"
            :class="[item.value, { active: drawKind === item.value }]"
            @click="drawKind = drawKind === item.value ? '' : item.value"
          >{{ item.label }}</button>
        </div>
        <label>
          <span>新约束名称</span>
          <input v-model.trim="draftLabel" maxlength="80" placeholder="例如：主角、手持道具" />
        </label>
        <button type="button" class="save-constraints" :disabled="busy || !constraintsDirty" @click="saveConstraints">
          {{ busy ? '保存中…' : constraintsDirty ? '保存构图约束' : '构图约束已保存' }}
        </button>
      </aside>
    </div>

    <div v-else class="reference-empty">
      <span>REFERENCE FRAME</span>
      <strong>还没有构图参考</strong>
      <p>可以上传已有图片，也可以明确调用当前图片 API 生成一张。没有参考图也能继续写分镜，但生成结果的构图约束会更弱。</p>
      <div>
        <button type="button" class="quiet" :disabled="busy || !storyboard" @click="fileInput?.click()">上传本地图片</button>
        <button type="button" class="primary" :disabled="busy || !storyboard || !ready" @click="$emit('generate')">生成参考图</button>
      </div>
    </div>

    <div v-if="references.length" class="reference-history" aria-label="参考图候选历史">
      <div class="history-heading">
        <span>候选与历史</span>
        <small>{{ references.length }} 张 · 切换会创建新的分镜 revision</small>
      </div>
      <div class="history-strip">
        <button
          v-for="item in references"
          :key="item.id"
          type="button"
          :class="{ selected: item.status === 'selected' }"
          :disabled="busy || item.status === 'selected'"
          @click="$emit('select', item.id)"
        >
          <img :src="item.preview_url" :alt="item.status === 'selected' ? '当前参考图' : '历史参考图候选'" />
          <span>{{ sourceLabel(item.source_kind) }}</span>
          <i>{{ item.status === 'selected' ? '当前' : '设为当前' }}</i>
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  storyboard: { type: Object, default: null },
  references: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  ready: { type: Boolean, default: false },
})
const emit = defineEmits(['generate', 'upload', 'select', 'save-constraints'])

const fileInput = ref(null)
const canvas = ref(null)
const drawKind = ref('')
const draftLabel = ref('')
const draftBox = ref(null)
const drawStart = ref(null)
const constraints = ref(emptyConstraints())
const baseline = ref('')
const kinds = [
  { value: 'subject', label: '主体范围' },
  { value: 'prop', label: '道具范围' },
  { value: 'occlusion', label: '前景遮挡' },
  { value: 'movement', label: '可移动区域' },
]
const fieldByKind = { subject: 'subject_boxes', prop: 'prop_boxes', occlusion: 'occlusion_boxes', movement: 'movement_boxes' }
const currentReference = computed(() => props.references.find((item) => item.status === 'selected')
  || props.references.find((item) => Number(item.id) === Number(props.storyboard?.current_reference_version_id))
  || null)
const visibleBoxes = computed(() => kinds.flatMap((item) => (constraints.value[fieldByKind[item.value]] || []).map((value, index) => ({ kind: item.value, index, value }))))
const constraintCount = computed(() => visibleBoxes.value.length)
const constraintsDirty = computed(() => JSON.stringify(constraints.value) !== baseline.value)

watch(() => currentReference.value?.id, resetConstraints, { immediate: true })
watch(() => currentReference.value?.constraints_json, resetConstraints, { deep: true })

function emptyConstraints() {
  return { subject_boxes: [], prop_boxes: [], occlusion_boxes: [], movement_boxes: [] }
}
function clone(value) { return JSON.parse(JSON.stringify(value || {})) }
function resetConstraints() {
  constraints.value = { ...emptyConstraints(), ...clone(currentReference.value?.constraints_json) }
  baseline.value = JSON.stringify(constraints.value)
  draftBox.value = null
  drawStart.value = null
}
function point(event) {
  const rect = canvas.value?.getBoundingClientRect()
  if (!rect?.width || !rect?.height) return null
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  }
}
function startDraw(event) {
  if (!drawKind.value || props.busy) return
  const start = point(event)
  if (!start) return
  event.currentTarget.setPointerCapture?.(event.pointerId)
  drawStart.value = start
  draftBox.value = { x: start.x, y: start.y, width: 0, height: 0 }
}
function moveDraw(event) {
  if (!drawStart.value) return
  const current = point(event)
  if (!current) return
  draftBox.value = {
    x: Math.min(drawStart.value.x, current.x),
    y: Math.min(drawStart.value.y, current.y),
    width: Math.abs(current.x - drawStart.value.x),
    height: Math.abs(current.y - drawStart.value.y),
  }
}
function finishDraw(event) {
  if (!draftBox.value || !drawStart.value) return
  event.currentTarget.releasePointerCapture?.(event.pointerId)
  const box = draftBox.value
  if (box.width >= 0.015 && box.height >= 0.015) {
    const field = fieldByKind[drawKind.value]
    constraints.value[field].push({
      key: `${drawKind.value}_${constraints.value[field].length + 1}`,
      label: draftLabel.value || kindLabel(drawKind.value),
      ...box,
    })
    draftLabel.value = ''
  }
  draftBox.value = null
  drawStart.value = null
}
function cancelDraw() { draftBox.value = null; drawStart.value = null }
function removeBox(kind, index) { constraints.value[fieldByKind[kind]].splice(index, 1) }
function boxStyle(box) {
  return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }
}
function saveConstraints() {
  if (!currentReference.value || !constraintsDirty.value) return
  emit('save-constraints', { referenceId: currentReference.value.id, constraints: clone(constraints.value) })
}
function uploadFile(event) {
  const file = event.target.files?.[0]
  if (file) emit('upload', file)
  event.target.value = ''
}
function kindLabel(kind) { return kinds.find((item) => item.value === kind)?.label || kind }
function sourceLabel(kind) { return { upload: '本地上传', image_api: '图片 API', existing_upload: '历史上传', existing_generation: '历史生成' }[kind] || '参考图' }
</script>

<style scoped>
.reference-manager { margin-bottom: 30px; border-bottom: 1px solid var(--paper-line); padding-bottom: 28px; }
.reference-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; margin-bottom: 16px; }
.reference-heading > div:first-child { min-width: 0; }
.reference-heading span, .constraint-tools > div span, .history-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .14em; }
.reference-heading strong { display: block; margin-top: 6px; color: var(--paper-text); font: 600 18px Georgia, 'Songti SC', serif; }
.reference-heading p, .constraint-tools p { margin: 6px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.6; }
.reference-actions { display: flex; gap: 7px; flex-shrink: 0; }
button { border: 0; border-radius: 3px; cursor: pointer; transition: color .18s ease, background .18s ease, border-color .18s ease; }
button:disabled { opacity: .38; cursor: not-allowed; }
button.quiet { padding: 8px 10px; background: var(--paper-hover); color: var(--paper-muted); font-size: var(--paper-fs-sm); }
button.primary { padding: 8px 11px; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-sm); font-weight: 800; }
.reference-canvas-shell { display: grid; grid-template-columns: minmax(0, 1fr) 210px; background: #121310; }
.reference-canvas { position: relative; align-self: start; min-height: 220px; overflow: hidden; background: #0d0e0c; user-select: none; touch-action: none; }
.reference-canvas.drawing { cursor: crosshair; }
.reference-canvas > img { display: block; width: 100%; height: auto; min-height: 220px; object-fit: contain; pointer-events: none; }
.constraint-box { position: absolute; min-width: 18px; min-height: 18px; box-sizing: border-box; border: 1px solid currentColor; border-radius: 1px; background: color-mix(in srgb, currentColor 12%, transparent); color: #d8b35e; }
.constraint-box span { position: absolute; left: -1px; top: -18px; max-width: 150px; padding: 2px 5px; overflow: hidden; background: currentColor; color: #161713; font-size: var(--paper-fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.constraint-box i { position: absolute; right: 2px; top: 0; color: currentColor; font-style: normal; font-size: var(--paper-fs-base); opacity: 0; }
.constraint-box:hover i { opacity: 1; }
.constraint-box.prop { color: #73a5c9; }
.constraint-box.occlusion { color: #c77c6c; }
.constraint-box.movement { color: #78a879; }
.constraint-box.draft { pointer-events: none; border-style: dashed; }
.constraint-tools { padding: 18px; border-left: 1px solid #2b2c28; background: #191a17; }
.constraint-tools > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.constraint-tools > div strong { color: var(--paper-text); font-size: var(--paper-fs-base); }
.constraint-kinds { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 15px; }
.constraint-kinds button { padding: 7px 5px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-xs); }
.constraint-kinds button.active { border-color: currentColor; background: color-mix(in srgb, currentColor 12%, transparent); color: #d8b35e; }
.constraint-kinds button.prop.active { color: #73a5c9; }
.constraint-kinds button.occlusion.active { color: #c77c6c; }
.constraint-kinds button.movement.active { color: #78a879; }
.constraint-tools label { display: grid; gap: 6px; margin-top: 14px; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.constraint-tools input { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid var(--paper-line); outline: 0; background: #131411; color: var(--paper-text); font-size: var(--paper-fs-sm); }
.constraint-tools input:focus { border-color: var(--paper-accent); }
.save-constraints { width: 100%; margin-top: 12px; padding: 9px; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-sm); font-weight: 800; }
.reference-empty { min-height: 270px; display: grid; place-items: center; align-content: center; padding: 36px; text-align: center; background: radial-gradient(circle at 50% 42%, #25241f, #121310 70%); }
.reference-empty > span { color: #746c5e; font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .16em; }
.reference-empty strong { margin-top: 12px; color: #c4baaa; font: 500 21px Georgia, serif; }
.reference-empty p { max-width: 520px; margin: 9px 0 18px; color: #7e776b; font-size: var(--paper-fs-sm); line-height: 1.7; }
.reference-empty > div { display: flex; gap: 8px; }
.reference-history { margin-top: 14px; }
.history-heading { display: flex; justify-content: space-between; align-items: center; }
.history-heading small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.history-strip { display: grid; grid-auto-flow: column; grid-auto-columns: 116px; gap: 8px; margin-top: 9px; overflow-x: auto; padding-bottom: 4px; }
.history-strip button { position: relative; overflow: hidden; padding: 0; border: 1px solid var(--paper-line); background: #11120f; text-align: left; }
.history-strip button.selected { border-color: var(--paper-accent); }
.history-strip img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; opacity: .76; }
.history-strip button:hover:not(:disabled) img, .history-strip button.selected img { opacity: 1; }
.history-strip span, .history-strip i { display: block; padding: 5px 7px 0; color: var(--paper-muted); font-size: var(--paper-fs-xs); font-style: normal; }
.history-strip i { padding: 2px 7px 6px; color: var(--paper-accent); }
@media (max-width: 900px) {
  .reference-heading { flex-direction: column; }
  .reference-canvas-shell { grid-template-columns: 1fr; }
  .constraint-tools { border-left: 0; border-top: 1px solid #2b2c28; }
}
</style>
