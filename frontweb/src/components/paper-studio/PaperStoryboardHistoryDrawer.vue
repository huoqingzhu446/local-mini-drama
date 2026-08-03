<template>
  <div v-if="open" class="history-backdrop" @mousedown.self="emit('close')">
    <aside
      ref="dialogRef"
      class="history-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paper-history-title"
      tabindex="-1"
    >
      <header>
        <div>
          <span>STORYBOARD ARCHIVE</span>
          <h2 id="paper-history-title">{{ history?.storyboard?.title || '分镜全部历史' }}</h2>
          <small v-if="history">脚本 {{ history.script_revisions.length }} 版 · 生产 {{ totalRuns }} 版</small>
        </div>
        <div class="header-actions">
          <button type="button" class="open-center" @click="openCenter()">查看完整历史</button>
          <button ref="closeButtonRef" type="button" aria-label="关闭历史版本" @click="emit('close')">×</button>
        </div>
      </header>

      <nav class="history-filters" aria-label="历史素材筛选">
        <button
          v-for="item in filters"
          :key="item.value"
          type="button"
          :class="{ active: filter === item.value }"
          @click="filter = item.value"
        >
          {{ item.label }}
        </button>
      </nav>

      <div v-if="loading && !history" class="history-empty">正在读取全部历史…</div>
      <div v-else-if="listError && !history" class="history-empty error" role="alert">{{ listError }}</div>
      <div v-else-if="history" class="history-body">
        <section class="script-history">
          <div class="section-heading">
            <h3>脚本修订</h3>
            <small>点击查看当时保存的完整内容</small>
          </div>
          <div class="revision-strip">
            <button
              v-for="revision in history.script_revisions"
              :key="revision.id"
              type="button"
              :class="{ current: revision.is_current, selected: Number(revisionDetail?.id) === Number(revision.id) }"
              @click="loadRevision(revision.id)"
            >
              <strong>S{{ revision.revision_number }}</strong>
              <i>{{ revision.is_current ? '当前' : revisionSource(revision.created_from) }}</i>
              <time :datetime="revision.created_at">{{ formatTime(revision.created_at) }}</time>
            </button>
          </div>
          <p v-if="revisionError" class="inline-error" role="alert">{{ revisionError }}</p>
          <div v-if="revisionLoading" class="inline-loading">正在读取脚本正文…</div>
          <article v-else-if="revisionDetail" class="revision-preview">
            <header>
              <div>
                <span>S{{ revisionDetail.revision_number }} · 只读</span>
                <strong>{{ revisionDetail.content.title || '未命名分镜' }}</strong>
              </div>
              <button type="button" @click="openCenter('revision', revisionDetail.id)">在历史中心查看与比较</button>
            </header>
            <dl>
              <div><dt>画面</dt><dd>{{ revisionDetail.content.description || '—' }}</dd></div>
              <div><dt>动作</dt><dd>{{ revisionDetail.content.action || '—' }}</dd></div>
              <div><dt>对白</dt><dd>{{ revisionDetail.content.dialogue || '—' }}</dd></div>
              <div><dt>旁白</dt><dd>{{ revisionDetail.content.narration || '—' }}</dd></div>
            </dl>
            <small>与当前版本有 {{ revisionDetail.diff_from_current.changed_fields.length }} 个字段不同 · 关联生产 {{ revisionDetail.related_runs.length }} 个</small>
          </article>
        </section>

        <section class="run-history-list">
          <div class="section-heading">
            <h3>生产版本</h3>
            <small>按创建时间倒序</small>
          </div>
          <article
            v-for="run in history.runs"
            :key="run.id"
            class="history-run"
            :class="{ expanded: Number(selectedRunId) === Number(run.id) }"
          >
            <button
              type="button"
              class="run-summary"
              :aria-expanded="Number(selectedRunId) === Number(run.id)"
              :aria-controls="`history-run-${run.id}`"
              @click="toggleRun(run)"
            >
              <span>R{{ String(run.run_number).padStart(2, '0') }}</span>
              <strong>{{ runStatus(run.status) }}</strong>
              <small>
                <time :datetime="run.created_at">创建 {{ formatTime(run.created_at) }}</time>
                <em>计划 {{ run.plan_revision_count }} · 图片 {{ run.asset_version_count }}</em>
              </small>
              <i v-if="run.archived">归档</i>
              <b aria-hidden="true">{{ Number(selectedRunId) === Number(run.id) ? '−' : '+' }}</b>
            </button>

            <div v-if="Number(selectedRunId) === Number(run.id)" :id="`history-run-${run.id}`" class="run-detail">
              <p v-if="runLoading">正在加载该生产版本的计划和图片…</p>
              <p v-else-if="runError" class="inline-error" role="alert">{{ runError }}</p>
              <template v-else-if="runDetail">
                <button type="button" class="run-center-link" @click="openCenter('run', run.id)">在历史中心查看 R{{ String(run.run_number).padStart(2, '0') }}</button>
                <details v-for="plan in runDetail.plan_revisions" :key="plan.id" :open="plan.is_current">
                  <summary>
                    <span>计划 P{{ plan.revision_number }}</span>
                    <strong>{{ plan.is_current ? '当前采用' : plan.status }}</strong>
                    <small>{{ formatTime(plan.created_at) }}</small>
                  </summary>
                  <div class="families">
                    <section v-for="family in plan.families" :key="family.id" class="history-family">
                      <h4>{{ family.family_key }} <small>{{ family.status }}</small></h4>
                      <div v-for="slot in family.slots" :key="slot.id" class="history-slot">
                        <div class="slot-heading">
                          <strong>{{ slot.slot_key }}</strong>
                          <small>{{ slot.asset_type }} · {{ slot.versions.length }} 个图片版本</small>
                        </div>
                        <div class="asset-grid">
                          <button
                            v-for="version in visibleVersions(slot, plan)"
                            :key="version.id"
                            type="button"
                            class="asset-card"
                            :class="{ current: Number(slot.current_version_id) === Number(version.id) && plan.is_current }"
                            @click="loadAsset(version.id)"
                          >
                            <img v-if="version.preview_url" :src="version.preview_url" :alt="`${slot.slot_key} 图片版本 V${version.id}`" />
                            <span v-else>无可用预览</span>
                            <strong>V{{ version.id }} · {{ versionStatus(version) }}</strong>
                            <small>{{ formatTime(version.created_at) }}</small>
                            <i v-if="version.reuse_fingerprint">视觉合同已记录</i>
                          </button>
                          <p v-if="!visibleVersions(slot, plan).length">此筛选下没有图片版本</p>
                        </div>
                      </div>
                    </section>
                  </div>
                </details>
              </template>
            </div>
          </article>
          <p v-if="paginationError" class="inline-error pagination-error" role="alert">
            {{ paginationError }}
            <button type="button" @click="loadMore">重试</button>
          </p>
          <button v-if="history.page?.has_more" type="button" class="load-more" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? '正在加载…' : '加载更早生产版本' }}
          </button>
        </section>
      </div>

      <section v-if="assetDetail || assetLoading || assetError" class="asset-inspector" aria-label="图片历史详情">
        <button type="button" aria-label="关闭图片详情" @click="closeAsset">×</button>
        <p v-if="assetLoading">正在读取图片详情…</p>
        <p v-else-if="assetError" class="inline-error" role="alert">{{ assetError }}</p>
        <template v-else-if="assetDetail">
          <h3>图片 V{{ assetDetail.asset.id }}</h3>
          <dl>
            <div><dt>状态</dt><dd>{{ versionStatus(assetDetail.asset) }}</dd></div>
            <div><dt>创建时间</dt><dd>{{ formatTime(assetDetail.asset.created_at) }}</dd></div>
            <div><dt>来源</dt><dd>{{ assetDetail.asset.derivation_kind }}</dd></div>
            <div><dt>模型</dt><dd>{{ assetDetail.generation?.provider || '本地/复用' }} {{ assetDetail.generation?.model || '' }}</dd></div>
            <div><dt>图片调用</dt><dd>{{ assetDetail.generation?.provider_call_count || 0 }} 次</dd></div>
            <div><dt>文件</dt><dd :class="{ bad: !assetDetail.asset.file_integrity?.pass }">{{ assetDetail.asset.file_integrity?.pass ? '完整且哈希一致' : '缺失或哈希异常' }}</dd></div>
            <div><dt>审核</dt><dd>{{ assetDetail.reviews[0]?.decision || '无记录' }}</dd></div>
            <div><dt>复用去向</dt><dd>{{ assetDetail.reuse_destinations.length }} 个</dd></div>
          </dl>
        </template>
      </section>
    </aside>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { paperStudioAPI } from '@/api/paperStudio'
