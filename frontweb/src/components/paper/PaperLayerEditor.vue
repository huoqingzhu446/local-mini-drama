<template>
  <div class="paper-editor" v-loading="loading">
    <header class="paper-editor__header">
      <div>
        <div class="paper-editor__eyebrow">PAPER LAYERED · 正式生产模式</div>
        <h1>{{ storyboard?.title || `分镜 ${storyboardId}` }}</h1>
        <p>独立透明素材、rig 动作、遮挡和锁定时序必须全部通过门禁后才能渲染。</p>
      </div>
      <div class="paper-editor__actions">
        <el-button @click="reload">刷新</el-button>
        <el-button type="warning" plain :loading="planning" @click="plan(true)">重建未锁定规划</el-button>
        <el-button type="primary" :loading="rendering" :disabled="!validation?.ok" @click="render(false)">正式渲染</el-button>
      </div>
    </header>

    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="paper-editor__alert" />

    <div v-if="composition" class="paper-editor__meta">
      <el-tag :type="statusTagType(composition.status)">{{ paperStatusLabel(composition.status) }}</el-tag>
      <span>v{{ composition.version }}</span>
      <span>{{ composition.width }} × {{ composition.height }} · {{ composition.fps }} fps · {{ (composition.duration_frames / composition.fps).toFixed(2) }} 秒</span>
      <span>时序：{{ composition.audio_timing_status === 'locked' ? '已锁定' : '未锁定' }}</span>
    </div>

    <div v-if="composition" class="paper-editor__grid">
      <section class="paper-card paper-card--layers">
        <div class="paper-card__title">图层与语义结构</div>
        <div v-if="!layers.length" class="paper-empty">还没有正式纸片层，请先规划。</div>
        <div v-for="layer in layers" :key="layer.id" class="paper-layer-row" :class="{ active: selectedLayerId === layer.id }" @click="selectedLayerId = layer.id">
          <div class="paper-layer-row__main">
            <span class="paper-layer-row__key">{{ layer.layer_key }}</span>
            <span class="paper-layer-row__type">{{ layer.layer_type }} · z{{ layer.z_index }} · d{{ Number(layer.depth).toFixed(2) }}</span>
          </div>
          <div class="paper-layer-row__actions" @click.stop>
            <el-tag size="small" :type="paperAssetStatusIsReady(paperAssetStatus(layer)) ? 'success' : 'warning'">{{ paperAssetStatusLabel(paperAssetStatus(layer)) }}</el-tag>
            <CodexImageJobButton
              v-if="layer.paper_asset_id"
              entity-type="paper_asset"
              :entity-id="layer.paper_asset_id"
              :drama-id="composition?.drama_id || dramaId"
              :episode-id="composition?.episode_id"
              frame-type="main"
              :aspect-ratio="compositionAspectRatio"
              quality="standard"
              label="Codex 素材"
              idle-tooltip="为该纸片资产生成候选图"
              @used="onPaperAssetCandidateUsed($event, layer)"
              @preview="previewPaperAsset"
            />
          </div>
        </div>
      </section>

      <section class="paper-card paper-card--inspector">
        <div class="paper-card__title">图层检查器</div>
        <template v-if="selectedLayer">
          <div class="paper-inspector__hint">{{ selectedLayer.role || selectedLayer.layer_type }} · 版本 {{ selectedLayer.version }}</div>
          <div v-if="selectedLayer.paper_asset_id" class="paper-asset-inspector">
            <div class="paper-asset-inspector__label">纸片资产 #{{ selectedLayer.paper_asset_id }} · {{ paperAssetStatusLabel(selectedPaperAsset?.status || selectedLayer.status) }}</div>
            <img
              v-if="selectedPaperAsset?.image_url || selectedPaperAsset?.cutout_url"
              :src="selectedPaperAsset.cutout_url || selectedPaperAsset.image_url"
              class="paper-asset-inspector__thumb"
              alt=""
              @click="previewPaperAsset(selectedPaperAsset.cutout_url || selectedPaperAsset.image_url)"
            />
            <div class="paper-asset-inspector__note">请使用左侧对应图层的「Codex 素材」按钮生成候选；候选图仅写入 paper_assets，完整分镜图和主图不会被替换。</div>
          </div>
          <div v-if="selectedRigParts.length" class="paper-rig-assets">
            <div class="paper-rig-assets__title">Rig 独立部件</div>
            <div v-for="part in selectedRigParts" :key="part.key" class="paper-rig-assets__row">
              <div>
                <strong>{{ part.key }}</strong>
                <small>#{{ part.asset_id }} · {{ part.asset?.status === 'ready' ? '可用' : '待素材/审核' }}</small>
              </div>
              <CodexImageJobButton
                entity-type="paper_asset"
                :entity-id="part.asset_id"
                :drama-id="composition?.drama_id || dramaId"
                :episode-id="composition?.episode_id"
                frame-type="main"
                :aspect-ratio="compositionAspectRatio"
                quality="standard"
                label="Codex 部件"
                idle-tooltip="为该 rig 部件生成独立候选图"
                @used="onPaperAssetCandidateUsed($event, { paper_asset_id: part.asset_id })"
                @preview="previewPaperAsset"
              />
            </div>
            <div class="paper-asset-inspector__note">每个部件独立入队并只回写对应 paper_assets；候选仍需抠图/审核后才能成为正式 rig 素材。</div>
          </div>
          <div class="paper-form-grid">
            <label>x<input v-model.number="layerForm.x" type="number" step="0.001" min="-1" max="2" /></label>
            <label>y<input v-model.number="layerForm.y" type="number" step="0.001" min="-1" max="2" /></label>
            <label>宽度<input v-model.number="layerForm.width" type="number" step="0.001" min="0.001" max="3" /></label>
            <label>缩放<input v-model.number="layerForm.scale" type="number" step="0.001" min="0.01" max="5" /></label>
            <label>旋转<input v-model.number="layerForm.rotation" type="number" step="0.1" min="-360" max="360" /></label>
            <label>深度<input v-model.number="layerForm.depth" type="number" step="0.01" min="0" max="1" /></label>
          </div>
          <label class="paper-field-label">动作动词</label>
          <el-input v-model="layerForm.action_verb" placeholder="例如：抬手、镜头推进、指向太阳" />
          <label class="paper-field-label">遮挡 JSON</label>
          <el-input v-model="layerForm.occlusionText" type="textarea" :rows="3" />
          <div class="paper-inspector__actions">
            <el-button type="primary" :loading="saving" @click="saveLayer">保存图层</el-button>
          </div>
        </template>
        <div v-else class="paper-empty">选择一个图层查看和编辑。</div>
      </section>

      <section class="paper-card paper-card--timing">
        <div class="paper-card__title">动作节拍与音频锁</div>
        <div class="paper-phase-list">
          <div v-for="phase in phases" :key="phase.name" class="paper-phase">
            <span>{{ phase.name }}</span><span>{{ phase.start_frame }}–{{ phase.end_frame }}</span>
          </div>
        </div>
        <el-input v-model="manualTimingReason" placeholder="人工 beat 原因（无音频时必填）" />
        <el-button class="paper-wide-button" :loading="lockingTiming" @click="lockTiming">锁定人工时序</el-button>
        <div class="paper-editor__note">锁定后修改对白、旁白或镜头时长会自动使时序失效。</div>
      </section>

      <section class="paper-card paper-card--validation">
        <div class="paper-card__title">正式门禁</div>
        <el-button size="small" :loading="validating" @click="validate">重新检查</el-button>
        <div v-if="validation" class="paper-validation-summary" :class="{ pass: validation.ok }">
          {{ validation.ok ? '基础门禁通过，可以生成 proof frames。' : `仍有 ${validation.blocking?.length || 0} 项阻塞问题。` }}
        </div>
        <div v-for="item in (validation?.blocking || [])" :key="`${item.code}:${item.path}`" class="paper-issue paper-issue--blocking">
          <strong>{{ item.code }}</strong><span>{{ item.message }}</span><code>{{ item.path }}</code>
        </div>
        <div v-for="item in (validation?.warnings || [])" :key="`${item.code}:${item.path}`" class="paper-issue paper-issue--warning">
          <strong>{{ item.code }}</strong><span>{{ item.message }}</span>
        </div>
      </section>

      <section class="paper-card paper-card--proofs">
        <div class="paper-card__title">六张 proof frames</div>
        <div class="paper-proof-grid">
          <div v-for="kind in proofKinds" :key="kind" class="paper-proof">
            <div class="paper-proof__label">{{ proofLabel(kind) }}</div>
            <img v-if="proofByKind[kind]" :src="proofSrc(proofByKind[kind])" alt="" />
            <div v-else class="paper-proof__empty">未生成</div>
          </div>
        </div>
        <el-button class="paper-wide-button" :loading="proofing" :disabled="!validation?.ok" @click="requestProof">生成 proof frames</el-button>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { paperCompositionsAPI } from '@/api/paperCompositions'
