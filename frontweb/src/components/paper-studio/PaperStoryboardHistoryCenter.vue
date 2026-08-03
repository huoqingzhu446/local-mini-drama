<template>
  <div v-if="open" class="history-center-backdrop">
    <section
      ref="dialogRef"
      class="history-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-center-title"
      tabindex="-1"
    >
      <header class="center-header">
        <button ref="closeButtonRef" type="button" class="back-button" @click="emit('close')">← 返回工作台</button>
        <div>
          <span>STORYBOARD HISTORY CENTER</span>
          <h2 id="history-center-title">{{ history?.storyboard?.title || '分镜历史中心' }}</h2>
        </div>
        <div class="center-summary" v-if="history">
          <strong>S{{ currentRevisionNumber || '—' }}</strong>
          <small>脚本 {{ history.script_revisions.length }} · 生产 {{ history.total_run_count }}</small>
        </div>
        <button type="button" class="close-button" aria-label="关闭分镜历史中心" @click="emit('close')">×</button>
      </header>

      <div v-if="loading" class="center-state">正在建立分镜时间轴…</div>
      <div v-else-if="error" class="center-state error" role="alert">{{ error }}</div>
      <div v-else-if="history" class="center-layout">
        <aside class="history-timeline" aria-label="分镜版本时间轴">
          <header>
            <span>版本时间轴</span>
            <small>点击只读查看</small>
          </header>
          <nav>
            <section>
              <h3>脚本修订</h3>
              <button
                v-for="revision in history.script_revisions"
                :key="`s-${revision.id}`"
                type="button"
                class="timeline-item"
                :class="{ active: selection.kind === 'revision' && Number(selection.id) === Number(revision.id), current: revision.is_current }"
                @click="selectRevision(revision.id)"
              >
                <i aria-hidden="true"></i>
                <span>
                  <strong>S{{ revision.revision_number }} <em v-if="revision.is_current">当前</em></strong>
                  <small>{{ revisionSource(revision.created_from) }} · {{ revision.run_count }} 个生产</small>
                  <time :datetime="revision.created_at">{{ formatTime(revision.created_at) }}</time>
                </span>
              </button>
            </section>
            <section>
              <h3>生产版本</h3>
              <button
                v-for="run in history.runs"
                :key="`r-${run.id}`"
                type="button"
                class="timeline-item run"
                :class="{ active: selection.kind === 'run' && Number(selection.id) === Number(run.id) }"
                @click="selectRun(run.id)"
              >
                <i aria-hidden="true"></i>
                <span>
                  <strong>R{{ String(run.run_number).padStart(2, '0') }} <em>{{ runStatus(run.status) }}</em></strong>
                  <small>P {{ run.plan_revision_count }} · V {{ run.asset_version_count }}</small>
                  <time :datetime="run.created_at">{{ formatTime(run.created_at) }}</time>
                </span>
              </button>
              <button v-if="history.page?.has_more" type="button" class="load-older" :disabled="loadingMore" @click="loadMore">
                {{ loadingMore ? '正在加载…' : '加载更早版本' }}
              </button>
              <p v-if="paginationError" class="timeline-error" role="alert">{{ paginationError }}</p>
            </section>
          </nav>
        </aside>

        <main class="history-detail">
          <div v-if="detailLoading" class="detail-state">正在读取历史详情…</div>
          <div v-else-if="detailError" class="detail-state error" role="alert">{{ detailError }}</div>

          <article v-else-if="selection.kind === 'revision' && revisionDetail" class="revision-detail">
            <header class="detail-heading">
              <div>
                <span>SCRIPT REVISION · READ ONLY</span>
                <h3>S{{ revisionDetail.revision_number }} · {{ revisionDetail.content.title || '未命名分镜' }}</h3>
                <time :datetime="revisionDetail.created_at">保存于 {{ formatTime(revisionDetail.created_at) }}</time>
              </div>
              <strong class="read-only-badge">历史只读</strong>
            </header>
            <section class="diff-line">
              <strong>与当前 S{{ revisionDetail.diff_from_current.current_revision_number || '—' }} 比较</strong>
              <span v-if="revisionDetail.diff_from_current.changed_fields.length">
                {{ revisionDetail.diff_from_current.changed_fields.map(fieldLabel).join('、') }}发生变化
              </span>
              <span v-else>内容完全一致</span>
            </section>
            <dl class="script-fields">
              <div class="wide"><dt>画面描述</dt><dd>{{ revisionDetail.content.description || '—' }}</dd></div>
              <div class="wide"><dt>主体动作</dt><dd>{{ revisionDetail.content.action || '—' }}</dd></div>
              <div><dt>对白</dt><dd>{{ revisionDetail.content.dialogue || '—' }}</dd></div>
              <div><dt>旁白</dt><dd>{{ revisionDetail.content.narration || '—' }}</dd></div>
              <div><dt>镜头类型</dt><dd>{{ revisionDetail.content.shot_type || '—' }}</dd></div>
              <div><dt>镜头运动</dt><dd>{{ revisionDetail.content.camera_motion || '—' }}</dd></div>
              <div><dt>时长</dt><dd>{{ revisionDetail.content.duration || 0 }} 秒</dd></div>
              <div class="wide"><dt>视觉提示词</dt><dd>{{ revisionDetail.content.visual_prompt || '—' }}</dd></div>
              <div class="wide"><dt>负面提示词</dt><dd>{{ revisionDetail.content.negative_prompt || '—' }}</dd></div>
            </dl>
            <section class="related-runs">
              <h4>关联生产版本</h4>
              <button v-for="run in revisionDetail.related_runs" :key="run.id" type="button" @click="selectRun(run.id)">
                R{{ String(run.run_number).padStart(2, '0') }} · {{ runStatus(run.status) }} · {{ formatTime(run.created_at) }}
              </button>
              <p v-if="!revisionDetail.related_runs.length">该脚本修订尚未用于生产。</p>
            </section>
          </article>

          <article v-else-if="selection.kind === 'run' && runDetail" class="run-full-detail">
            <header class="detail-heading">
              <div>
                <span>PRODUCTION RUN · READ ONLY</span>
                <h3>R{{ String(runDetail.run.run_number).padStart(2, '0') }} · {{ runStatus(runDetail.run.status) }}</h3>
                <time :datetime="runDetail.run.created_at">创建于 {{ formatTime(runDetail.run.created_at) }}</time>
              </div>
              <strong class="read-only-badge">历史只读</strong>
            </header>
            <section v-for="plan in runDetail.plan_revisions" :key="plan.id" class="plan-block">
              <header>
                <div>
                  <span>PLAN REVISION</span>
                  <h4>P{{ plan.revision_number }} · {{ plan.is_current ? '当前采用' : plan.status }}</h4>
                </div>
                <time :datetime="plan.created_at">{{ formatTime(plan.created_at) }}</time>
              </header>
              <div v-for="family in plan.families" :key="family.id" class="family-row">
                <div class="family-label">
                  <strong>{{ family.family_key }}</strong>
                  <small>{{ family.pattern }} · {{ family.status }}</small>
                </div>
                <div class="family-assets">
                  <template v-for="slot in family.slots" :key="slot.id">
                    <button
                      v-for="version in slot.versions"
                      :key="version.id"
                      type="button"
                      class="version-tile"
                      :class="{ current: plan.is_current && Number(slot.current_version_id) === Number(version.id) }"
                      @click="selectAsset(version.id)"
                    >
                      <img v-if="version.preview_url" :src="version.preview_url" :alt="`${slot.slot_key} 历史图片 V${version.id}`" />
                      <span v-else class="missing-preview">无预览</span>
                      <strong>V{{ version.id }} · {{ assetStatus(version.status) }}</strong>
                      <small>{{ slot.slot_key }} · {{ formatTime(version.created_at) }}</small>
                    </button>
                  </template>
                </div>
              </div>
            </section>
          </article>

          <article v-else-if="selection.kind === 'asset' && assetDetail" class="asset-full-detail">
            <header class="detail-heading">
              <div>
                <span>IMAGE VERSION · READ ONLY</span>
                <h3>V{{ assetDetail.asset.id }} · {{ assetStatus(assetDetail.asset.status) }}</h3>
                <time :datetime="assetDetail.asset.created_at">创建于 {{ formatTime(assetDetail.asset.created_at) }}</time>
              </div>
              <button type="button" class="text-action" @click="selectRun(assetDetail.asset.run_id)">返回所属生产版本</button>
            </header>
            <div class="asset-focus">
              <img v-if="assetDetail.asset.preview_url" :src="assetDetail.asset.preview_url" :alt="`历史图片 V${assetDetail.asset.id}`" />
              <div v-else class="asset-placeholder">该历史记录没有可用预览文件</div>
              <dl>
                <div><dt>槽位</dt><dd>{{ assetDetail.asset.slot_key }}</dd></div>
                <div><dt>素材类型</dt><dd>{{ assetDetail.asset.asset_type }}</dd></div>
                <div><dt>来源</dt><dd>{{ assetDetail.asset.derivation_kind }}</dd></div>
                <div><dt>文件校验</dt><dd :class="{ bad: !assetDetail.asset.file_integrity?.pass }">{{ assetDetail.asset.file_integrity?.pass ? '完整且 hash 一致' : '缺失或 hash 异常' }}</dd></div>
                <div><dt>图片 API</dt><dd>{{ assetDetail.generation?.provider_call_count || 0 }} 次</dd></div>
                <div><dt>最新审核</dt><dd>{{ assetDetail.reviews[0]?.decision || '无记录' }}</dd></div>
                <div><dt>从哪里复用</dt><dd>{{ assetDetail.reused_from ? `V${assetDetail.reused_from.source_asset_version_id}` : '原始版本' }}</dd></div>
                <div><dt>复用去向</dt><dd>{{ assetDetail.reuse_destinations.length }} 个版本</dd></div>
              </dl>
            </div>
          </article>

          <div v-else class="detail-state">从左侧选择一个脚本或生产版本查看完整历史。</div>
        </main>

        <aside class="history-actions">
          <header>
            <span>影响与操作</span>
            <small>所有历史记录只读</small>
          </header>
          <div class="immutable-note">
            <strong>源版本不会被修改</strong>
            <p>查看、比较和关闭历史中心都不会写数据库，也不会调用图片 API。</p>
          </div>
          <dl class="history-counts">
            <div><dt>脚本修订</dt><dd>{{ history.script_revisions.length }}</dd></div>
            <div><dt>生产版本</dt><dd>{{ history.total_run_count }}</dd></div>
            <div><dt>当前选择</dt><dd>{{ selectionLabel }}</dd></div>
            <div><dt>本次图片调用</dt><dd class="zero">0</dd></div>
          </dl>
          <section class="next-stage-note">
            <span>派生操作</span>
            <template v-if="selection.kind === 'revision' && revisionDetail">
              <p>创建一个以 S{{ revisionDetail.revision_number }} 为基线的可编辑工作副本。S{{ revisionDetail.revision_number }} 和当前版本都会继续保留。</p>
              <button v-if="!forkPreview" type="button" class="primary-action" :disabled="actionBusy" @click="previewDraftFork">
                {{ actionBusy ? '正在计算影响…' : `预览基于 S${revisionDetail.revision_number} 继续编辑` }}
              </button>
              <div v-else class="fork-impact">
                <dl>
                  <div><dt>保留历史</dt><dd>全部 S/R/P/V</dd></div>
                  <div><dt>变化字段</dt><dd>{{ forkPreview.changed_fields.length }}</dd></div>
                  <div><dt>已发布视频</dt><dd :class="{ warning: forkPreview.published_video_will_be_invalidated }">{{ forkPreview.published_video_will_be_invalidated ? '将标记失效' : '无影响' }}</dd></div>
                  <div><dt>图片 API</dt><dd class="zero">0 次</dd></div>
                </dl>
                <p>确认后只切换当前可编辑工作副本，不会修改源历史，也不会创建生图授权。</p>
                <button type="button" class="primary-action" :disabled="actionBusy" @click="applyDraftFork">
                  {{ actionBusy ? '正在创建…' : '确认创建工作副本（0 调用）' }}
                </button>
                <button type="button" class="secondary-action" :disabled="actionBusy" @click="forkPreview = null">重新选择</button>
              </div>
            </template>
            <template v-else-if="selection.kind === 'run' && runDetail">
              <p>复制 R{{ String(runDetail.run.run_number).padStart(2, '0') }} 的当前计划为一个只包含本分镜的新生产版本。源 R 和全部图片保持不变。</p>
              <button v-if="!forkPreview" type="button" class="primary-action" :disabled="actionBusy" @click="previewProductionFork">
                {{ actionBusy ? '正在检查旧图…' : `预览复制 R${String(runDetail.run.run_number).padStart(2, '0')}` }}
              </button>
              <div v-else class="fork-impact">
                <dl>
                  <div><dt>精确可复用</dt><dd class="zero">{{ forkPreview.asset_impact.exact_reuse_count }} 张</dd></div>
                  <div><dt>需要人工确认</dt><dd>{{ forkPreview.asset_impact.review_required_count }} 张</dd></div>
                  <div><dt>阻止复用/缺失</dt><dd :class="{ warning: forkPreview.provider_call_max > 0 }">{{ forkPreview.asset_impact.blocked_count + forkPreview.asset_impact.missing_count }} 张</dd></div>
                  <div><dt>创建副本本身</dt><dd class="zero">图片 API 0 次</dd></div>
                </dl>
                <p>新 R 会停在计划确认，不会自动复用或生成。确认计划后仍需逐步执行“复用 → 重报价 → 授权”。</p>
                <button type="button" class="primary-action" :disabled="actionBusy" @click="applyProductionFork">
                  {{ actionBusy ? '正在复制…' : '确认创建新生产版本（0 调用）' }}
                </button>
                <button type="button" class="secondary-action" :disabled="actionBusy" @click="forkPreview = null">重新选择</button>
              </div>
            </template>
            <p v-else>选择一个脚本修订，预览从该版本继续编辑的影响。</p>
            <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>
          </section>
        </aside>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { paperStudioAPI } from '@/api/paperStudio'
