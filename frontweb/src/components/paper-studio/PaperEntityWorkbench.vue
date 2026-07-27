<template>
  <section class="entity-workbench">
    <header class="entity-heading">
      <div>
        <span>ENTITIES · S2</span>
        <h3>实体库</h3>
        <p>从已保存剧本一键提取人物、场景、道具；确认入库后，它们将成为分镜绑定与素材复用的唯一来源。提取只使用文本模型，0 图片调用。</p>
      </div>
      <div class="heading-actions">
        <button type="button" class="extract-button" :disabled="!canExtract || extracting || busy" @click="$emit('extract')">
          {{ extracting ? '正在提取…' : '提取人物 / 场景 / 道具' }}
        </button>
        <button
          type="button"
          class="extract-button identity"
          :disabled="!selectedIds.length || generating || busy || !providerReady"
          :title="providerReady ? '' : '先在右栏选择可用的图片 API'"
          @click="$emit('generate-identities', selectedIds)"
        >
          {{ generating ? `正在生成形象… ${genElapsed}s` : `生成形象（${selectedIds.length} 次图片调用）` }}
        </button>
      </div>
    </header>

    <div v-if="!canExtract && !entities.length" class="entity-empty">
      <p>先在上方保存一版剧本，然后点「提取人物 / 场景 / 道具」。</p>
    </div>

    <!-- 提取候选确认面板（BR-014：确认前不落库） -->
    <div v-if="candidates.length" class="candidate-panel">
      <div class="candidate-heading">
        <strong>提取结果确认 · 来自剧本 v{{ extraction?.script?.version_number }}</strong>
        <span>{{ decidedCount }}/{{ candidates.length }} 已决定</span>
      </div>
      <p v-if="extraction?.truncated" class="candidate-warning">剧本较长，本次只分析了前 3 万字；可以分段保存后分别提取。</p>
      <article v-for="(candidate, index) in candidates" :key="index" class="candidate-item" :class="candidate.action">
        <span class="candidate-type" :data-type="candidate.entity_type">{{ typeLabel(candidate.entity_type) }}</span>
        <div class="candidate-copy">
          <input v-model="candidate.name" type="text" maxlength="120" aria-label="实体名称" />
          <textarea v-model="candidate.description" rows="2" maxlength="2000" aria-label="画面描述" />
          <small v-if="candidate.aliases.length">别名：{{ candidate.aliases.join('、') }}</small>
          <small v-if="candidate.merge_into_name" class="merge-hint">库中已有「{{ candidate.merge_into_name }}」，建议合并</small>
        </div>
        <div class="candidate-actions" role="radiogroup" aria-label="处理方式">
          <button type="button" :class="{ active: candidate.action === 'new' }" @click="candidate.action = 'new'">新增入库</button>
          <button
            type="button"
            :disabled="!candidate.merge_into_id"
            :class="{ active: candidate.action === 'merge' }"
            @click="candidate.action = 'merge'"
          >合并</button>
          <button type="button" :class="{ active: candidate.action === 'ignore' }" @click="candidate.action = 'ignore'">忽略</button>
        </div>
      </article>
      <div class="candidate-footer">
        <button type="button" class="primary" :disabled="busy || confirming" @click="confirmAll">
          {{ confirming ? '正在入库…' : `确认入库（新增 ${newCount} · 合并 ${mergeCount} · 忽略 ${ignoreCount}）` }}
        </button>
        <button type="button" class="ghost" :disabled="confirming" @click="$emit('discard')">全部丢弃</button>
        <small>确认前不会写入任何数据；丢弃无副作用。</small>
      </div>
    </div>

    <!-- 实体库 -->
    <div v-if="entities.length" class="library-grid">
      <section v-for="group in groups" :key="group.type" class="library-column">
        <div class="column-heading">
          <span>{{ typeLabel(group.type) }}</span>
          <i>{{ group.items.length }}</i>
        </div>
        <p v-if="!group.items.length" class="column-empty">暂无{{ typeLabel(group.type) }}</p>
        <article v-for="entity in group.items" :key="entity.id" class="entity-card">
          <div class="entity-card-head">
            <label class="entity-select">
              <input type="checkbox" :value="entity.id" v-model="selectedIds" :disabled="generating || busy" />
              <strong>{{ entity.name }}</strong>
            </label>
            <span class="identity-state" :class="entity.identity_status">{{ identityLabel(entity) }}</span>
          </div>
          <div v-if="previewPath(entity)" class="identity-preview" :class="{ transparent: Boolean(entity.latest_version?.alpha_local_path || entity.identity_alpha_local_path) }">
            <img :src="mediaUrl(previewPath(entity))" :alt="`${entity.name} 形象`" loading="lazy" />
          </div>
          <div v-if="entity.latest_version?.status === 'candidate'" class="identity-review">
            <span>形象 v{{ entity.latest_version.version_number }} 待审核</span>
            <button type="button" class="approve" :disabled="busy" @click="$emit('review-identity', entity.latest_version, 'approve', entity)">批准</button>
            <button type="button" class="reject" :disabled="busy" @click="$emit('review-identity', entity.latest_version, 'reject', entity)">退回</button>
          </div>
          <p class="entity-desc">{{ entity.description || '（还没有画面描述）' }}</p>
          <small v-if="entity.aliases.length" class="entity-aliases">别名：{{ entity.aliases.join('、') }}</small>
          <div class="entity-meta">
            <span v-if="entity.entity_type !== 'scene'">身高比 {{ entity.scale_anchor?.relative_height ?? '—' }}</span>
            <span>被 {{ entity.reference_count }} 个分镜引用</span>
          </div>
          <div class="entity-actions">
            <button type="button" :disabled="busy" @click="startEdit(entity)">编辑</button>
            <button type="button" :disabled="busy" class="danger" @click="$emit('archive', entity)">归档</button>
          </div>
        </article>
      </section>
    </div>

    <!-- 风格锚 -->
    <div class="style-anchor">
      <div class="column-heading"><span>全剧风格锚</span><i>C6</i></div>
      <p>写一段统一画风描述（如：剪纸质感、扁平色块、粗描边、暖色纸纹）。生成实体形象时会注入所有 prompt，保证整部剧画风一致。</p>
      <textarea v-model="anchorDraft" rows="2" maxlength="2000" placeholder="例如：手工剪纸风格，扁平色块，粗黑描边，暖米色纸张纹理，柔和侧光" />
      <button type="button" :disabled="busy || anchorDraft === (styleAnchor?.anchor_text || '')" @click="$emit('save-style-anchor', anchorDraft)">
        保存风格锚
      </button>
    </div>

    <!-- 实体编辑弹层 -->
    <div v-if="editing" class="edit-layer" @keydown.esc="editing = null">
      <div class="edit-dialog" role="dialog" aria-modal="true">
        <strong>编辑{{ typeLabel(editing.entity_type) }}</strong>
        <label>名称<input v-model="editForm.name" type="text" maxlength="120" /></label>
        <label>画面描述<textarea v-model="editForm.description" rows="4" maxlength="2000" /></label>
        <label v-if="editing.entity_type !== 'scene'">
          相对身高（成人=1.0）
          <input v-model.number="editForm.relative_height" type="number" step="0.05" min="0.01" max="3" />
        </label>
        <div class="edit-actions">
          <button type="button" class="primary" :disabled="busy || !editForm.name.trim()" @click="submitEdit">保存</button>
          <button type="button" class="ghost" @click="editing = null">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  library: { type: Object, default: null },
  extraction: { type: Object, default: null },
  extracting: { type: Boolean, default: false },
  confirming: { type: Boolean, default: false },
  canExtract: { type: Boolean, default: false },
  generating: { type: Boolean, default: false },
  providerReady: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['extract', 'confirm', 'discard', 'update-entity', 'archive', 'save-style-anchor', 'generate-identities', 'review-identity'])