import { paperAssetsAPI } from '@/api/paperAssets'
import { taskAPI } from '@/api/task'
import CodexImageJobButton from '@/components/CodexImageJobButton.vue'
import { PAPER_PROOF_KINDS, paperStatusLabel, proofLabel, parsePaperJson } from '@/utils/paperComposition'

const props = defineProps({
  storyboardId: { type: [Number, String], required: true },
  dramaId: { type: [Number, String], default: null },
})

const loading = ref(false)
const planning = ref(false)
const saving = ref(false)
const validating = ref(false)
const lockingTiming = ref(false)
const proofing = ref(false)
const rendering = ref(false)
const error = ref('')
const composition = ref(null)
const storyboard = ref(null)
const layers = ref([])
const assets = ref([])
const rigs = ref([])
const validation = ref(null)
const proofs = ref([])
const selectedLayerId = ref(null)
const manualTimingReason = ref('无外部音频，按动作节拍锁定')
const taskTimer = ref(null)
const layerForm = reactive({ x: 0.5, y: 0.5, width: 1, scale: 1, rotation: 0, depth: 0.5, action_verb: '', occlusionText: '{}' })

const proofKinds = PAPER_PROOF_KINDS
const selectedLayer = computed(() => layers.value.find((layer) => layer.id === selectedLayerId.value) || null)
const selectedPaperAsset = computed(() => {
  const id = selectedLayer.value?.paper_asset_id
  return assets.value.find((asset) => Number(asset.id) === Number(id)) || null
})
const selectedRigParts = computed(() => {
  const rigId = selectedLayer.value?.rig_id
  if (!rigId) return []
  const rig = rigs.value.find((item) => Number(item.id) === Number(rigId))
  return (rig?.parts || []).filter((part) => part?.asset_id).map((part) => ({
    ...part,
    asset: assets.value.find((asset) => Number(asset.id) === Number(part.asset_id)) || null,
  }))
})
const compositionAspectRatio = computed(() => {
  const width = Number(composition.value?.width || 0)
  const height = Number(composition.value?.height || 0)
  if (!width || !height) return ''
  return `${width}:${height}`
})
const phases = computed(() => parsePaperJson(composition.value?.audio_json, {}).timing?.phases || [])
const proofByKind = computed(() => Object.fromEntries(proofs.value.map((proof) => [proof.proof_kind, proof])))