import {
  assetVersionStatusLabel,
  revisionSourceLabel,
  runStatusLabel,
} from '@/utils/paperStudioLabels'

const props = defineProps({
  open: { type: Boolean, default: false },
  storyboardId: { type: [Number, String], default: null },
  initialSelection: { type: Object, default: null },
})
const emit = defineEmits(['close', 'forked'])
const dialogRef = ref(null)
const closeButtonRef = ref(null)
const history = ref(null)
const revisionDetail = ref(null)
const runDetail = ref(null)
const assetDetail = ref(null)
const loading = ref(false)
const loadingMore = ref(false)
const detailLoading = ref(false)
const error = ref('')
const detailError = ref('')
const paginationError = ref('')
const forkPreview = ref(null)
const actionBusy = ref(false)
const actionError = ref('')
const selection = reactive({ kind: null, id: null })
let requestSequence = 0
let previousFocus = null

const currentRevisionNumber = computed(() => history.value?.script_revisions
  ?.find((revision) => revision.is_current)?.revision_number || null)
const selectionLabel = computed(() => {
  if (!selection.kind) return '未选择'
  if (selection.kind === 'revision') return `S${revisionDetail.value?.revision_number || selection.id}`
  if (selection.kind === 'run') return `R${String(runDetail.value?.run?.run_number || selection.id).padStart(2, '0')}`
  if (selection.kind === 'asset') return `V${selection.id}`
  return '历史'
})

