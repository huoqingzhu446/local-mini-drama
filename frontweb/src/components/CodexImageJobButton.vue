<template>
  <div class="codex-image-job">
    <div class="codex-image-job__row">
      <div class="codex-image-job__button-group">
        <el-tooltip :content="tooltipText" placement="top">
          <el-button
            class="codex-image-job__button"
            size="small"
            type="warning"
            plain
            :loading="loading"
            :disabled="disabled || !entityId"
            @click="onPrimaryClick"
          >
            <el-icon v-if="!loading"><MagicStick /></el-icon>
            {{ buttonText }}
          </el-button>
        </el-tooltip>
        <el-dropdown
          v-if="showCountMenu"
          trigger="click"
          @command="onCountCommand"
        >
          <el-button
            class="codex-image-job__count-button"
            size="small"
            type="warning"
            plain
            :disabled="disabled || !entityId || loading"
            title="选择 Codex 生成数量"
          >
            <el-icon><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="count in countOptions"
                :key="count"
                :command="count"
              >
                生成 {{ count }} 张
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <el-button
        v-if="canCancel"
        size="small"
        link
        type="info"
        :disabled="loading"
        @click="cancelJobs"
      >
        取消
      </el-button>
      <StyleStatusBadge
        v-if="job?.style_version_id || job?.stale_reason"
        :state="job?.stale_reason ? 'stale_style' : 'current'"
        :version="job?.style_version_id"
      />
    </div>

    <div
      v-for="candidateJob in candidateJobs"
      :key="candidateJob.id"
      class="codex-image-job__candidate"
    >
      <div v-if="jobs.length > 1" class="codex-image-job__candidate-label">
        第 {{ candidateJob.batch_index || 1 }}/{{ candidateJob.batch_size || jobs.length }} 张
      </div>
      <CodexImageCandidatePicker
        :job="candidateJob"
        :using-candidate-id="usingCandidateId"
        :disabled="loading"
        @use="(candidate) => useCandidate(candidateJob, candidate)"
        @preview="$emit('preview', $event)"
      />
    </div>

    <div v-if="failedJob" class="codex-image-job__error" :title="failedJob.error_msg || ''">
      {{ failedJob.error_msg || '生成失败' }}
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, MagicStick } from '@element-plus/icons-vue'
import { codexImageJobAPI } from '@/api/codexImageJobs'
import CodexImageCandidatePicker from '@/components/CodexImageCandidatePicker.vue'
import StyleStatusBadge from '@/components/StyleStatusBadge.vue'