function statusTagType(status) { return status === 'rendered' ? 'success' : status === 'failed' ? 'danger' : status === 'ready' ? 'primary' : 'warning' }
function proofSrc(proof) { return proof?.local_path ? `/static/${String(proof.local_path).replace(/^\/+/, '')}` : '' }
function paperAssetStatus(layer) {
  const asset = assets.value.find((item) => Number(item.id) === Number(layer?.paper_asset_id))
  return asset?.status || layer?.status || 'missing'
}
function paperAssetStatusIsReady(status) { return status === 'ready' || status === 'manual_pass' }
function paperAssetStatusLabel(status) {
  return paperAssetStatusIsReady(status) ? '可用' : status === 'needs_review' ? '待审核' : status === 'candidate' ? '候选' : '待素材'
}

function syncLayerForm(layer) {
  if (!layer) return
  const t = parsePaperJson(layer.transform_json, {})
  const a = parsePaperJson(layer.animation_json, {})
  layerForm.x = Number(t.x ?? 0.5); layerForm.y = Number(t.y ?? 0.5); layerForm.width = Number(t.width ?? 1)
  layerForm.scale = Number(t.scale ?? 1); layerForm.rotation = Number(t.rotation ?? 0); layerForm.depth = Number(layer.depth ?? 0.5)
  layerForm.action_verb = a.action_verb || ''
  layerForm.occlusionText = JSON.stringify(parsePaperJson(layer.occlusion_json, {}), null, 2)
}

