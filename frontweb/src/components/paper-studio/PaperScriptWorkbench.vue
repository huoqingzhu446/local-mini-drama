<template>
  <section class="script-workbench">
    <header class="script-heading">
      <div>
        <span>SCRIPT · S1</span>
        <h3>剧本与实体</h3>
        <p>粘贴或上传本集剧本并保存为版本；提取实体与自动分镜将以已保存版本为唯一输入，不会读取未保存内容。</p>
      </div>
      <div class="pipeline-hint" aria-label="流水线阶段">
        <i class="done">① 剧本</i><i>② 提取实体</i><i>③ 生成形象</i><i>④ 自动分镜</i>
      </div>
    </header>

    <div v-if="!episode" class="script-empty">
      <strong>还没有选择纸片分集</strong>
      <p>先在左栏新建或选择一个纸片分集，再导入剧本。</p>
    </div>

    <div v-else class="script-body">
      <div class="script-editor-pane">
        <div class="editor-toolbar">
          <label class="upload-button">
            上传 txt / md
            <input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" @change="onFileChosen" />
          </label>
          <span class="char-count">{{ draft.length }} 字</span>
          <span v-if="dirty" class="dirty-flag">未保存</span>
          <span v-else-if="activeVersionLabel" class="saved-flag">{{ activeVersionLabel }}</span>
        </div>
        <textarea
          v-model="draft"
          class="script-textarea"
          :placeholder="placeholder"
          spellcheck="false"
          @input="dirty = true"
        />
        <div class="editor-actions">
          <button type="button" class="primary" :disabled="busy || saving || draft.trim().length < 20" @click="save">
            {{ saving ? '正在保存…' : '保存为新版本' }}
          </button>
          <small v-if="draft.trim().length && draft.trim().length < 20">剧本至少 20 个字才能保存。</small>
          <small v-else>保存不消耗任何模型调用；相同内容不会重复建版。</small>
        </div>

        <div class="next-steps">
          <article class="ready">
            <strong>② 一键提取人物 / 场景 / 道具</strong>
            <p>已开放：保存剧本后，到下方「实体库」面板点「提取人物 / 场景 / 道具」，逐项确认后入库。0 图片调用。</p>
          </article>
          <article class="ready">
            <strong>④ 一键生成纸片分镜</strong>
            <p>按剧本 + 实体库生成分镜草稿并自动绑定实体，预览满意后再应用。0 图片调用。</p>
            <div class="gen-controls">
              <label>目标镜数
                <input v-model.number="targetShotCount" type="number" min="1" max="48" placeholder="自动" />
              </label>
              <button
                type="button"
                class="gen-button"
                :disabled="!canGen || generatingStoryboards || repairing || busy"
                @click="emitGenerate"
              >
                {{ generatingStoryboards ? `正在生成… ${genElapsed}s` : '生成纸片分镜' }}
              </button>
            </div>
            <small v-if="generatingStoryboards">文本模型正在拆解剧本，通常 15–60 秒；上游超时会自动重试最多 3 次，5 分钟无响应会报错。</small>
            <small v-else-if="genDisabledReason" class="gen-reason">⛔ {{ genDisabledReason }}</small>
          </article>
        </div>

        <div v-if="sbDraft?.shots?.length" ref="draftPanel" class="draft-panel">
          <div class="draft-heading">
            <strong>分镜草稿预览 · 来自剧本 v{{ sbDraft.script?.version_number }} · {{ sbDraft.shots.length }} 镜</strong>
            <div class="draft-heading-actions">
              <span v-if="draftIssues.length" class="draft-incomplete">{{ issueShotCount }} 镜不完整</span>
              <span v-else>完整性检查通过 · 应用前不会写入数据</span>
              <button
                v-if="draftIssues.length"
                type="button"
                class="repair-button"
                :disabled="busy || applying || repairing"
                @click="$emit('repair-storyboards')"
              >{{ repairing ? 'AI 补全中…' : `AI 补全缺失内容（${issueShotCount} 镜）` }}</button>
            </div>
          </div>
          <p v-for="(warning, index) in sbDraft.warnings || []" :key="index" class="draft-warning">⚠ {{ warning }}</p>
          <article v-for="(shot, index) in sbDraft.shots" :key="index" class="draft-shot">
            <span class="draft-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <div class="draft-copy">
              <strong>{{ shot.title }} <i>{{ shot.duration }}s · {{ shot.shot_type || '—' }} · {{ shot.camera_motion || '—' }}</i></strong>
              <p v-if="shot.description">{{ shot.description }}</p>
              <p v-else class="draft-missing">⚠ 缺少画面描述</p>
              <p v-if="shot.action" class="draft-action">动作：{{ shot.action }}</p>
              <p v-else-if="!shot.environment_only" class="draft-missing">⚠ 缺少主体动作</p>
              <p v-if="shot.dialogue" class="draft-dialogue">对白：{{ shot.dialogue }}</p>
              <div class="draft-chips">
                <em v-if="shot.scene_entity_name" class="chip scene">场景 · {{ shot.scene_entity_name }}</em>
                <em v-for="name in shot.character_entity_names" :key="'c' + name" class="chip character">{{ name }}</em>
                <em v-for="name in shot.prop_entity_names" :key="'p' + name" class="chip prop">{{ name }}</em>
                <em v-if="shot.environment_only" class="chip env">纯环境镜头</em>
              </div>
            </div>
          </article>
          <section v-if="repairPreview?.patches?.length" class="repair-preview">
            <header>
              <div>
                <span>AI REPAIR PREVIEW</span>
                <strong>AI 补全建议 · {{ repairPreview.repaired_shot_count }} 镜 / {{ repairPreview.patches.length }} 个字段</strong>
              </div>
              <small>仅补空字段，确认前不会修改草稿</small>
            </header>
            <article v-for="patch in repairPreview.patches" :key="`${patch.shot_number}:${patch.field}`">
              <div class="repair-meta">
                <span>SHOT {{ String(patch.shot_number).padStart(2, '0') }}</span>
                <strong>{{ patch.title }}</strong>
                <i>{{ repairFieldLabel(patch.field) }}</i>
              </div>
              <div class="repair-diff">
                <del>原内容：未填写</del>
                <ins>{{ patch.after }}</ins>
              </div>
            </article>
            <p v-if="repairPreview.issues?.length" class="repair-remaining">仍有 {{ repairPreview.issues.length }} 镜未补全；可先接受本次结果，再次执行 AI 补全。</p>
            <footer>
              <button type="button" class="primary" :disabled="busy || applying" @click="$emit('accept-repairs')">接受并写入草稿</button>
              <button type="button" class="ghost" :disabled="busy || applying" @click="$emit('discard-repairs')">放弃本次建议</button>
              <small>文本模型调用 {{ repairPreview.text_model_calls || 1 }} 次 · 图片 API 0 次</small>
            </footer>
          </section>
          <div class="draft-footer">
            <div class="mode-select" role="radiogroup" aria-label="应用方式">
              <button type="button" :class="{ active: applyMode === 'append' }" @click="applyMode = 'append'">追加到现有分镜后</button>
              <button type="button" :class="{ active: applyMode === 'replace' }" @click="applyMode = 'replace'">替换未发布分镜</button>
            </div>
            <button
              type="button"
              class="primary"
              :disabled="busy || applying || repairing || draftIssues.length > 0 || Boolean(repairPreview)"
              :title="draftIssues.length ? '请先补齐所有画面描述和主体动作' : repairPreview ? '请先接受或放弃 AI 补全建议' : ''"
              @click="$emit('apply-storyboards', applyMode)"
            >
              {{ applying ? '正在应用…' : `应用 ${sbDraft.shots.length} 个分镜` }}
            </button>
            <button type="button" class="ghost" :disabled="applying || repairing" @click="$emit('discard-draft')">丢弃草稿</button>
          </div>
        </div>
      </div>

      <aside class="script-versions">
        <div class="versions-heading">
          <span>版本历史</span>
          <i>{{ scripts.length }}</i>
        </div>
        <p v-if="!scripts.length" class="versions-empty">保存后第一版会出现在这里；每一版都不可变，提取与分镜生成永远指向确定版本。</p>
        <button
          v-for="item in scripts"
          :key="item.id"
          type="button"
          class="version-item"
          :class="{ active: Number(item.id) === Number(activeScriptId) }"
          :disabled="busy"
          @click="$emit('select-version', item.id)"
        >
          <span class="version-number">v{{ item.version_number }}</span>
          <span class="version-copy">
            <strong>{{ sourceLabel(item.source_kind) }} · {{ item.content_length }} 字</strong>
            <small>{{ formatTime(item.created_at) }}</small>
          </span>
          <span v-if="Number(item.id) === Number(latest?.id)" class="version-latest">最新</span>
        </button>
      </aside>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  episode: { type: Object, default: null },
  scripts: { type: Array, default: () => [] },
  latest: { type: Object, default: null },
  activeScript: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  draft: { type: Object, default: null },
  generatingStoryboards: { type: Boolean, default: false },
  applying: { type: Boolean, default: false },
  repairing: { type: Boolean, default: false },
  repairPreview: { type: Object, default: null },
  canGenerateStoryboards: { type: Boolean, default: false },
  hasEntities: { type: Boolean, default: false },
})
const emit = defineEmits([
  'save', 'select-version', 'generate-storyboards', 'repair-storyboards', 'accept-repairs', 'discard-repairs',
  'apply-storyboards', 'discard-draft',
])