import {
  assetVersionStatusLabel,
  revisionSourceLabel,
  runStatusLabel,
} from '@/utils/paperStudioLabels'

const props = defineProps({
  open: { type: Boolean, default: false },
  storyboardId: { type: [Number, String], default: null },
})
const emit = defineEmits(['close', 'open-center'])

const filters = [
  { value: 'all', label: '全部' },
  { value: 'current', label: '当前采用' },
  { value: 'reusable', label: '可复用' },
  { value: 'retired', label: '已淘汰' },
  { value: 'failed', label: '失败' },
]
const filter = ref('all')
const history = ref(null)
const revisionDetail = ref(null)
const selectedRunId = ref(null)
const runDetail = ref(null)
const assetDetail = ref(null)
const loading = ref(false)
const loadingMore = ref(false)
const revisionLoading = ref(false)
const runLoading = ref(false)
const assetLoading = ref(false)
const listError = ref('')
const paginationError = ref('')
const revisionError = ref('')
const runError = ref('')
const assetError = ref('')
const dialogRef = ref(null)
const closeButtonRef = ref(null)
const totalRuns = computed(() => Number(history.value?.total_run_count || 0))
let listRequest = 0
let runRequest = 0
let revisionRequest = 0
let assetRequest = 0
let previousFocus = null