watch(selectedLayer, syncLayerForm, { immediate: true })

async function load() {
  loading.value = true; error.value = ''
  try {
    let data
    const list = await paperCompositionsAPI.list({ storyboard_id: props.storyboardId })
    if (list?.compositions?.length) data = await paperCompositionsAPI.get(list.compositions[0].id)
    else data = await paperCompositionsAPI.plan(props.storyboardId, {})
    applyData(data)
    await validate()
  } catch (e) { error.value = e.message || '纸片合成加载失败' } finally { loading.value = false }
}

function applyData(data) {
  composition.value = data?.composition || null
  storyboard.value = data?.storyboard || null
  layers.value = data?.layers || []
  assets.value = data?.assets || []
  rigs.value = data?.rigs || []
  proofs.value = data?.proofs || []
  if (!selectedLayerId.value && layers.value[0]) selectedLayerId.value = layers.value[0].id
  if (selectedLayerId.value && !layers.value.some((layer) => layer.id === selectedLayerId.value)) selectedLayerId.value = layers.value[0]?.id || null
}

async function plan(rebuild = false) {
  planning.value = true; error.value = ''
  try { applyData(await paperCompositionsAPI.plan(props.storyboardId, { rebuild_layers: rebuild })); await validate(); ElMessage.success('纸片规划已更新') }
  catch (e) { error.value = e.message || '规划失败' } finally { planning.value = false }
}

async function reload() { await load() }

async function refreshCompositionOnly() {
  if (!composition.value?.id) return
  const data = await paperCompositionsAPI.get(composition.value.id)
  applyData(data)
  await validate()
}

async function onPaperAssetCandidateUsed(_payload, layer) {
  // Codex 的 paper_asset 分支只改 paper_assets。重新读取合成，确保当前图层
  // 能看到新的素材状态/版本，但绝不调用 storyboard 图片或主图接口。
  try {
    if (layer?.paper_asset_id) {
      const asset = await paperAssetsAPI.get(layer.paper_asset_id)
      const index = assets.value.findIndex((item) => Number(item.id) === Number(asset.id))
      if (index >= 0) assets.value.splice(index, 1, asset)
      else assets.value.push(asset)
    }
    await refreshCompositionOnly()
    ElMessage.success('纸片资产已更新，分镜主图未改变')
  } catch (e) {
    error.value = e.message || '纸片资产刷新失败'
  }
}

function previewPaperAsset(url) {
  if (!url) return
  const value = String(url)
  if (!/^(?:https?:\/\/|\/static\/|data:image\/)/i.test(value)) return
  // PaperLayerEditor 没有依赖 FilmCreate 的预览弹窗；在新标签页打开候选，
  // 不触碰 storyboard 主图字段。
  window.open(value, '_blank', 'noopener,noreferrer')
}

async function validate() {
  if (!composition.value) return
  validating.value = true
  try { validation.value = await paperCompositionsAPI.validation(composition.value.id) }
  catch (e) { error.value = e.message || '门禁检查失败' } finally { validating.value = false }
}