watch(() => [props.open, props.storyboardId], async ([open, storyboardId]) => {
  if (!open || !storyboardId) return
  await loadHistory()
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

async function loadHistory() {
  const request = ++requestSequence
  loading.value = true
  error.value = ''
  history.value = null
  revisionDetail.value = null
  runDetail.value = null
  assetDetail.value = null
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistory(props.storyboardId, { limit: 50 })
    if (request !== requestSequence) return
    history.value = response.history
    loading.value = false
    const initial = props.initialSelection
    if (initial?.kind === 'run' && initial.id) await selectRun(initial.id)
    else if (initial?.kind === 'asset' && initial.id) await selectAsset(initial.id)
    else if (initial?.kind === 'revision' && initial.id) await selectRevision(initial.id)
    else if (response.history.script_revisions[0]) await selectRevision(response.history.script_revisions[0].id)
  } catch (cause) {
    if (request === requestSequence) error.value = cause?.message || '分镜历史中心读取失败'
  } finally {
    if (request === requestSequence) loading.value = false
  }
}

async function loadMore() {
  if (!history.value?.page?.next_cursor || loadingMore.value) return
  loadingMore.value = true
  paginationError.value = ''
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistory(props.storyboardId, {
      limit: history.value.page.limit,
      cursor: history.value.page.next_cursor,
    })
    history.value = {
      ...history.value,
      runs: [...history.value.runs, ...response.history.runs],
      page: response.history.page,
      total_run_count: response.history.total_run_count,
    }
  } catch (cause) {
    paginationError.value = cause?.message || '更早历史加载失败'
  } finally {
    loadingMore.value = false
  }
}