watch(() => [props.open, props.storyboardId], async ([open, id]) => {
  if (!open || !id) return
  const request = ++listRequest
  history.value = null
  revisionDetail.value = null
  selectedRunId.value = null
  runDetail.value = null
  assetDetail.value = null
  listError.value = ''
  paginationError.value = ''
  revisionError.value = ''
  runError.value = ''
  assetError.value = ''
  loading.value = true
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistory(id, { limit: 20 })
    if (request === listRequest) history.value = response.history
  } catch (cause) {
    if (request === listRequest) listError.value = cause?.message || '历史版本读取失败'
  } finally {
    if (request === listRequest) loading.value = false
  }
}, { immediate: true })

watch(() => props.open, async (open) => {
  if (open) {
    previousFocus = document.activeElement
    await nextTick()
    dialogRef.value?.focus()
  } else {
    previousFocus?.focus?.()
    previousFocus = null
  }
})

function formatTime(value) {
  if (!value) return '—（未记录）'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—（时间无效）'
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

function runStatus(status) {
  return runStatusLabel(status)
}

function revisionSource(source) {
  return revisionSourceLabel(source)
}

function versionStatus(version) {
  return assetVersionStatusLabel(version?.status)
}

function visibleVersions(slot, plan) {
  return (slot.versions || []).filter((version) => {
    if (filter.value === 'current') return plan.is_current && Number(slot.current_version_id) === Number(version.id)
    if (filter.value === 'reusable') return version.status === 'accepted' && Boolean(version.reuse_fingerprint)
    if (filter.value === 'retired') return ['rejected', 'superseded'].includes(version.status)
      || (!plan.is_current && version.status === 'accepted')
    if (filter.value === 'failed') return ['failed', 'cancelled'].includes(version.status)
    return true
  })
}

async function loadRevision(revisionId) {
  const request = ++revisionRequest
  revisionLoading.value = true
  revisionError.value = ''
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistoryRevision(props.storyboardId, revisionId)
    if (request === revisionRequest) revisionDetail.value = response.revision
  } catch (cause) {
    if (request === revisionRequest) revisionError.value = cause?.message || '脚本修订读取失败'
  } finally {
    if (request === revisionRequest) revisionLoading.value = false
  }
}

async function toggleRun(run) {
  if (Number(selectedRunId.value) === Number(run.id)) {
    selectedRunId.value = null
    runDetail.value = null
    runError.value = ''
    return
  }
  const request = ++runRequest
  selectedRunId.value = Number(run.id)
  runDetail.value = null
  runError.value = ''
  runLoading.value = true
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistoryRun(props.storyboardId, run.id)
    if (request === runRequest && Number(selectedRunId.value) === Number(run.id)) runDetail.value = response.history_run
  } catch (cause) {
    if (request === runRequest) runError.value = cause?.message || '生产版本详情读取失败'
  } finally {
    if (request === runRequest) runLoading.value = false
  }
}

async function loadAsset(assetVersionId) {
  const request = ++assetRequest
  assetDetail.value = null
  assetError.value = ''
  assetLoading.value = true
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistoryAsset(props.storyboardId, assetVersionId)
    if (request === assetRequest) assetDetail.value = response.asset_history
  } catch (cause) {
    if (request === assetRequest) assetError.value = cause?.message || '图片版本详情读取失败'
  } finally {
    if (request === assetRequest) assetLoading.value = false
  }
}