const selectedIds = ref([])
const genElapsed = ref(0)
let genTimer = null
watch(() => props.generating, (now) => {
  if (genTimer) { clearInterval(genTimer); genTimer = null }
  genElapsed.value = 0
  if (now) genTimer = setInterval(() => { genElapsed.value += 1 }, 1000)
})

function previewPath(entity) {
  const version = entity.latest_version
  return version?.alpha_local_path || version?.source_local_path
    || entity.identity_alpha_local_path || entity.identity_source_local_path || null
}

function mediaUrl(value) {
  if (!value) return ''
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/static/')) return value
  return `/static/${String(value).replace(/^\/+/, '')}`
}

const entities = computed(() => props.library?.entities || [])
const styleAnchor = computed(() => props.library?.style_anchor || null)
const groups = computed(() => ['character', 'scene', 'prop'].map((type) => ({
  type,
  items: entities.value.filter((item) => item.entity_type === type && item.status !== 'archived'),
})))

const candidates = ref([])
watch(() => props.extraction, (extraction) => {
  candidates.value = (extraction?.candidates || []).map((item) => ({
    ...item,
    aliases: item.aliases || [],
    action: item.suggested_action === 'merge' ? 'merge' : 'new',
  }))
}, { immediate: true })

const decidedCount = computed(() => candidates.value.length)
const newCount = computed(() => candidates.value.filter((item) => item.action === 'new').length)
const mergeCount = computed(() => candidates.value.filter((item) => item.action === 'merge').length)
const ignoreCount = computed(() => candidates.value.filter((item) => item.action === 'ignore').length)