async function saveLayer() {
  if (!selectedLayer.value || !composition.value) return
  let occlusion
  try { occlusion = JSON.parse(layerForm.occlusionText || '{}') } catch (_) { ElMessage.error('遮挡 JSON 格式错误'); return }
  saving.value = true
  try {
    const layer = await paperCompositionsAPI.updateLayer(selectedLayer.value.id, {
      expected_version: selectedLayer.value.version,
      depth: layerForm.depth,
      transform_json: { ...parsePaperJson(selectedLayer.value.transform_json, {}), x: layerForm.x, y: layerForm.y, width: layerForm.width, scale: layerForm.scale, rotation: layerForm.rotation },
      animation_json: { ...parsePaperJson(selectedLayer.value.animation_json, {}), action_verb: layerForm.action_verb },
      occlusion_json: occlusion,
    })
    const idx = layers.value.findIndex((item) => item.id === layer.id)
    if (idx >= 0) layers.value[idx] = layer
    composition.value.version += 1
    await validate()
    ElMessage.success('图层已保存')
  } catch (e) { error.value = e.message || '保存失败'; if (e.apiCode === 'PAPER_VERSION_CONFLICT') await load() } finally { saving.value = false }
}

async function lockTiming() {
  if (!composition.value) return
  lockingTiming.value = true
  try {
    const out = await paperCompositionsAPI.lockTiming(composition.value.id, { expected_version: composition.value.version, source: 'manual', reason: manualTimingReason.value, cues: [] })
    applyData(out); await validate(); ElMessage.success('时序已锁定')
  } catch (e) { error.value = e.message || '时序锁定失败' } finally { lockingTiming.value = false }
}

function pollTask(taskId, done) {
  if (taskTimer.value) clearInterval(taskTimer.value)
  taskTimer.value = setInterval(async () => {
    try {
      const task = await taskAPI.get(taskId)
      if (task?.status === 'completed' || task?.status === 'failed') { clearInterval(taskTimer.value); taskTimer.value = null; done(task) }
    } catch (_) {}
  }, 1200)
}

async function requestProof() {
  if (!composition.value) return
  proofing.value = true
  try {
    const out = await paperCompositionsAPI.proofFrames(composition.value.id, { expected_version: composition.value.version })
    pollTask(out.task_id, async (task) => { proofing.value = false; if (task.status === 'failed') error.value = task.error || task.message || 'proof 生成失败'; else { await load(); ElMessage.success('六张 proof frames 已生成') } })
  } catch (e) { proofing.value = false; error.value = e.message || 'proof 生成失败' }
}

async function render(preview = false) {
  if (!composition.value) return
  rendering.value = true
  try {
    const out = await paperCompositionsAPI.render(composition.value.id, { expected_version: composition.value.version, preview })
    if (out.deduplicated) { ElMessage.success('已复用相同 render hash 的正式视频'); await load(); rendering.value = false; return }
    pollTask(out.task_id, async (task) => { rendering.value = false; if (task.status === 'failed') error.value = task.error || task.message || '正式渲染失败'; else { await load(); ElMessage.success('纸片正式视频已完成') } })
  } catch (e) { rendering.value = false; error.value = e.message || '正式渲染失败' }
}

onMounted(load)
</script>

