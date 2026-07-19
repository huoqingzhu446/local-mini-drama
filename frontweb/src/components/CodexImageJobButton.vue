<template>
  <div class="codex-image-job">
    <div class="codex-image-job__row">
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
      <el-button
        v-if="canCancel"
        size="small"
        link
        type="info"
        :disabled="loading"
        @click="cancelJob"
      >
        取消
      </el-button>
      <StyleStatusBadge
        v-if="job?.style_version_id || job?.stale_reason"
        :state="job?.stale_reason ? 'stale_style' : 'current'"
        :version="job?.style_version_id"
      />
    </div>

    <CodexImageCandidatePicker
      v-if="canShowCandidates"
      :job="job"
      :using-candidate-id="usingCandidateId"
      :disabled="loading"
      @use="useCandidate"
      @preview="$emit('preview', $event)"
    />

    <div v-if="job?.status === 'failed'" class="codex-image-job__error" :title="job.error_msg || ''">
      {{ job.error_msg || '生成失败' }}
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { MagicStick } from '@element-plus/icons-vue'
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
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['created', 'used', 'changed', 'preview'])

const job = ref(null)
const loading = ref(false)
const usingCandidateId = ref('')
let refreshTimer = null

const canCancel = computed(() => ['pending', 'generating'].includes(job.value?.status))
const canShowCandidates = computed(() => (
  ['completed', 'cancelled'].includes(job.value?.status)
  && Array.isArray(job.value?.candidates)
  && job.value.candidates.length > 0
))

const buttonText = computed(() => {
  const status = job.value?.status
  if (status === 'pending') return '队列中'
  if (status === 'generating') return '生成中'
  if (status === 'completed') return '待使用'
  if (status === 'used') return '再生成'
  if (status === 'failed' || status === 'cancelled') return '重试'
  return props.label || 'Codex'
})

const tooltipText = computed(() => {
  const status = job.value?.status
  if (status === 'pending') return '已加入 Codex 生图队列'
  if (status === 'generating') return 'Codex 正在处理该图片任务'
  if (status === 'completed') return '候选图已生成，请选择使用'
  if (status === 'cancelled' && canShowCandidates.value) return '候选图属于旧视觉版本；可确认后继续使用，或点击“重试”生成当前风格'
  if (status === 'used') return '已使用候选图，可重新加入队列'
  if (status === 'failed') return job.value?.error_msg || '任务失败，可重试'
  return props.idleTooltip || '加入 Codex 生图队列'
})

function latestJobFromList(res) {
  const items = Array.isArray(res?.items) ? res.items : []
  return items[0] || null
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
      page_size: 1
    })
    job.value = latestJobFromList(res)
    emit('changed', job.value)
    syncRefreshTimer()
  } catch (_) {}
}

function syncRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (['pending', 'generating'].includes(job.value?.status)) {
    refreshTimer = setInterval(loadLatestJob, 8000)
  }
}

async function createJob(force = false) {
  loading.value = true
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
      force
    })
    job.value = res?.job || null
    emit('created', job.value)
    emit('changed', job.value)
    syncRefreshTimer()
    ElMessage.success(res?.reused ? '已在 Codex 队列中' : '已加入 Codex 生图队列')
  } catch (e) {
    ElMessage.error(e.message || '加入 Codex 队列失败')
  } finally {
    loading.value = false
  }
}

async function onPrimaryClick() {
  const status = job.value?.status
  if (!status) return createJob(false)
  if (status === 'pending' || status === 'generating' || status === 'completed') {
    await loadLatestJob()
    return
  }
  return createJob(true)
}

async function cancelJob() {
  if (!job.value?.id) return
  loading.value = true
  try {
    const res = await codexImageJobAPI.cancel(job.value.id)
    job.value = res?.job || null
    emit('changed', job.value)
    syncRefreshTimer()
    ElMessage.success('已取消 Codex 生图任务')
  } catch (e) {
    ElMessage.error(e.message || '取消失败')
  } finally {
    loading.value = false
  }
}

async function applyCandidate(candidate, allowStale = false) {
  const payload = { candidate_id: candidate.id }
  if (allowStale) payload.allow_stale = true
  const res = await codexImageJobAPI.use(job.value.id, payload)
  job.value = res?.job || null
  emit('used', { job: job.value, candidate, image_url: res?.image_url, local_path: res?.local_path })
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

async function useCandidate(candidate) {
  if (!job.value?.id || !candidate?.id) return
  usingCandidateId.value = candidate.id
  loading.value = true
  try {
    await applyCandidate(candidate)
    ElMessage.success('已使用 Codex 候选图')
  } catch (e) {
    if (e.apiCode !== 'STALE_STYLE_CANDIDATE') {
      ElMessage.error(e.message || '使用失败')
      return
    }
    const confirmed = await confirmUseStaleCandidate()
    if (!confirmed) return
    try {
      await applyCandidate(candidate, true)
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

.codex-image-job__button {
  flex: 1;
  min-width: 0;
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