const props = defineProps({
  entityType: { type: String, required: true },
  entityId: { type: [String, Number], required: true },
  dramaId: { type: [String, Number], default: null },
  episodeId: { type: [String, Number], default: null },
  frameType: { type: String, default: 'main' },
  style: { type: String, default: '' },
  aspectRatio: { type: String, default: '' },
  quality: { type: String, default: 'standard' },
  styleVersionId: { type: [String, Number], default: null },
  label: { type: String, default: '' },
  idleTooltip: { type: String, default: '' },
  multiple: { type: Boolean, default: false },
  maxCount: { type: Number, default: 1 },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['created', 'used', 'changed', 'preview'])

const jobs = ref([])
const loading = ref(false)
const usingCandidateId = ref('')
let refreshTimer = null

const job = computed(() => jobs.value[0] || null)
const maxCreateCount = computed(() => Math.min(6, Math.max(1, Math.floor(Number(props.maxCount) || 1))))
const countOptions = computed(() => Array.from({ length: Math.max(0, maxCreateCount.value - 1) }, (_, idx) => idx + 2))
const hasBlockingJob = computed(() => jobs.value.some((item) => ['pending', 'generating', 'completed'].includes(item?.status)))
const showCountMenu = computed(() => props.multiple && countOptions.value.length > 0 && !hasBlockingJob.value)
const canCancel = computed(() => jobs.value.some((item) => ['pending', 'generating'].includes(item?.status)))
const candidateJobs = computed(() => jobs.value.filter((item) => (
  ['completed', 'cancelled'].includes(item?.status)
  && Array.isArray(item?.candidates)
  && item.candidates.length > 0
)))
const failedJob = computed(() => jobs.value.find((item) => item?.status === 'failed') || null)

function statusCount(status) {
  return jobs.value.filter((item) => item?.status === status).length
}

const buttonText = computed(() => {
  if (statusCount('generating')) return jobs.value.length > 1 ? `生成中 ${statusCount('generating')}/${jobs.value.length}` : '生成中'
  if (statusCount('pending')) return jobs.value.length > 1 ? `队列中 ${statusCount('pending')}/${jobs.value.length}` : '队列中'
  if (statusCount('completed')) return jobs.value.length > 1 ? `待使用 ${statusCount('completed')}` : '待使用'
  if (jobs.value.length && jobs.value.every((item) => item?.status === 'used')) return '再生成'
  if (jobs.value.some((item) => ['failed', 'cancelled'].includes(item?.status))) return '重试'
  return props.label || 'Codex'
})

const tooltipText = computed(() => {
  if (statusCount('pending')) return jobs.value.length > 1 ? `已加入 Codex 生图队列，共 ${jobs.value.length} 张` : '已加入 Codex 生图队列'
  if (statusCount('generating')) return jobs.value.length > 1 ? `Codex 正在处理 ${jobs.value.length} 张分镜图任务` : 'Codex 正在处理该图片任务'
  if (statusCount('completed')) return jobs.value.length > 1 ? `已有 ${statusCount('completed')} 张候选图，请分别选择使用` : '候选图已生成，请选择使用'
  if (jobs.value.some((item) => item?.status === 'cancelled') && candidateJobs.value.length) return '候选图属于旧视觉版本；可确认后继续使用，或点击“重试”生成当前风格'
  if (jobs.value.length && jobs.value.every((item) => item?.status === 'used')) return '已使用候选图，可重新加入队列'
  if (failedJob.value) return failedJob.value.error_msg || '任务失败，可重试'
  return props.idleTooltip || '加入 Codex 生图队列'
})

function jobsFromLatestBatch(res) {
  const items = Array.isArray(res?.items) ? res.items : []
  const latest = items[0]
  if (!latest) return []
  if (!latest.batch_id) return [latest]
  return items
    .filter((item) => item?.batch_id === latest.batch_id)
    .sort((a, b) => (Number(a.batch_index) || 1) - (Number(b.batch_index) || 1))
}

async function loadLatestJob() {
  if (!props.entityType || !props.entityId) return
  try {
    const res = await codexImageJobAPI.list({
      entity_type: props.entityType,
      entity_id: props.entityId,
      frame_type: props.frameType || 'main',
      quality: props.quality || 'standard',
      style_version_id: props.styleVersionId || undefined,
      page: 1,
      page_size: props.multiple ? 50 : 1
    })
    jobs.value = jobsFromLatestBatch(res)
    emit('changed', job.value)
    syncRefreshTimer()
  } catch (_) {}
}

function syncRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (jobs.value.some((item) => ['pending', 'generating'].includes(item?.status))) {
    refreshTimer = setInterval(loadLatestJob, 8000)
  }
}