function confirmAll() {
  const items = candidates.value
    .filter((item) => item.name.trim())
    .map((item) => ({
      action: item.action,
      entity_type: item.entity_type,
      name: item.name.trim(),
      description: item.description || '',
      aliases: item.aliases,
      relative_height: item.relative_height ?? null,
      ...(item.action === 'merge' ? { merge_into_id: item.merge_into_id } : {}),
    }))
  emit('confirm', items)
}

const anchorDraft = ref('')
watch(styleAnchor, (anchor) => { anchorDraft.value = anchor?.anchor_text || '' }, { immediate: true })

watch(() => props.generating, (now, before) => { if (before && !now) selectedIds.value = [] })

const editing = ref(null)
const editForm = reactive({ name: '', description: '', relative_height: null })

function startEdit(entity) {
  editing.value = entity
  editForm.name = entity.name
  editForm.description = entity.description
  editForm.relative_height = entity.scale_anchor?.relative_height ?? null
}

function submitEdit() {
  emit('update-entity', editing.value, {
    name: editForm.name.trim(),
    description: editForm.description,
    ...(editing.value.entity_type !== 'scene' ? { relative_height: editForm.relative_height || null } : {}),
  })
  editing.value = null
}

function typeLabel(type) {
  if (type === 'character') return '人物'
  if (type === 'scene') return '场景'
  return '道具'
}

function identityLabel(entity) {
  if (entity.identity_status === 'approved') return `形象 v${entity.identity_version_number}`
  if (entity.identity_status === 'candidate') return '形象待审核'
  return '未生成形象'
}
</script>

