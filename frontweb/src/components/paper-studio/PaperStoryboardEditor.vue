<template>
  <section v-if="storyboard" class="storyboard-editor">
    <header class="editor-heading">
      <div>
        <span>SHOT {{ String(storyboard.shot_number).padStart(2, '0') }}</span>
        <h2>{{ form.title || '未命名分镜' }}</h2>
      </div>
      <div class="editor-actions">
        <span class="save-state" :class="saveState">{{ saveStateLabel }}</span>
        <button
          v-if="!storyboardComplete"
          type="button"
          class="quiet repair"
          :disabled="busy || repairing || !canRepair"
          :title="canRepair ? '只补全当前镜头的空字段' : '请先在剧本与实体页保存剧本版本'"
          @click="$emit('repair')"
        >
          {{ repairing ? 'AI 补全中…' : 'AI 补全本镜' }}
        </button>
        <button type="button" class="quiet" :disabled="busy" @click="$emit('duplicate', storyboard.id)">复制</button>
        <button type="button" class="quiet danger" :disabled="busy" @click="$emit('delete', storyboard.id)">删除</button>
        <button type="button" class="save" :disabled="busy || !dirty || !formReady" @click="save">{{ busy ? '处理中…' : '保存分镜' }}</button>
      </div>
    </header>

    <div class="editor-body">
      <section v-if="repairPreview?.patches?.length" class="shot-repair-preview">
        <header>
          <div><span>AI REPAIR PREVIEW</span><strong>AI 补全建议 · 确认后保存为新的分镜版本</strong></div>
          <small>已有非空字段不会被覆盖</small>
        </header>
        <article v-for="patch in repairPreview.patches" :key="patch.field">
          <span>{{ repairFieldLabel(patch.field) }}</span>
          <del>原内容：未填写</del>
          <ins>{{ patch.after }}</ins>
        </article>
        <footer>
          <button type="button" class="accept" :disabled="busy || repairing" @click="$emit('accept-repair')">接受并保存</button>
          <button type="button" class="discard" :disabled="busy || repairing" @click="$emit('discard-repair')">放弃建议</button>
          <small>文本模型请求 {{ repairPreview.text_model_calls || 1 }} 次 · 图片 API 0 次</small>
        </footer>
      </section>

      <PaperReferenceManager
        :storyboard="storyboard"
        :references="references"
        :busy="busy"
        :ready="referenceReady"
        @generate="$emit('generate-reference')"
        @upload="$emit('upload-reference', $event)"
        @select="$emit('select-reference', $event)"
        @save-constraints="$emit('save-reference-constraints', $event)"
      />

      <video v-if="storyboard.published_video_url" class="published-video" controls :src="mediaUrl(storyboard.published_video_local_path || storyboard.published_video_url)" />

      <form class="script-form" @submit.prevent="save">
        <div class="field title-field">
          <label>分镜标题</label>
          <input v-model="form.title" :disabled="busy" maxlength="160" />
          <small v-if="!form.title.trim()" class="field-error">请输入分镜标题。</small>
        </div>
        <div class="field duration-field">
          <label>时长（秒）</label>
          <input v-model.number="form.duration" :disabled="busy" type="number" min="1" max="120" step="0.5" />
        </div>
        <div class="field wide">
          <label>画面描述</label>
          <textarea v-model="form.description" :disabled="busy" rows="3" maxlength="8000" placeholder="地点、时间、主体位置、前中后景关系和关键构图" />
          <small v-if="!form.description.trim()" class="field-error">请描述场景、主体位置或构图。</small>
        </div>
        <div class="field wide">
          <label>主体动作</label>
          <textarea v-model="form.action" :disabled="busy || form.environment_only" rows="3" maxlength="8000" :placeholder="form.environment_only ? '环境镜头不要求主体动作' : '谁做什么，动作从什么状态变化到什么状态；不要只写运镜'" />
          <small v-if="!form.environment_only && !form.action.trim()" class="field-error">请写清主体和动作变化，或标记为纯环境镜头。</small>
        </div>
        <div class="field wide environment-field">
          <label><input v-model="form.environment_only" :disabled="busy" type="checkbox" /> 这是纯环境镜头（没有人物或道具动作）</label>
          <small>勾选后仍需要完整画面描述，但不强制填写主体动作。</small>
        </div>
        <div class="field">
          <label>对白</label>
          <textarea v-model="form.dialogue" :disabled="busy" rows="3" maxlength="8000" />
        </div>
        <div class="field">
          <label>旁白</label>
          <textarea v-model="form.narration" :disabled="busy" rows="3" maxlength="8000" />
        </div>
        <div class="field">
          <label>景别</label>
          <input v-model="form.shot_type" :disabled="busy" maxlength="120" placeholder="例如：中景、全景、近景" />
        </div>
        <div class="field">
          <label>镜头意图</label>
          <input v-model="form.camera_motion" :disabled="busy" maxlength="120" placeholder="例如：固定机位、缓慢推近" />
        </div>
        <div class="field wide prompt-field">
          <label>参考图提示词补充</label>
          <textarea v-model="form.visual_prompt" :disabled="busy" rows="4" maxlength="12000" placeholder="补充纸张材质、时代、色彩和画面细节；服务端会自动加入纸片动画结构约束" />
        </div>
        <div class="field wide">
          <label>负面提示词</label>
          <textarea v-model="form.negative_prompt" :disabled="busy" rows="2" maxlength="8000" placeholder="例如：分栏、故事板网格、文字、水印、重复角色" />
        </div>
      </form>

      <PaperAudioWorkbench
        :storyboard="audioStoryboard"
        :audio="audio"
        :busy="busy"
        :fps="fps"
        @synthesize="$emit('synthesize-audio', $event)"
        @upload="$emit('upload-audio', $event)"
        @revise="$emit('revise-audio', $event)"
        @set-policy="$emit('set-audio-policy', $event)"
      />
    </div>
  </section>

  <section v-else class="editor-empty">
    <span>PAPER AUTHORING</span>
    <h2>{{ episode ? '创建第一条纸片分镜' : '创建一个纸片分集开始' }}</h2>
    <p>{{ episode ? '分镜脚本、参考图和后续正式素材都保存在独立纸片域中。' : '这里不再要求先去旧工作台建立分集和分镜。' }}</p>
    <button type="button" @click="$emit(episode ? 'create-storyboard' : 'create-episode')">{{ episode ? '＋ 新增分镜' : '＋ 新增纸片分集' }}</button>
  </section>