function newBatchId() {
  if (globalThis.crypto?.randomUUID) return `cijb_${globalThis.crypto.randomUUID()}`
  return `cijb_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

async function createJobs(count = 1, force = false) {
  const requestedCount = Math.min(maxCreateCount.value, Math.max(1, Math.floor(Number(count) || 1)))
  const batchId = requestedCount > 1 ? newBatchId() : ''
  loading.value = true
  const createdJobs = []
  let reused = 0
  let failed = 0
  try {
    for (let index = 1; index <= requestedCount; index++) {
      try {
        const res = await codexImageJobAPI.create({
          entity_type: props.entityType,
          entity_id: props.entityId,
          drama_id: props.dramaId || undefined,
          episode_id: props.episodeId || undefined,
          frame_type: props.frameType || 'main',
          style: props.style || undefined,
          aspect_ratio: props.aspectRatio || undefined,
          quality: props.quality || 'standard',
          force: force || requestedCount > 1,
          force_generate: force || requestedCount > 1,
          batch_id: batchId || undefined,
          batch_index: batchId ? index : undefined,
          batch_size: batchId ? requestedCount : undefined
        })
        if (res?.job) {
          createdJobs.push(res.job)
          emit('created', res.job)
        }
        if (res?.reused) reused += 1
      } catch (_) {
        failed += 1
      }
    }
    if (!createdJobs.length) throw new Error('加入 Codex 队列失败')
    jobs.value = createdJobs.sort((a, b) => (Number(a.batch_index) || 1) - (Number(b.batch_index) || 1))
    emit('changed', job.value)
    syncRefreshTimer()
    if (failed) ElMessage.warning(`已加入 ${createdJobs.length} 张分镜图任务，${failed} 张失败`)
    else if (requestedCount > 1) ElMessage.success(`已加入 ${requestedCount} 张分镜图到 Codex 队列`)
    else ElMessage.success(reused ? '已在 Codex 队列中' : '已加入 Codex 生图队列')
  } catch (e) {
    ElMessage.error(e.message || '加入 Codex 队列失败')
  } finally {
    loading.value = false
  }
}

async function onPrimaryClick() {
  const status = job.value?.status
  if (!status) return createJobs(1, false)
  if (hasBlockingJob.value) {
    await loadLatestJob()
    return
  }
  return createJobs(1, true)
}

function onCountCommand(count) {
  if (hasBlockingJob.value) return
  return createJobs(Number(count), true)
}

function replaceJob(nextJob) {
  if (!nextJob?.id) return
  const index = jobs.value.findIndex((item) => item?.id === nextJob.id)
  if (index < 0) jobs.value = [nextJob, ...jobs.value]
  else jobs.value = jobs.value.map((item, idx) => idx === index ? nextJob : item)
}

async function cancelJobs() {
  const activeJobs = jobs.value.filter((item) => ['pending', 'generating'].includes(item?.status))
  if (!activeJobs.length) return
  loading.value = true
  let cancelled = 0
  try {
    for (const activeJob of activeJobs) {
      const res = await codexImageJobAPI.cancel(activeJob.id)
      replaceJob(res?.job)
      cancelled += 1
    }
    emit('changed', job.value)
    syncRefreshTimer()
    ElMessage.success(cancelled > 1 ? `已取消 ${cancelled} 个 Codex 生图任务` : '已取消 Codex 生图任务')
  } catch (e) {
    ElMessage.error(e.message || '取消失败')
  } finally {
    loading.value = false
  }
}

async function applyCandidate(targetJob, candidate, allowStale = false) {
  const payload = { candidate_id: candidate.id }
  if (allowStale) payload.allow_stale = true
  const res = await codexImageJobAPI.use(targetJob.id, payload)
  replaceJob(res?.job)
  emit('used', { job: res?.job || targetJob, candidate, image_url: res?.image_url, local_path: res?.local_path })
  emit('changed', job.value)
  syncRefreshTimer()
  return res
}

async function confirmUseStaleCandidate() {
  try {
    await ElMessageBox.confirm(
      '这张候选图属于旧的视觉风格版本。建议取消后点击“重试”重新生成当前风格；如果仍要保留这张图，确认后将按旧风格应用。',
      '候选图风格已过期',
      {
        type: 'warning',
        confirmButtonText: '继续使用旧图',
        cancelButtonText: '取消',
        distinguishCancelAndClose: true
      }
    )
    return true
  } catch (_) {
    return false
  }
}

async function useCandidate(targetJob, candidate) {
  if (!targetJob?.id || !candidate?.id) return
  usingCandidateId.value = candidate.id
  loading.value = true
  try {
    await applyCandidate(targetJob, candidate)
    ElMessage.success('已使用 Codex 候选图')
  } catch (e) {
    if (e.apiCode !== 'STALE_STYLE_CANDIDATE') {
      ElMessage.error(e.message || '使用失败')
      return
    }
    const confirmed = await confirmUseStaleCandidate()
    if (!confirmed) return
    try {
      await applyCandidate(targetJob, candidate, true)
      ElMessage.warning('已使用旧视觉风格候选图，请留意画风一致性')
    } catch (retryError) {
      ElMessage.error(retryError.message || '使用失败')
    }
  } finally {
    usingCandidateId.value = ''
    loading.value = false
  }
}

watch(() => [props.entityType, props.entityId, props.frameType, props.quality], loadLatestJob)

onMounted(loadLatestJob)
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<style scoped>
.codex-image-job {
  flex: 1;
  min-width: 0;
}

.codex-image-job__row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
}

.codex-image-job__button-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.codex-image-job__button {
  flex: 1;
  min-width: 0;
}

.codex-image-job__count-button {
  flex: 0 0 auto;
  min-width: 32px;
  padding-left: 8px;
  padding-right: 8px;
}

.codex-image-job__candidate + .codex-image-job__candidate {
  margin-top: 6px;
}

.codex-image-job__candidate-label {
  padding: 6px 8px 0;
  color: #a1a1aa;
  font-size: 11px;
}

.codex-image-job__error {
  margin: 4px 8px 0;
  color: #f87171;
  font-size: 11px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