const targetShotCount = ref(null)
const applyMode = ref('append')
// prop `draft`（分镜草稿）被本地剧本文本 ref `draft` 遮蔽，模板一律通过 sbDraft 访问
const sbDraft = computed(() => props.draft)
const draftIssues = computed(() => (sbDraft.value?.shots || []).flatMap((shot, index) => {
  const missingFields = []
  if (!String(shot?.description || '').trim()) missingFields.push('description')
  if (!Boolean(shot?.environment_only) && !String(shot?.action || '').trim()) missingFields.push('action')
  return missingFields.length ? [{ shot_index: index, missing_fields: missingFields }] : []
}))
const issueShotCount = computed(() => new Set(draftIssues.value.map((item) => item.shot_index)).size)
const draftPanel = ref(null)
watch(() => props.draft, async (draft) => {
  if (draft?.shots?.length) {
    await nextTick()
    draftPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
})
const genElapsed = ref(0)
let genTimer = null
watch(() => props.generatingStoryboards, (now) => {
  if (genTimer) { clearInterval(genTimer); genTimer = null }
  genElapsed.value = 0
  if (now) genTimer = setInterval(() => { genElapsed.value += 1 }, 1000)
})
// 组件内自算启用条件（父组件热更新滞后也不影响），并给出精确禁用原因
const canGen = computed(() => props.canGenerateStoryboards || (props.scripts.length > 0 && props.hasEntities))
const genDisabledReason = computed(() => {
  if (props.busy) return '有其他操作进行中，请稍候'
  if (!props.scripts.length) return '还没有已保存的剧本版本：先在上方保存剧本'
  if (!props.hasEntities && !props.canGenerateStoryboards) return '实体库为空：先在下方「提取人物 / 场景 / 道具」并确认入库（若实体明明已存在，请按 Cmd+Shift+R 强刷页面）'
  return ''
})

function emitGenerate() {
  emit('generate-storyboards', {
    target_shot_count: targetShotCount.value || null,
    script_version_id: props.activeScript?.id || null,
  })
}

function repairFieldLabel(field) {
  return { description: '画面描述', action: '主体动作' }[field] || field
}

const draft = ref('')
const dirty = ref(false)
const activeScriptId = computed(() => props.activeScript?.id || null)
const placeholder = '把本集剧本粘贴到这里……\n\n支持自由格式：旁白、对白、场景描述都可以。\n保存为版本后，「提取实体」和「生成分镜」会以该版本为准。'

const activeVersionLabel = computed(() => {
  if (props.activeScript) return `正在查看 v${props.activeScript.version_number}`
  return ''
})

watch(() => props.activeScript, (script) => {
  if (script?.content != null) {
    draft.value = script.content
    dirty.value = false
  }
})

watch(() => props.episode?.id, () => {
  draft.value = ''
  dirty.value = false
})

function save() {
  emit('save', draft.value, 'manual')
  dirty.value = false
}

function onFileChosen(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    draft.value = String(reader.result || '')
    dirty.value = true
  }
  reader.readAsText(file)
}