</template>

<script setup>
import { computed, reactive, watch } from 'vue'
import PaperReferenceManager from './PaperReferenceManager.vue'
import PaperAudioWorkbench from './PaperAudioWorkbench.vue'

const props = defineProps({
  storyboard: { type: Object, default: null },
  episode: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  saveState: { type: String, default: 'saved' },
  references: { type: Array, default: () => [] },
  referenceReady: { type: Boolean, default: false },
  storyboardComplete: { type: Boolean, default: false },
  canRepair: { type: Boolean, default: false },
  repairing: { type: Boolean, default: false },
  repairPreview: { type: Object, default: null },
  audio: { type: Object, default: null },
  fps: { type: Number, default: 30 },
})

const emit = defineEmits([
  'save', 'draft-change', 'duplicate', 'delete', 'create-storyboard', 'create-episode',
  'repair', 'accept-repair', 'discard-repair',
  'generate-reference', 'upload-reference', 'select-reference', 'save-reference-constraints',
  'synthesize-audio', 'upload-audio', 'revise-audio', 'set-audio-policy',
])

const fields = ['title', 'description', 'action', 'dialogue', 'narration', 'duration', 'shot_type', 'camera_motion', 'visual_prompt', 'negative_prompt', 'environment_only']
const form = reactive(Object.fromEntries(fields.map((key) => [key, key === 'duration' ? 6 : key === 'environment_only' ? false : ''])))
const baseline = reactive({})

watch(() => props.storyboard, (value) => {
  for (const key of fields) {
    const next = key === 'duration'
      ? Number(value?.[key] || props.episode?.default_duration || 6)
      : key === 'environment_only'
        ? Boolean(value?.[key])
        : (value?.[key] || '')
    form[key] = next
    baseline[key] = next
  }
}, { immediate: true })

const dirty = computed(() => fields.some((key) => String(form[key] ?? '') !== String(baseline[key] ?? '')))
const formReady = computed(() => Boolean(form.title.trim() && form.description.trim() && (form.environment_only || form.action.trim())))
const audioStoryboard = computed(() => ({ ...props.storyboard, ...Object.fromEntries(fields.map((key) => [key, form[key]])) }))
const saveStateLabel = computed(() => ({
  saving: '正在保存',
  unsaved: '未保存',
  failed: '保存失败',
  saved: '已保存',
}[props.saveState] || (dirty.value ? '未保存' : '已保存')))

watch(form, () => {
  if (!props.storyboard) return
  emit('draft-change', {
    storyboardId: Number(props.storyboard.id),
    payload: Object.fromEntries(fields.map((key) => [key, key === 'duration' ? Number(form[key]) : form[key]])),
    dirty: dirty.value,
  })
}, { deep: true })

function save() {
  if (!props.storyboard || !formReady.value) return
  emit('save', Object.fromEntries(fields.map((key) => [key, key === 'duration' ? Number(form[key]) : form[key]])))
}

function repairFieldLabel(field) {
  return { description: '画面描述', action: '主体动作' }[field] || field
}

function mediaUrl(value) {
  if (!value) return ''
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/static/')) return value
  return `/static/${String(value).replace(/^\/+/, '')}`
}
</script>