function closeAsset() {
  assetRequest += 1
  assetDetail.value = null
  assetError.value = ''
  assetLoading.value = false
}

async function loadMore() {
  if (!history.value?.page?.next_cursor || loadingMore.value) return
  const request = ++listRequest
  paginationError.value = ''
  loadingMore.value = true
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistory(props.storyboardId, {
      limit: history.value.page.limit,
      cursor: history.value.page.next_cursor,
    })
    if (request !== listRequest) return
    history.value = {
      ...history.value,
      runs: [...history.value.runs, ...response.history.runs],
      page: response.history.page,
      total_run_count: response.history.total_run_count,
    }
  } catch (cause) {
    if (request === listRequest) paginationError.value = cause?.message || '更早生产版本加载失败'
  } finally {
    if (request === listRequest) loadingMore.value = false
  }
}

function openCenter(kind = null, id = null) {
  emit('open-center', { storyboardId: Number(props.storyboardId), kind, id: id == null ? null : Number(id) })
}

function focusableElements() {
  if (!dialogRef.value) return []
  return [...dialogRef.value.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null)
}

function handleKeydown(event) {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (assetDetail.value || assetError.value || assetLoading.value) return closeAsset()
    if (revisionDetail.value) {
      revisionDetail.value = null
      return
    }
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  if (!focusable.length) {
    event.preventDefault()
    dialogRef.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))
</script>