function sourceLabel(kind) {
  if (kind === 'file_upload') return '上传文件'
  if (kind === 'legacy_copy') return '旧工作台复制'
  return '手动粘贴'
}

function formatTime(value) {
  if (!value) return ''
  try { return new Date(value).toLocaleString() } catch (_) { return value }
}
</script>

<style scoped>
.script-workbench { display: flex; flex-direction: column; min-height: 100%; }
.script-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 24px 24px 16px; border-bottom: 1px solid var(--paper-line); }
.script-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .14em; }
.script-heading h3 { margin: 6px 0 8px; color: var(--paper-text); font: 600 22px/1.2 Georgia, 'Songti SC', serif; }
.script-heading p { margin: 0; max-width: 560px; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.65; }
.pipeline-hint { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.pipeline-hint i { padding: 6px 10px; border: 1px solid var(--paper-line); color: var(--paper-dim); font-style: normal; font-size: var(--paper-fs-xs); white-space: nowrap; }
.pipeline-hint i.done { border-color: #6d5934; color: var(--paper-accent); }
.script-empty { display: grid; place-content: center; gap: 8px; padding: 64px 24px; text-align: center; color: var(--paper-muted); }
.script-empty strong { font-size: var(--paper-fs-lg); color: var(--paper-text); }
.script-empty p { margin: 0; font-size: var(--paper-fs-sm); }
.script-body { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 0; }
.script-editor-pane { min-width: 0; display: flex; flex-direction: column; padding: 20px 24px 24px; }
.editor-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.upload-button { position: relative; display: inline-flex; align-items: center; min-height: var(--paper-hit-min); padding: 0 14px; border: 1px solid var(--paper-line); color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.upload-button:hover { border-color: var(--paper-accent); color: var(--paper-accent); }
.upload-button input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.char-count { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.dirty-flag { color: #bd9c5d; font-size: var(--paper-fs-sm); }
.saved-flag { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.script-textarea { flex: 1; min-height: 320px; box-sizing: border-box; width: 100%; padding: 16px; border: 1px solid var(--paper-line); outline: 0; resize: vertical; background: #131412; color: var(--paper-text); font: var(--paper-fs-base)/1.8 inherit; }
.script-textarea:focus { border-color: var(--paper-accent); }
.editor-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.editor-actions .primary { min-height: var(--paper-control-h-primary); padding: 0 22px; border: 0; border-radius: 2px; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-base); font-weight: 800; cursor: pointer; }
.editor-actions .primary:hover:not(:disabled) { filter: brightness(1.08); }
.editor-actions .primary:disabled { opacity: .38; cursor: not-allowed; }
.editor-actions small { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.next-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 24px; }
.next-steps article { padding: 16px; border: 1px dashed var(--paper-line); }
.next-steps article.ready { border-style: solid; border-color: #6d5934; }
.gen-controls { display: flex; align-items: flex-end; gap: 12px; }
.gen-controls label { display: flex; flex-direction: column; gap: 6px; color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.gen-controls input { width: 90px; box-sizing: border-box; min-height: var(--paper-control-h); padding: 0 10px; border: 1px solid var(--paper-line); outline: 0; background: #131412; color: var(--paper-text); font-size: var(--paper-fs-base); }
.gen-controls input:focus { border-color: var(--paper-accent); }
.gen-button { min-height: var(--paper-control-h-primary); padding: 0 20px; border: 0; border-radius: 2px; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-base); font-weight: 800; cursor: pointer; }
.gen-button:hover:not(:disabled) { filter: brightness(1.08); }
.gen-button:disabled { opacity: .38; cursor: not-allowed; }
.gen-reason { display: block; margin-top: 8px; color: #bd9c5d !important; }
.draft-panel { margin-top: 24px; border: 1px solid #6d5934; }
.draft-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--paper-line); }
.draft-heading strong { color: var(--paper-text); font-size: var(--paper-fs-base); }
.draft-heading span { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.draft-heading-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.draft-heading-actions .draft-incomplete { color: #cf846f; font-weight: 700; }
.repair-button { min-height: var(--paper-control-h); padding: 0 14px; border: 1px solid var(--paper-accent); background: transparent; color: var(--paper-accent); font-size: var(--paper-fs-sm); font-weight: 700; cursor: pointer; }
.repair-button:hover:not(:disabled) { background: color-mix(in srgb, var(--paper-accent) 10%, transparent); }
.repair-button:disabled { opacity: .38; cursor: not-allowed; }
.draft-warning { margin: 10px 16px 0; color: #bd9c5d; font-size: var(--paper-fs-sm); }
.draft-shot { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--paper-line-soft); }
.draft-number { color: var(--paper-dim); font: 700 var(--paper-fs-sm) ui-monospace, monospace; }
.draft-copy strong { display: block; color: var(--paper-text); font-size: var(--paper-fs-base); }
.draft-copy strong i { color: var(--paper-dim); font-style: normal; font-size: var(--paper-fs-xs); font-weight: 500; }
.draft-copy p { margin: 6px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.6; }
.draft-copy .draft-action { color: var(--paper-text); }
.draft-copy .draft-dialogue { color: var(--paper-dim); }
.draft-copy .draft-missing { color: #cf846f; font-weight: 700; }
.draft-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { padding: 3px 8px; border: 1px solid var(--paper-line); color: var(--paper-muted); font-style: normal; font-size: var(--paper-fs-xs); }
.chip.scene { border-color: #4c5a6a; color: #8aa3bd; }
.chip.character { border-color: #6d5934; color: var(--paper-accent); }
.chip.prop { border-color: #4c6a4b; color: #83a982; }
.chip.env { border-style: dashed; }
.repair-preview { margin: 14px 16px 0; border: 1px solid #6d5934; background: #171815; }
.repair-preview > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px; border-bottom: 1px solid var(--paper-line); }
.repair-preview > header div { display: flex; flex-direction: column; gap: 5px; }
.repair-preview > header span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .12em; }
.repair-preview > header strong { color: var(--paper-text); font-size: var(--paper-fs-base); }
.repair-preview > header small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.repair-preview > article { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 16px; padding: 14px; border-bottom: 1px solid var(--paper-line-soft); }
.repair-meta { display: flex; flex-direction: column; gap: 4px; }
.repair-meta span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .1em; }
.repair-meta strong { color: var(--paper-text); font-size: var(--paper-fs-sm); }
.repair-meta i { color: var(--paper-dim); font-size: var(--paper-fs-xs); font-style: normal; }
.repair-diff { display: flex; flex-direction: column; gap: 7px; }
.repair-diff del { color: #9a6459; font-size: var(--paper-fs-xs); text-decoration: line-through; }
.repair-diff ins { color: #a8c095; font-size: var(--paper-fs-sm); line-height: 1.65; text-decoration: none; }
.repair-remaining { margin: 12px 14px 0; color: #cf846f; font-size: var(--paper-fs-sm); }
.repair-preview > footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 14px; }
.repair-preview > footer .primary { min-height: var(--paper-control-h-primary); padding: 0 18px; border: 0; background: var(--paper-accent); color: #211c13; font-weight: 800; cursor: pointer; }
.repair-preview > footer .ghost { min-height: var(--paper-control-h); padding: 0 14px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); cursor: pointer; }
.repair-preview > footer button:disabled { opacity: .38; cursor: not-allowed; }
.repair-preview > footer small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.draft-footer { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; }
.mode-select { display: flex; }
.mode-select button { min-height: var(--paper-control-h); padding: 0 14px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.mode-select button.active { border-color: var(--paper-accent); color: var(--paper-accent); }
.draft-footer .primary { min-height: var(--paper-control-h-primary); padding: 0 20px; border: 0; border-radius: 2px; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-base); font-weight: 800; cursor: pointer; }
.draft-footer .primary:disabled { opacity: .38; cursor: not-allowed; }
.draft-footer .ghost { min-height: var(--paper-control-h); padding: 0 16px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.next-steps strong { display: block; color: var(--paper-text); font-size: var(--paper-fs-base); }
.next-steps p { margin: 8px 0 12px; color: var(--paper-dim); font-size: var(--paper-fs-sm); line-height: 1.6; }
.next-steps button { min-height: var(--paper-hit-min); padding: 0 14px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-dim); font-size: var(--paper-fs-sm); cursor: not-allowed; opacity: .6; }
.script-versions { border-left: 1px solid var(--paper-line); padding: 20px 0; overflow-y: auto; }
.versions-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 18px 12px; color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.versions-heading i { display: grid; place-items: center; min-width: 20px; height: 20px; border: 1px solid var(--paper-line); border-radius: 50%; font-style: normal; font-size: var(--paper-fs-xs); }
.versions-empty { margin: 0; padding: 0 18px; color: var(--paper-dim); font-size: var(--paper-fs-sm); line-height: 1.65; }
.version-item { width: calc(100% - 20px); min-height: var(--paper-hit-min); display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 10px; margin: 0 10px 4px; padding: 12px 10px; border: 0; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.version-item:hover, .version-item.active { background: var(--paper-hover); }
.version-item:disabled { opacity: .5; cursor: not-allowed; }
.version-number { color: var(--paper-dim); font: 700 var(--paper-fs-sm) ui-monospace, monospace; }
.version-item.active .version-number { color: var(--paper-accent); }
.version-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.version-copy strong { color: var(--paper-text); font-size: var(--paper-fs-sm); font-weight: 600; }
.version-copy small { overflow: hidden; color: var(--paper-dim); font-size: var(--paper-fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.version-latest { padding: 3px 7px; border: 1px solid #6d5934; color: var(--paper-accent); font-size: var(--paper-fs-xs); }
@media (max-width: 1180px) {
  .script-body { grid-template-columns: 1fr; }
  .script-versions { border-left: 0; border-top: 1px solid var(--paper-line); }
  .repair-preview > article { grid-template-columns: 1fr; }
}
</style>