<style scoped>
.storyboard-editor { min-height: calc(100vh - 72px); animation: editor-in .2s ease both; }
@keyframes editor-in { from { opacity: .65; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.editor-heading { position: sticky; top: 0; z-index: 4; min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 0 28px; border-bottom: 1px solid var(--paper-line); background: rgb(27 28 26 / 94%); backdrop-filter: blur(14px); }
.editor-heading > div:first-child { min-width: 0; }
.editor-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .12em; }
.editor-heading h2 { margin: 4px 0 0; overflow: hidden; color: var(--paper-text); font: 600 19px/1.2 Georgia, 'Songti SC', serif; text-overflow: ellipsis; white-space: nowrap; }
.editor-actions { display: flex; align-items: center; gap: 7px; }
.editor-actions .save-state { margin-right: 6px; color: #8c877d; font-size: var(--paper-fs-xs); letter-spacing: 0; }
.editor-actions .save-state.unsaved, .editor-actions .save-state.failed { color: #c9956e; }
.editor-actions .save-state.saving { color: #8da7bd; }
.editor-actions .save-state.saved { color: #83a982; }
.editor-actions button { padding: 8px 10px; border: 0; border-radius: 3px; font-size: var(--paper-fs-sm); cursor: pointer; }
.editor-actions button:disabled { opacity: .4; cursor: not-allowed; }
.editor-actions .quiet { background: transparent; color: var(--paper-muted); }
.editor-actions .quiet:hover:not(:disabled) { background: var(--paper-hover); color: var(--paper-text); }
.editor-actions .quiet.repair { border: 1px solid #6d5934; color: var(--paper-accent); font-weight: 700; }
.editor-actions .danger:hover:not(:disabled) { color: #d48676; }
.editor-actions .save { min-width: 88px; background: var(--paper-accent); color: #211c13; font-weight: 800; }
.editor-body { width: min(920px, calc(100% - 56px)); margin: 0 auto; padding: 28px 0 72px; }
.shot-repair-preview { margin-bottom: 20px; border: 1px solid #6d5934; background: #171815; }
.shot-repair-preview > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--paper-line); }
.shot-repair-preview > header div { display: flex; flex-direction: column; gap: 5px; }
.shot-repair-preview > header span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .12em; }
.shot-repair-preview > header strong { color: var(--paper-text); font-size: var(--paper-fs-base); }
.shot-repair-preview > header small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.shot-repair-preview > article { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 8px 14px; padding: 14px 16px; border-bottom: 1px solid var(--paper-line-soft); }
.shot-repair-preview > article span { grid-row: 1 / 3; color: var(--paper-accent); font-size: var(--paper-fs-sm); font-weight: 700; }
.shot-repair-preview > article del { color: #9a6459; font-size: var(--paper-fs-xs); }
.shot-repair-preview > article ins { color: #a8c095; font-size: var(--paper-fs-sm); line-height: 1.65; text-decoration: none; }
.shot-repair-preview > footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 14px 16px; }
.shot-repair-preview > footer button { min-height: var(--paper-control-h); padding: 0 14px; cursor: pointer; }
.shot-repair-preview > footer button:disabled { opacity: .4; cursor: not-allowed; }
.shot-repair-preview .accept { border: 0; background: var(--paper-accent); color: #211c13; font-weight: 800; }
.shot-repair-preview .discard { border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); }
.shot-repair-preview > footer small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.published-video { width: 100%; margin-top: 16px; background: #10110f; }
.script-form { display: grid; grid-template-columns: 1fr 1fr; gap: 18px 22px; margin-top: 28px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.field.wide { grid-column: 1 / -1; }
.title-field { grid-column: 1 / 2; }
.duration-field { grid-column: 2 / 3; }
.field label { color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .08em; }
.field input, .field textarea { width: 100%; box-sizing: border-box; padding: 10px 0; border: 0; border-bottom: 1px solid var(--paper-line); outline: 0; resize: vertical; background: transparent; color: var(--paper-text); font: 11px/1.65 inherit; transition: border-color .16s ease; }
.field textarea { min-height: 54px; }
.field textarea:disabled { opacity: .45; cursor: not-allowed; }
.field-error { color: #d48676; font-size: var(--paper-fs-sm); }
.environment-field label { display: flex; align-items: center; gap: 8px; color: var(--paper-muted); letter-spacing: 0; }
.environment-field input { width: auto; }
.environment-field small { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.field input:focus, .field textarea:focus { border-color: var(--paper-accent); }
.prompt-field textarea { color: #d3c6ae; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--paper-fs-sm); }
.editor-empty { min-height: calc(100vh - 72px); display: grid; place-items: center; align-content: center; padding: 48px; text-align: center; }
.editor-empty span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .16em; }
.editor-empty h2 { margin: 14px 0 8px; color: var(--paper-text); font: 600 27px Georgia, 'Songti SC', serif; }
.editor-empty p { max-width: 440px; margin: 0; color: var(--paper-muted); font-size: var(--paper-fs-base); line-height: 1.7; }
.editor-empty button { margin-top: 24px; padding: 11px 16px; border: 0; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-sm); font-weight: 800; cursor: pointer; }
@media (max-width: 760px) {
  .editor-heading { padding: 0 16px; }
  .editor-body { width: calc(100% - 32px); }
  .script-form { grid-template-columns: 1fr; }
  .title-field, .duration-field, .field.wide { grid-column: 1; }
  .editor-actions .quiet:not(.repair), .save-state { display: none; }
}
</style>