<style scoped>
.paper-editor { min-height: 100%; padding: 24px; color: #1f2937; background: #f7f8fb; }
.paper-editor__header { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; margin-bottom:18px; }
.paper-editor__eyebrow { color:#8b5e34; font-size:11px; letter-spacing:1.8px; font-weight:700; }
.paper-editor h1 { margin:5px 0; font-size:24px; }
.paper-editor p { margin:0; color:#64748b; font-size:13px; }
.paper-editor__actions { display:flex; gap:8px; flex-wrap:wrap; }
.paper-editor__alert { margin-bottom:14px; }
.paper-editor__meta { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:14px; color:#64748b; font-size:12px; }
.paper-editor__grid { display:grid; grid-template-columns: minmax(230px, .8fr) minmax(300px, 1.2fr); gap:14px; }
.paper-card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px; box-shadow:0 3px 12px rgba(15,23,42,.04); }
.paper-card__title { font-weight:700; margin-bottom:12px; color:#334155; }
.paper-card--layers { grid-row:span 2; }
.paper-layer-row { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px; border:1px solid #eef0f4; border-radius:8px; margin-bottom:8px; cursor:pointer; }
.paper-layer-row.active { border-color:#c28a54; background:#fff9f2; }
.paper-layer-row__key { display:block; font-size:13px; font-weight:650; }
.paper-layer-row__type { display:block; margin-top:3px; color:#94a3b8; font-size:11px; }
.paper-layer-row__actions { display:flex; align-items:center; gap:6px; min-width:0; }
.paper-layer-row__actions .codex-image-job { max-width:132px; }
.paper-empty { color:#94a3b8; font-size:13px; padding:18px 0; text-align:center; }
.paper-inspector__hint,.paper-editor__note { color:#64748b; font-size:12px; margin-bottom:10px; }
.paper-asset-inspector { display:grid; grid-template-columns:auto minmax(0, 1fr); align-items:center; gap:8px; padding:9px; margin:10px 0 12px; border:1px solid #f1e1cf; border-radius:8px; background:#fffaf4; }
.paper-asset-inspector__label,.paper-asset-inspector__note { grid-column:1 / -1; color:#7c5a36; font-size:11px; }
.paper-asset-inspector__thumb { width:58px; height:58px; object-fit:cover; border-radius:6px; border:1px solid #ead8c3; cursor:zoom-in; }
.paper-asset-inspector .codex-image-job { min-width:0; }
.paper-asset-inspector__note { color:#9a7650; line-height:1.45; }
.paper-rig-assets { display:grid; gap:7px; margin:10px 0 12px; padding:10px; border:1px solid #e8dccf; border-radius:8px; background:#fcfaf7; }
.paper-rig-assets__title { color:#6b4f34; font-size:12px; font-weight:700; }
.paper-rig-assets__row { display:grid; grid-template-columns:minmax(90px,1fr) minmax(110px,132px); gap:8px; align-items:center; padding-top:7px; border-top:1px solid #eee5dc; }
.paper-rig-assets__row strong,.paper-rig-assets__row small { display:block; }
.paper-rig-assets__row strong { font-size:12px; color:#475569; }.paper-rig-assets__row small { margin-top:2px; color:#94a3b8; font-size:10px; }
.paper-form-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:9px; }
.paper-form-grid label { color:#64748b; font-size:11px; }
.paper-form-grid input { display:block; width:100%; box-sizing:border-box; margin-top:4px; border:1px solid #dbe1ea; border-radius:6px; padding:6px; }
.paper-field-label { display:block; color:#64748b; font-size:11px; margin:10px 0 4px; }
.paper-inspector__actions { margin-top:12px; }
.paper-phase-list { display:grid; grid-template-columns:repeat(2,1fr); gap:6px; margin-bottom:12px; }
.paper-phase { display:flex; justify-content:space-between; padding:6px 8px; background:#f8fafc; border-radius:6px; font-size:11px; color:#475569; }
.paper-wide-button { width:100%; margin-top:10px; }
.paper-validation-summary { padding:8px; margin:10px 0; border-radius:7px; background:#fff7ed; color:#9a3412; font-size:12px; }
.paper-validation-summary.pass { background:#ecfdf5; color:#047857; }
.paper-issue { display:grid; grid-template-columns:auto 1fr; gap:4px 8px; padding:8px; border-radius:7px; margin-top:7px; font-size:11px; }
.paper-issue span { color:#475569; }.paper-issue code { grid-column:1 / -1; color:#94a3b8; word-break:break-all; }
.paper-issue--blocking { background:#fff1f2; }.paper-issue--blocking strong { color:#be123c; }
.paper-issue--warning { background:#fffbeb; }.paper-issue--warning strong { color:#b45309; }
.paper-proof-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.paper-proof { min-height:82px; border:1px solid #e5e7eb; border-radius:7px; overflow:hidden; background:#f8fafc; }
.paper-proof__label { padding:4px 6px; font-size:10px; color:#64748b; background:#fff; }.paper-proof img { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; }.paper-proof__empty { display:flex; align-items:center; justify-content:center; height:58px; color:#cbd5e1; font-size:11px; }
@media (max-width: 900px) { .paper-editor__header { flex-direction:column; }.paper-editor__grid { grid-template-columns:1fr; }.paper-card--layers { grid-row:auto; } }
</style>