async function selectRevision(id) {
  const request = ++requestSequence
  selection.kind = 'revision'
  selection.id = Number(id)
  detailLoading.value = true
  detailError.value = ''
  runDetail.value = null
  assetDetail.value = null
  forkPreview.value = null
  actionError.value = ''
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistoryRevision(props.storyboardId, id)
    if (request === requestSequence) revisionDetail.value = response.revision
  } catch (cause) {
    if (request === requestSequence) detailError.value = cause?.message || '脚本历史读取失败'
  } finally {
    if (request === requestSequence) detailLoading.value = false
  }
}

async function selectRun(id) {
  const request = ++requestSequence
  selection.kind = 'run'
  selection.id = Number(id)
  detailLoading.value = true
  detailError.value = ''
  revisionDetail.value = null
  assetDetail.value = null
  forkPreview.value = null
  actionError.value = ''
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistoryRun(props.storyboardId, id)
    if (request === requestSequence) runDetail.value = response.history_run
  } catch (cause) {
    if (request === requestSequence) detailError.value = cause?.message || '生产历史读取失败'
  } finally {
    if (request === requestSequence) detailLoading.value = false
  }
}

async function selectAsset(id) {
  const request = ++requestSequence
  selection.kind = 'asset'
  selection.id = Number(id)
  detailLoading.value = true
  detailError.value = ''
  revisionDetail.value = null
  runDetail.value = null
  forkPreview.value = null
  actionError.value = ''
  try {
    const response = await paperStudioAPI.getPaperStoryboardHistoryAsset(props.storyboardId, id)
    if (request === requestSequence) assetDetail.value = response.asset_history
  } catch (cause) {
    if (request === requestSequence) detailError.value = cause?.message || '图片历史读取失败'
  } finally {
    if (request === requestSequence) detailLoading.value = false
  }
}