<style scoped>
.entity-workbench { border-top: 1px solid var(--paper-line); }
.entity-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 24px 24px 16px; }
.entity-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .14em; }
.entity-heading h3 { margin: 6px 0 8px; color: var(--paper-text); font: 600 22px/1.2 Georgia, 'Songti SC', serif; }
.entity-heading p { margin: 0; max-width: 560px; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.65; }
.extract-button { flex-shrink: 0; min-height: var(--paper-control-h-primary); padding: 0 22px; border: 0; border-radius: 2px; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-base); font-weight: 800; cursor: pointer; }
.extract-button:hover:not(:disabled) { filter: brightness(1.08); }
.extract-button:disabled { opacity: .38; cursor: not-allowed; }
.heading-actions { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.extract-button.identity { background: transparent; border: 1px solid #6d5934; color: var(--paper-accent); }
.entity-select { display: flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }
.entity-select input { width: 16px; height: 16px; accent-color: var(--paper-accent); cursor: pointer; }
.identity-preview { margin-top: 10px; display: grid; place-items: center; max-height: 220px; overflow: hidden; border: 1px solid var(--paper-line); background: #131412; }
.identity-preview.transparent { background: repeating-conic-gradient(#1d1e1b 0% 25%, #262723 0% 50%) 0 0 / 16px 16px; }
.identity-preview img { max-width: 100%; max-height: 220px; object-fit: contain; }
.identity-review { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.identity-review span { flex: 1; color: var(--paper-accent); font-size: var(--paper-fs-sm); }
.identity-review button { min-height: var(--paper-hit-min); padding: 0 14px; border: 1px solid var(--paper-line); background: transparent; font-size: var(--paper-fs-sm); cursor: pointer; }
.identity-review .approve { border-color: #4c6a4b; color: #83a982; }
.identity-review .reject { border-color: #663c34; color: #d48676; }
.entity-empty { padding: 0 24px 24px; color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.entity-empty p { margin: 0; }

.candidate-panel { margin: 0 24px 24px; border: 1px solid #6d5934; }
.candidate-heading { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--paper-line); }
.candidate-heading strong { color: var(--paper-text); font-size: var(--paper-fs-base); }
.candidate-heading span { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.candidate-warning { margin: 12px 16px 0; color: #bd9c5d; font-size: var(--paper-fs-sm); }
.candidate-item { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--paper-line-soft); }
.candidate-item.ignore { opacity: .45; }
.candidate-type { align-self: start; padding: 5px 0; text-align: center; border: 1px solid var(--paper-line); color: var(--paper-muted); font-size: var(--paper-fs-xs); }
.candidate-type[data-type='character'] { border-color: #6d5934; color: var(--paper-accent); }
.candidate-copy { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.candidate-copy input, .candidate-copy textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--paper-line); outline: 0; resize: vertical; background: #131412; color: var(--paper-text); font: var(--paper-fs-sm)/1.6 inherit; }
.candidate-copy input { font-size: var(--paper-fs-base); font-weight: 600; }
.candidate-copy input:focus, .candidate-copy textarea:focus { border-color: var(--paper-accent); }
.candidate-copy small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.candidate-copy .merge-hint { color: #bd9c5d; }
.candidate-actions { display: flex; flex-direction: column; gap: 6px; }
.candidate-actions button { min-width: 88px; min-height: var(--paper-hit-min); border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.candidate-actions button.active { border-color: var(--paper-accent); color: var(--paper-accent); }
.candidate-actions button:disabled { opacity: .35; cursor: not-allowed; }
.candidate-footer { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; }
.candidate-footer .primary { min-height: var(--paper-control-h-primary); padding: 0 20px; border: 0; border-radius: 2px; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-base); font-weight: 800; cursor: pointer; }
.candidate-footer .primary:disabled { opacity: .38; cursor: not-allowed; }
.candidate-footer .ghost { min-height: var(--paper-control-h); padding: 0 16px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.candidate-footer small { color: var(--paper-dim); font-size: var(--paper-fs-sm); }

.library-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; padding: 0 24px 24px; }
.column-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.column-heading i { display: grid; place-items: center; min-width: 20px; height: 20px; border: 1px solid var(--paper-line); border-radius: 50%; font-style: normal; font-size: var(--paper-fs-xs); }
.column-empty { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.entity-card { margin-bottom: 10px; padding: 14px; border: 1px solid var(--paper-line); background: var(--paper-panel); }
.entity-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.entity-card-head strong { color: var(--paper-text); font-size: var(--paper-fs-base); }
.identity-state { padding: 3px 7px; border: 1px solid var(--paper-line); color: var(--paper-dim); font-size: var(--paper-fs-xs); white-space: nowrap; }
.identity-state.approved { border-color: #4c6a4b; color: #83a982; }
.identity-state.candidate { border-color: #6d5934; color: var(--paper-accent); }
.entity-desc { margin: 8px 0 6px; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.6; }
.entity-aliases { display: block; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.entity-meta { display: flex; gap: 12px; margin-top: 8px; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.entity-actions { display: flex; gap: 8px; margin-top: 10px; }
.entity-actions button { min-height: var(--paper-hit-min); padding: 0 14px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.entity-actions button:hover:not(:disabled) { border-color: var(--paper-accent); color: var(--paper-accent); }
.entity-actions button.danger:hover:not(:disabled) { border-color: #663c34; color: #d48676; }

.style-anchor { margin: 0 24px 24px; padding: 16px; border: 1px dashed var(--paper-line); }
.style-anchor p { margin: 8px 0 10px; color: var(--paper-dim); font-size: var(--paper-fs-sm); line-height: 1.6; }
.style-anchor textarea { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid var(--paper-line); outline: 0; resize: vertical; background: #131412; color: var(--paper-text); font: var(--paper-fs-sm)/1.6 inherit; }
.style-anchor textarea:focus { border-color: var(--paper-accent); }
.style-anchor button { margin-top: 10px; min-height: var(--paper-control-h); padding: 0 16px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-text); font-size: var(--paper-fs-sm); cursor: pointer; }
.style-anchor button:hover:not(:disabled) { border-color: var(--paper-accent); color: var(--paper-accent); }
.style-anchor button:disabled { opacity: .38; cursor: not-allowed; }

.edit-layer { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; background: rgb(0 0 0 / 55%); }
.edit-dialog { width: min(480px, calc(100vw - 48px)); display: flex; flex-direction: column; gap: 12px; padding: 24px; border: 1px solid var(--paper-line); background: var(--paper-shell); }
.edit-dialog strong { color: var(--paper-text); font-size: var(--paper-fs-lg); }
.edit-dialog label { display: flex; flex-direction: column; gap: 6px; color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.edit-dialog input, .edit-dialog textarea { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid var(--paper-line); outline: 0; resize: vertical; background: #131412; color: var(--paper-text); font: var(--paper-fs-base)/1.6 inherit; }
.edit-dialog input:focus, .edit-dialog textarea:focus { border-color: var(--paper-accent); }
.edit-actions { display: flex; gap: 10px; }
.edit-actions .primary { min-height: var(--paper-control-h-primary); padding: 0 22px; border: 0; border-radius: 2px; background: var(--paper-accent); color: #211c13; font-size: var(--paper-fs-base); font-weight: 800; cursor: pointer; }
.edit-actions .primary:disabled { opacity: .38; cursor: not-allowed; }
.edit-actions .ghost { min-height: var(--paper-control-h); padding: 0 16px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
</style>