<style scoped>
.history-backdrop { position: fixed; inset: 0; z-index: 80; display: flex; justify-content: flex-end; background: rgb(8 9 8 / 72%); backdrop-filter: blur(3px); }
.history-drawer { position: relative; width: min(820px, 94vw); height: 100vh; overflow-y: auto; outline: none; border-left: 1px solid var(--paper-line); background: #191a18; color: var(--paper-text); box-shadow: -24px 0 70px rgb(0 0 0 / 45%); }
.history-drawer > header { position: sticky; top: 0; z-index: 3; display: flex; justify-content: space-between; gap: 20px; padding: 22px 26px 18px; border-bottom: 1px solid var(--paper-line); background: rgb(25 26 24 / 96%); backdrop-filter: blur(10px); }
.history-drawer header span { color: var(--paper-accent); font: 700 var(--paper-fs-xs)/1.4 ui-monospace, monospace; letter-spacing: .14em; }
.history-drawer h2 { margin: 5px 0 2px; font: 600 22px/1.3 Georgia, 'Songti SC', serif; }
.history-drawer header small { color: var(--paper-dim); }
.header-actions { display: flex; align-items: flex-start; gap: 8px; }
.header-actions button, .asset-inspector > button { min-height: 34px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); cursor: pointer; }
.header-actions .open-center { padding: 0 12px; color: var(--paper-accent); font-size: 12px; }
.header-actions button:last-child, .asset-inspector > button { width: 34px; font-size: 22px; }
.history-filters { position: sticky; top: 91px; z-index: 2; display: flex; gap: 6px; padding: 10px 26px; border-bottom: 1px solid var(--paper-line-soft); background: #191a18; }
.history-filters button { padding: 7px 12px; border: 1px solid transparent; border-radius: 16px; background: transparent; color: var(--paper-dim); cursor: pointer; }
.history-filters button.active { border-color: #665737; background: #28251d; color: var(--paper-accent); }
.history-body { padding: 20px 26px 50px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.section-heading h3 { margin: 0; color: var(--paper-muted); font-size: 13px; letter-spacing: .08em; }
.section-heading small { color: var(--paper-dim); font-size: 11px; }
.script-history { margin-bottom: 26px; }
.revision-strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 5px; }
.revision-strip button { flex: 0 0 152px; display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 3px 8px; padding: 9px 10px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.revision-strip button.current, .revision-strip button.selected { border-color: #745f35; background: #242118; }
.revision-strip strong { color: var(--paper-accent); font: 700 12px ui-monospace, monospace; }
.revision-strip i { overflow: hidden; color: var(--paper-dim); font-size: var(--paper-fs-xs); font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
.revision-strip time { grid-column: 1 / -1; color: #89857b; font-size: var(--paper-fs-xs); }
.revision-preview { margin-top: 12px; padding: 14px; border-left: 2px solid var(--paper-accent); background: #20211d; }
.revision-preview > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.revision-preview > header div { display: flex; flex-direction: column; gap: 4px; }
.revision-preview > header strong { color: var(--paper-text); }
.revision-preview > header button, .run-center-link { border: 0; background: transparent; color: var(--paper-accent); font-size: 11px; cursor: pointer; }
.revision-preview dl { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 18px; margin: 14px 0 10px; }
.revision-preview dt { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.revision-preview dd { margin: 3px 0 0; color: var(--paper-muted); font-size: 12px; line-height: 1.5; }
.revision-preview > small { color: var(--paper-dim); }
.history-run { margin-bottom: 8px; border: 1px solid var(--paper-line); background: #1e1f1d; }
.run-summary { width: 100%; min-height: 68px; display: grid; grid-template-columns: 58px minmax(105px, .7fr) minmax(230px, 1.5fr) auto 20px; align-items: center; gap: 12px; padding: 10px 14px; border: 0; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.run-summary > span { color: var(--paper-accent); font: 700 13px ui-monospace, monospace; }
.run-summary small { display: flex; flex-direction: column; gap: 3px; color: var(--paper-dim); font-style: normal; }
.run-summary small em { font-style: normal; }
.run-summary i { color: #a87969; font-size: 11px; font-style: normal; }
.run-summary b { font-size: 20px; font-weight: 300; }
.run-detail { padding: 0 14px 15px; border-top: 1px solid var(--paper-line-soft); }
.run-detail > p { color: var(--paper-dim); }
.run-center-link { display: block; margin: 10px 0 0 auto; }
.run-detail details { margin-top: 12px; border-left: 2px solid #55482f; background: #181917; }
.run-detail summary { display: grid; grid-template-columns: 90px 1fr auto; gap: 12px; padding: 12px; color: var(--paper-muted); cursor: pointer; }
.run-detail summary strong { color: var(--paper-accent); font-size: 12px; }
.run-detail summary small { color: var(--paper-dim); }
.families { padding: 0 12px 12px; }
.history-family { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--paper-line-soft); }
.history-family h4 { margin: 0 0 10px; font-size: 13px; }
.history-family h4 small { margin-left: 8px; color: var(--paper-dim); font-weight: 400; }
.history-slot { margin: 8px 0 14px; }
.slot-heading { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 8px; color: var(--paper-muted); font-size: 12px; }
.slot-heading small { color: var(--paper-dim); }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 8px; }
.asset-card { min-width: 0; padding: 6px; border: 1px solid var(--paper-line); background: #20211e; color: var(--paper-muted); text-align: left; cursor: pointer; }
.asset-card.current { border-color: var(--paper-accent); }
.asset-card img, .asset-card > span { width: 100%; height: 82px; display: grid; place-items: center; object-fit: cover; background: #121311; color: var(--paper-dim); font-size: 11px; }
.asset-card strong, .asset-card small, .asset-card i { display: block; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-card strong { color: var(--paper-text); font-size: 11px; }
.asset-card small, .asset-card i { color: var(--paper-dim); font-size: var(--paper-fs-xs); font-style: normal; }
.load-more { width: 100%; padding: 10px; border: 1px dashed var(--paper-line); background: transparent; color: var(--paper-muted); cursor: pointer; }
.history-empty { display: grid; min-height: 260px; place-items: center; color: var(--paper-dim); }
.history-empty.error, .inline-error { color: #d17a69; }
.inline-error { margin: 10px 0; font-size: 12px; }
.inline-loading { margin-top: 10px; color: var(--paper-dim); font-size: 12px; }
.pagination-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pagination-error button { border: 0; background: transparent; color: var(--paper-accent); cursor: pointer; }
.asset-inspector { position: sticky; bottom: 0; z-index: 4; min-height: 98px; padding: 16px 58px 16px 22px; border-top: 1px solid #665737; background: #24231e; box-shadow: 0 -18px 40px rgb(0 0 0 / 34%); }
.asset-inspector > button { position: absolute; top: 12px; right: 14px; }
.asset-inspector h3 { margin: 0 0 10px; }
.asset-inspector dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 18px; margin: 0; }
.asset-inspector dl div { min-width: 0; }
.asset-inspector dt { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.asset-inspector dd { margin: 3px 0 0; overflow: hidden; color: var(--paper-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.asset-inspector dd.bad { color: #d17a69; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--paper-accent); outline-offset: 2px; }
@media (max-width: 720px) {
  .run-summary { grid-template-columns: 50px 1fr 20px; }
  .run-summary small, .run-summary i { display: none; }
  .revision-preview dl, .asset-inspector dl { grid-template-columns: 1fr; }
  .header-actions .open-center { display: none; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
</style>
