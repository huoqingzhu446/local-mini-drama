<template>
  <div class="paper-review" :class="{ 'paper-review--compact': compact }">
    <input ref="fileInput" type="file" accept="image/png,.png" class="paper-review__file" @change="uploadTransparentPng" />

    <div class="paper-review__summary">
      <el-tag size="small" :type="reviewState.tone">{{ reviewState.label }}</el-tag>
      <span>{{ reviewState.message }}</span>
    </div>

    <div class="paper-review__actions">
      <el-button
        size="small"
        type="warning"
        plain
        :loading="operation === 'white_v1'"
        :disabled="busy || !canRunMatte"
        @click="runMatte('white_v1')"
      >白底抠图</el-button>
      <el-button
        size="small"
        type="success"
        plain
        :loading="operation === 'green_screen_v1'"
        :disabled="busy || !canRunMatte"
        @click="runMatte('green_screen_v1')"
      >绿幕抠图</el-button>
      <el-button
        size="small"
        plain
        :loading="operation === 'upload'"
        :disabled="busy"
        @click="chooseTransparentPng"
      >上传透明 PNG</el-button>
      <el-button
        v-if="asset?.status !== 'ready'"
        size="small"
        type="primary"
        :loading="operation === 'approve'"
        :disabled="busy || !canApprove"
        @click="approveManually"
      >确认审核通过</el-button>
    </div>

    <div v-if="showDiagnostics" class="paper-review__diagnostics">
      <span>Alpha：{{ alphaLabel }}</span>
      <span v-if="diagnostics.method">方法：{{ diagnostics.method === 'white_v1' ? '白底' : diagnostics.method === 'green_screen_v1' ? '绿幕' : diagnostics.method }}</span>
      <span v-if="diagnostics.transparent_ratio != null">透明占比：{{ percent(diagnostics.transparent_ratio) }}</span>
      <span v-if="diagnostics.visible_ratio != null">主体占比：{{ percent(diagnostics.visible_ratio) }}</span>
      <span>质量：{{ asset?.matte_quality || 'unknown' }}</span>
    </div>

    <div v-if="paperAssetNeedsAlpha(asset)" class="paper-review__note">
      自动检测通过后会直接标记为可用；仍请点击上方缩略图检查边缘。上传透明 PNG 后必须人工确认，系统不会仅凭文件扩展名放行。
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { paperAssetsAPI } from '@/api/paperAssets'
import {
  canManuallyApprovePaperAsset,
  paperAssetHasReviewableAlpha,
  paperAssetHasSource,
  paperAssetNeedsAlpha,
  paperAssetReviewState,
  parsePaperAssetJson,
} from '@/utils/paperAssetReview'

const props = defineProps({
  asset: { type: Object, default: null },
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['changed'])
const fileInput = ref(null)
const operation = ref('')
const busy = computed(() => !!operation.value)
const diagnostics = computed(() => parsePaperAssetJson(props.asset?.processing_json, {}))
const reviewState = computed(() => paperAssetReviewState(props.asset))
const canRunMatte = computed(() => paperAssetNeedsAlpha(props.asset) && paperAssetHasSource(props.asset))
const canApprove = computed(() => canManuallyApprovePaperAsset(props.asset))
const alphaLabel = computed(() => paperAssetHasReviewableAlpha(props.asset) ? '可用' : '缺失')
const showDiagnostics = computed(() => !!props.asset && (
  diagnostics.value.method
  || diagnostics.value.transparent_ratio != null
  || diagnostics.value.has_alpha != null
  || props.asset.matte_quality
))

function percent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : '—'
}

async function notifyChanged(result) {
  emit('changed', { asset_id: props.asset?.id, result })
}

async function runMatte(method) {
  if (!props.asset?.id || !canRunMatte.value || busy.value) return
  operation.value = method
  try {
    const result = await paperAssetsAPI.matte(props.asset.id, { method })
    await notifyChanged(result)
    if (result?.ok) ElMessage.success('抠图诊断通过，纸片素材已标记为可用')
    else ElMessage.warning('已生成透明候选，但自动诊断未通过；请检查后人工确认或重新处理')
  } catch (error) {
    ElMessage.error(error.message || '纸片素材抠图失败')
  } finally {
    operation.value = ''
  }
}

function chooseTransparentPng() {
  if (busy.value) return
  fileInput.value?.click()
}

async function uploadTransparentPng(event) {
  const file = event?.target?.files?.[0]
  if (event?.target) event.target.value = ''
  if (!file || !props.asset?.id || busy.value) return
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name || '')
  if (!isPng) {
    ElMessage.error('请选择 PNG 文件；纸片透明素材不接受 JPG/WebP')
    return
  }
  operation.value = 'upload'
  try {
    const result = await paperAssetsAPI.uploadSource(props.asset.id, file)
    await notifyChanged(result)
    const processing = parsePaperAssetJson(result?.processing_json, {})
    if (processing.has_alpha === true) ElMessage.success('透明 PNG 已上传，请点击缩略图检查后确认审核通过')
    else ElMessage.warning('PNG 已上传，但文件没有透明通道；请继续执行白底或绿幕抠图')
  } catch (error) {
    ElMessage.error(error.message || '透明 PNG 上传失败')
  } finally {
    operation.value = ''
  }
}

async function approveManually() {
  if (!props.asset?.id || !canApprove.value || busy.value) return
  try {
    await ElMessageBox.confirm(
      '请确认已放大检查透明边缘：没有白边、残留背景、主体缺损或错误阴影。通过后该素材可用于正式渲染。',
      '确认纸片素材审核',
      { type: 'warning', confirmButtonText: '确认通过', cancelButtonText: '继续检查' },
    )
  } catch (_) {
    return
  }
  operation.value = 'approve'
  try {
    const processing = parsePaperAssetJson(props.asset.processing_json, {})
    const result = await paperAssetsAPI.update(props.asset.id, {
      expected_version: props.asset.version,
      status: 'ready',
      matte_quality: 'manual_pass',
      processing_json: {
        ...processing,
        review: { status: 'manual_pass', operator: 'user', at: new Date().toISOString() },
      },
    })
    await notifyChanged(result)
    ElMessage.success('纸片素材已人工审核通过')
  } catch (error) {
    ElMessage.error(error.message || '纸片素材审核失败')
  } finally {
    operation.value = ''
  }
}
</script>

<style scoped>
.paper-review { display:grid; gap:8px; padding:10px; border:1px solid #ead8c3; border-radius:8px; background:#fffdf9; }
.paper-review__file { display:none; }
.paper-review__summary { display:flex; align-items:flex-start; gap:8px; color:#72583f; font-size:11px; line-height:1.45; }
.paper-review__summary span { flex:1; }
.paper-review__actions { display:flex; flex-wrap:wrap; gap:6px; }
.paper-review__actions :deep(.el-button + .el-button) { margin-left:0; }
.paper-review__diagnostics { display:flex; flex-wrap:wrap; gap:5px 12px; color:#64748b; font-size:10px; }
.paper-review__note { color:#9a7650; font-size:10px; line-height:1.45; }
.paper-review--compact { margin-top:7px; padding:8px; grid-column:1 / -1; }
.paper-review--compact .paper-review__summary { font-size:10px; }
.paper-review--compact .paper-review__note { display:none; }
</style>