function formatTime(value) {
  if (!value) return '—（未记录）'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—（时间无效）'
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

function runStatus(status) { return runStatusLabel(status) }
function revisionSource(source) { return revisionSourceLabel(source) }
function assetStatus(status) { return assetVersionStatusLabel(status) }
function fieldLabel(field) {
  return {
    title: '标题', description: '画面', action: '动作', dialogue: '对白', narration: '旁白',
    duration: '时长', shot_type: '镜头类型', camera_motion: '镜头运动', visual_prompt: '视觉提示词',
    negative_prompt: '负面提示词', environment_only: '环境镜头设置', reference_image_url: '参考图',
    reference_local_path: '本地参考文件', current_reference_version_id: '参考版本',
  }[field] || field
}

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`
}

async function previewDraftFork() {
  if (!revisionDetail.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    const response = await paperStudioAPI.previewPaperStoryboardHistoryFork(props.storyboardId, {
      source: { kind: 'revision', id: Number(revisionDetail.value.id) },
      target_mode: 'working_copy',
      expected_version: Number(history.value.storyboard.version),
    })
    forkPreview.value = response.preview
  } catch (cause) {
    actionError.value = cause?.message || '历史工作副本影响预览失败'
  } finally {
    actionBusy.value = false
  }
}

async function applyDraftFork() {
  if (!forkPreview.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    const response = await paperStudioAPI.forkPaperStoryboardHistoryDraft(props.storyboardId, {
      request_id: requestId(),
      source_revision_id: Number(forkPreview.value.source_storyboard_revision_id),
      expected_version: Number(forkPreview.value.storyboard_version),
      preview_fingerprint: forkPreview.value.preview_fingerprint,
      confirmation: {
        actor: 'local_owner',
        reason: 'history_working_copy_confirmed',
        published_video_invalidation: Boolean(forkPreview.value.published_video_will_be_invalidated),
      },
    })
    emit('forked', response)
    emit('close')
  } catch (cause) {
    actionError.value = cause?.message || '历史工作副本创建失败'
  } finally {
    actionBusy.value = false
  }
}

async function previewProductionFork() {
  if (!runDetail.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    const response = await paperStudioAPI.previewPaperStoryboardHistoryFork(props.storyboardId, {
      source: {
        kind: 'run',
        id: Number(runDetail.value.run.id),
        plan_revision_id: Number(runDetail.value.shot.current_plan_revision_id),
      },
      target_mode: 'production_copy',
      expected_version: Number(history.value.storyboard.version),
    })
    forkPreview.value = response.preview
  } catch (cause) {
    actionError.value = cause?.message || '生产版本复制影响预览失败'
  } finally {
    actionBusy.value = false
  }
}

async function applyProductionFork() {
  if (!forkPreview.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    const response = await paperStudioAPI.forkPaperStoryboardHistoryRun(props.storyboardId, {
      request_id: requestId(),
      source_run_id: Number(forkPreview.value.source_run_id),
      source_plan_revision_id: Number(forkPreview.value.source_plan_revision_id),
      scope: 'storyboard_only',
      expected_version: Number(forkPreview.value.storyboard_version),
      preview_fingerprint: forkPreview.value.preview_fingerprint,
      confirmation: { actor: 'local_owner', reason: 'history_production_copy_confirmed' },
    })
    emit('forked', response)
    emit('close')
  } catch (cause) {
    actionError.value = cause?.message || '历史生产版本复制失败'
  } finally {
    actionBusy.value = false
  }
}

function focusableElements() {
  if (!dialogRef.value) return []
  return [...dialogRef.value.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.offsetParent !== null)
}

function handleKeydown(event) {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  if (!focusable.length) return
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
.history-center-backdrop { position: fixed; inset: 0; z-index: 90; background: #11120f; }
.history-center { height: 100vh; overflow: hidden; outline: none; background: #171815; color: var(--paper-text); }
.center-header { height: 78px; display: grid; grid-template-columns: auto minmax(260px, 1fr) auto auto; align-items: center; gap: 22px; padding: 0 24px; border-bottom: 1px solid var(--paper-line); background: #1b1c19; }
.center-header button { border: 0; background: transparent; color: var(--paper-muted); cursor: pointer; }
.center-header .back-button { min-height: 34px; padding: 0 10px; border: 1px solid var(--paper-line); }
.center-header > div:nth-of-type(1) { min-width: 0; }
.center-header span, .history-timeline > header span, .history-actions > header span, .detail-heading span, .plan-block > header span, .next-stage-note span { color: var(--paper-accent); font: 700 var(--paper-fs-xs)/1.4 ui-monospace, monospace; letter-spacing: .14em; }
.center-header h2 { margin: 3px 0 0; overflow: hidden; font: 600 22px/1.2 Georgia, 'Songti SC', serif; text-overflow: ellipsis; white-space: nowrap; }
.center-summary { display: flex; align-items: baseline; gap: 10px; }
.center-summary strong { color: var(--paper-accent); font: 700 14px ui-monospace, monospace; }
.center-summary small { color: var(--paper-dim); }
.center-header .close-button { width: 34px; height: 34px; border: 1px solid var(--paper-line); font-size: 22px; }
.center-layout { height: calc(100vh - 78px); display: grid; grid-template-columns: minmax(230px, 280px) minmax(520px, 1fr) minmax(250px, 310px); }
.history-timeline, .history-actions { min-width: 0; overflow-y: auto; background: #191a17; }
.history-timeline { border-right: 1px solid var(--paper-line); }
.history-actions { border-left: 1px solid var(--paper-line); }
.history-timeline > header, .history-actions > header { position: sticky; top: 0; z-index: 2; display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 16px 18px 12px; border-bottom: 1px solid var(--paper-line-soft); background: rgb(25 26 23 / 96%); }
.history-timeline > header small, .history-actions > header small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.history-timeline nav { padding: 12px 10px 32px; }
.history-timeline nav section + section { margin-top: 24px; }
.history-timeline h3 { margin: 0 8px 9px; color: var(--paper-dim); font-size: var(--paper-fs-xs); letter-spacing: .12em; }
.timeline-item { position: relative; width: 100%; display: grid; grid-template-columns: 14px 1fr; gap: 8px; padding: 8px; border: 0; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.timeline-item::before { content: ''; position: absolute; top: 0; bottom: 0; left: 14px; width: 1px; background: #36372f; }
.timeline-item:first-of-type::before { top: 18px; }
.timeline-item:last-of-type::before { bottom: calc(100% - 18px); }
.timeline-item > i { position: relative; z-index: 1; width: 9px; height: 9px; margin-top: 6px; border: 2px solid #67685e; border-radius: 50%; background: #191a17; }
.timeline-item > span { min-width: 0; display: flex; flex-direction: column; gap: 3px; padding: 5px 7px; border-left: 2px solid transparent; }
.timeline-item:hover > span, .timeline-item.active > span { background: #23241f; }
.timeline-item.active > span { border-left-color: var(--paper-accent); }
.timeline-item.current > i, .timeline-item.active > i { border-color: var(--paper-accent); }
.timeline-item strong { color: var(--paper-text); font: 700 12px ui-monospace, monospace; }
.timeline-item em { color: var(--paper-accent); font: 500 var(--paper-fs-xs) sans-serif; font-style: normal; }
.timeline-item small, .timeline-item time { overflow: hidden; color: var(--paper-dim); font-size: var(--paper-fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.load-older { width: calc(100% - 16px); margin: 10px 8px 0; padding: 8px; border: 1px dashed var(--paper-line); background: transparent; color: var(--paper-muted); cursor: pointer; }
.timeline-error { margin: 8px; color: #d17a69; font-size: 11px; }
.history-detail { min-width: 0; overflow-y: auto; padding: 26px clamp(22px, 3vw, 48px) 80px; background: #171815; }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; padding-bottom: 20px; border-bottom: 1px solid var(--paper-line); }
.detail-heading h3 { margin: 6px 0 4px; font: 600 clamp(22px, 2.4vw, 32px)/1.25 Georgia, 'Songti SC', serif; }
.detail-heading time { color: var(--paper-dim); font-size: 11px; }
.read-only-badge { padding: 7px 10px; border: 1px solid #5e5033; color: #c3a966; font-size: var(--paper-fs-xs); }
.diff-line { display: flex; align-items: baseline; gap: 12px; padding: 15px 0; border-bottom: 1px solid var(--paper-line-soft); }
.diff-line strong { color: var(--paper-muted); font-size: 12px; }
.diff-line span { color: var(--paper-dim); font-size: 11px; }
.script-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; margin: 8px 0 28px; }
.script-fields div { padding: 16px 0; border-bottom: 1px solid var(--paper-line-soft); }
.script-fields .wide { grid-column: 1 / -1; }
.script-fields dt, .asset-focus dt { color: var(--paper-dim); font-size: var(--paper-fs-xs); letter-spacing: .08em; }
.script-fields dd { margin: 7px 0 0; color: var(--paper-muted); font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
.related-runs { padding-top: 10px; }
.related-runs h4 { margin: 0 0 10px; font-size: 13px; }
.related-runs button { display: block; padding: 6px 0; border: 0; background: transparent; color: var(--paper-accent); text-align: left; cursor: pointer; }
.related-runs p { color: var(--paper-dim); font-size: 12px; }
.plan-block { margin-top: 24px; border-top: 2px solid #50452e; }
.plan-block > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 15px 0; }
.plan-block h4 { margin: 4px 0 0; font-size: 16px; }
.plan-block time { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.family-row { display: grid; grid-template-columns: minmax(130px, 180px) 1fr; gap: 18px; padding: 15px 0; border-top: 1px solid var(--paper-line-soft); }
.family-label { display: flex; flex-direction: column; gap: 4px; }
.family-label strong { font-size: 12px; }
.family-label small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.family-assets { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 9px; }
.version-tile { min-width: 0; padding: 5px; border: 1px solid var(--paper-line); background: #1d1e1a; color: var(--paper-muted); text-align: left; cursor: pointer; }
.version-tile.current { border-color: var(--paper-accent); }
.version-tile img, .missing-preview { width: 100%; height: 88px; display: grid; place-items: center; object-fit: cover; background: #11120f; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.version-tile strong, .version-tile small { display: block; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.version-tile strong { color: var(--paper-text); font-size: var(--paper-fs-xs); }
.version-tile small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.asset-focus { display: grid; grid-template-columns: minmax(260px, 1.3fr) minmax(220px, .7fr); gap: 30px; padding-top: 24px; }
.asset-focus > img, .asset-placeholder { width: 100%; min-height: 340px; max-height: 64vh; object-fit: contain; background: #10110e; }
.asset-placeholder { display: grid; place-items: center; color: var(--paper-dim); }
.asset-focus dl { margin: 0; }
.asset-focus dl div { padding: 11px 0; border-bottom: 1px solid var(--paper-line-soft); }
.asset-focus dd { margin: 4px 0 0; color: var(--paper-muted); font-size: 12px; overflow-wrap: anywhere; }
.asset-focus dd.bad { color: #d17a69; }
.text-action { border: 0; background: transparent; color: var(--paper-accent); cursor: pointer; }
.history-actions { padding-bottom: 40px; }
.immutable-note, .next-stage-note { margin: 20px 18px 0; padding: 14px 0; border-top: 1px solid var(--paper-line); border-bottom: 1px solid var(--paper-line); }
.immutable-note strong { color: var(--paper-accent); font-size: 12px; }
.immutable-note p, .next-stage-note p { margin: 7px 0 0; color: var(--paper-dim); font-size: 11px; line-height: 1.65; }
.next-stage-note button { width: 100%; min-height: 38px; margin-top: 10px; cursor: pointer; }
.primary-action { border: 0; background: var(--paper-accent); color: #211c13; font-weight: 800; }
.secondary-action { border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); }
.fork-impact { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--paper-line-soft); }
.fork-impact dl { margin: 0; }
.fork-impact dl div { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; }
.fork-impact dt { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.fork-impact dd { margin: 0; color: var(--paper-muted); font-size: 11px; }
.fork-impact dd.zero { color: #7ca67a; }
.fork-impact dd.warning, .action-error { color: #d18a6c; }
.action-error { margin-top: 10px !important; }
.history-counts { margin: 16px 18px 0; }
.history-counts div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--paper-line-soft); }
.history-counts dt { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.history-counts dd { margin: 0; color: var(--paper-text); font: 700 12px ui-monospace, monospace; }
.history-counts dd.zero { color: #7ca67a; }
.center-state, .detail-state { display: grid; min-height: 280px; place-items: center; color: var(--paper-dim); }
.center-state { height: calc(100vh - 78px); }
.center-state.error, .detail-state.error { color: #d17a69; }
button:focus-visible { outline: 2px solid var(--paper-accent); outline-offset: 2px; }
@media (max-width: 1180px) {
  .center-layout { grid-template-columns: 240px minmax(0, 1fr); }
  .history-actions { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--paper-line); border-left: 0; }
  .history-actions > header { grid-column: 1 / -1; }
  .history-counts { display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px; }
}
@media (max-width: 820px) {
  .center-header { grid-template-columns: auto 1fr auto; }
  .center-summary { display: none; }
  .center-layout { display: block; overflow-y: auto; }
  .history-timeline, .history-detail, .history-actions { overflow: visible; border: 0; }
  .history-timeline nav { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .history-timeline nav section + section { margin-top: 0; }
  .history-detail { padding-bottom: 30px; }
  .history-actions { display: block; border-top: 1px solid var(--paper-line); }
  .asset-focus, .family-row { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
</style>
