<template>
  <div class="run-overview">
    <section class="run-heading">
      <div>
        <span class="run-kicker">RUN {{ String(run?.run_number || 0).padStart(2, '0') }}</span>
        <h2>{{ shot?.storyboard?.title || '选择一个分镜' }}</h2>
        <p>{{ shot?.storyboard?.action || shot?.storyboard?.description || '等待分镜分析后生成语义合同。' }}</p>
      </div>
      <div class="run-meta">
        <span>{{ tierLabel(run?.quality_tier) }}</span>
        <span>{{ run?.shots?.length || 0 }} 镜</span>
        <span>{{ run?.progress || 0 }}%</span>
      </div>
    </section>

    <section class="production-track" aria-label="生产步骤">
      <div
        v-for="(step, index) in steps"
        :key="step.key"
        class="track-step"
        :class="{ done: index < activeIndex, current: index === activeIndex }"
      >
        <span class="track-node">{{ index + 1 }}</span>
        <span class="track-copy">
          <strong>{{ step.label }}</strong>
          <small>{{ step.detail }}</small>
        </span>
      </div>
    </section>

    <section v-if="shot?.paper_storyboard_id" class="run-audio-gate" :class="shot?.audio?.ready ? 'ready' : 'attention'">
      <div>
        <span>SOUND GATE</span>
        <strong>{{ audioGateTitle }}</strong>
        <p>{{ audioGateDescription }}</p>
      </div>
      <div v-if="shot?.audio?.ready && shot.audio.audio_mode !== 'silent'" class="audio-version-facts">
        <span v-if="shot.audio.dialogue">对白 V{{ shot.audio.dialogue.version_number }}</span>
        <span v-if="shot.audio.narration">旁白 V{{ shot.audio.narration.version_number }}</span>
      </div>
      <button type="button" :disabled="acting || shot?.status === 'rendering'" @click="$emit('edit-audio')">
        {{ shot?.audio?.ready ? '检查声音与字幕' : '返回补齐声音' }}
      </button>
    </section>

    <PaperBlueprintEditor
      v-if="shot?.blueprint"
      :shot="shot"
      :busy="acting"
      :regenerating-slot-id="regeneratingSlotId"
      @save="$emit('save-blueprint', $event)"
      @confirm="$emit('confirm-blueprint')"
    />

    <section class="shot-stage">
      <div class="stage-preview">
        <video v-if="stageVideoUrl" :key="stageVideoUrl" :src="stageVideoUrl" controls playsinline preload="metadata" />
        <img v-else-if="proofImage" :src="proofImage" alt="纸片动画动态证明" />
        <img v-else-if="shotImage" :src="shotImage" alt="分镜参考图" />
        <div v-else class="stage-empty">
          <span>REFERENCE FRAME</span>
          <strong>等待分镜参考图</strong>
        </div>
        <div class="stage-caption">
          <span>{{ stageMediaLabel }}</span>
          <span>{{ shot?.current_snapshot ? shortHash(shot.current_snapshot.render_hash) : '不会直接成为最终背景' }}</span>
        </div>
        <button
          v-if="shot?.status === 'preview_ready'"
          type="button"
          class="reject-preview-button"
          :disabled="acting"
          @click="$emit('reject-preview')"
        >退回预览</button>
      </div>
      <div class="contract-panel">
        <div class="panel-label">当前合同</div>
        <dl>
          <div><dt>状态</dt><dd>{{ shotStatusLabel(shot?.status) }}</dd></div>
          <div><dt>下一步</dt><dd>{{ shot?.next_action?.label || run?.next_action?.label || '等待' }}</dd></div>
          <div><dt>源版本</dt><dd class="mono">{{ shortHash(shot?.source_revision_hash) }}</dd></div>
          <div><dt>画面时长</dt><dd>{{ shot?.storyboard?.duration || 0 }} 秒</dd></div>
          <div v-if="shot?.audio"><dt>声音门禁</dt><dd :class="shot.audio.ready ? 'pass' : 'attention-text'">{{ shot.audio.ready ? (shot.audio.audio_mode === 'silent' ? '明确静音' : '已就绪') : '待处理' }}</dd></div>
          <div v-if="shot?.plan_summary_json?.semantic_primitives?.length"><dt>能力组合</dt><dd>{{ primitiveSummary }}</dd></div>
          <div v-if="shot?.families?.length"><dt>素材族</dt><dd>{{ shot.families.length }} 组 / {{ slotCount }} 槽位</dd></div>
          <div v-if="shot?.continuity?.length"><dt>跨镜连续性</dt><dd>{{ continuitySummary }}</dd></div>
          <div v-if="shot?.motion_revisions?.length"><dt>{{ environmentOnly ? '环境动态修订' : '动作修订' }}</dt><dd>{{ shot.motion_revisions.length }} 次</dd></div>
          <div v-if="shot?.plan_summary_json?.camera_only === false"><dt>动态约束</dt><dd class="pass">{{ environmentOnly ? '环境动态已规划' : '主体动作已规划' }}</dd></div>
        </dl>
        <div v-if="shot?.families?.length" class="family-list">
          <div v-for="family in shot.families" :key="family.id" class="family-row">
            <span>{{ family.family_key }}</span>
            <small>{{ family.pattern }} · {{ readySlots(family) }}/{{ family.slots.length }} ready</small>
          </div>
        </div>
        <div class="phase-note">
          {{ phaseNote }}
        </div>
      </div>
    </section>

    <PaperAssetReviewWorkbench
      v-if="shot?.families?.some((family) => family.slots?.length)"
      :shot="shot"
      :busy="acting"
      @approve="$emit('approve-asset', $event)"
      @reject="$emit('reject-asset', $event)"
      @rematte="$emit('rematte-asset', $event)"
      @regenerate="$emit('regenerate-asset', $event)"
      @upload="$emit('upload-asset', $event)"
      @patch-mask="$emit('patch-asset-mask', $event)"
    />

    <PaperMotionEvidencePanel
      v-if="shot?.evidence?.length || shot?.proof_runs?.some((item) => item.report_json?.motion_gate)"
      :shot="shot"
      :busy="acting"
      @revise="$emit('revise-motion', $event)"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import PaperBlueprintEditor from './PaperBlueprintEditor.vue'
import PaperAssetReviewWorkbench from './PaperAssetReviewWorkbench.vue'
import PaperMotionEvidencePanel from './PaperMotionEvidencePanel.vue'

const props = defineProps({
  run: { type: Object, default: null },
  shot: { type: Object, default: null },
  acting: { type: Boolean, default: false },
  regeneratingSlotId: { type: Number, default: null },
})
defineEmits([
  'approve-asset', 'rematte-asset', 'reject-asset', 'regenerate-asset',
  'upload-asset', 'patch-asset-mask', 'reject-preview', 'save-blueprint', 'confirm-blueprint',
  'revise-motion', 'edit-audio',
])

const environmentOnly = computed(() => Boolean(props.shot?.storyboard?.environment_only || props.shot?.plan_summary_json?.environment_only))
const steps = computed(() => [
  { key: 'plan', label: '镜头分析', detail: environmentOnly.value ? '环境层与动态意图' : '关系与素材预算' },
  { key: 'assets', label: environmentOnly.value ? '环境底板' : '素材生产', detail: environmentOnly.value ? '一张底板 · 本地动态' : '母版、成员与 Alpha' },
  { key: 'motion', label: environmentOnly.value ? '环境动态' : '动作规划', detail: environmentOnly.value ? '雾气、空气与运镜' : '主体动作与 cue' },
  { key: 'proof', label: '动态检查', detail: '像素变化与关系证据' },
  { key: 'sound', label: '声音字幕', detail: '音轨版本与 cue' },
  { key: 'preview', label: '预览批准', detail: '同 snapshot 复核' },
  { key: 'publish', label: '正式发布', detail: '渲染与分镜合并' },
])

const statusStep = {
  draft: 0, analyzing: 0, plan_review: 0, awaiting_generation_authorization: 1,
  assets_generating: 1, assets_processing: 1,
  motion_planning: 2, proofing: 3,
  preview_ready: 5, approved: 6, rendering: 6, delivered: 7,
}
const shotStatusStep = {
  pending: 0, analyzed: 0, plan_confirmed: 1, asset_pending: 1, asset_failed: 1,
  asset_review: 1, asset_ready: 2, motion_failed: 2, motion_ready: 3, proof_failed: 3, proof_ready: 4,
  preview_ready: 5, approved: 6, render_failed: 6, rendered: 6, published: 7,
}
const activeIndex = computed(() => {
  const index = shotStatusStep[props.shot?.status] ?? statusStep[props.run?.status] ?? 0
  if (props.shot?.status === 'proof_ready' && props.shot?.audio?.ready) return 5
  return index
})
const slotCount = computed(() => (props.shot?.families || []).reduce((total, family) => total + (family.slots?.length || 0), 0))
const primitiveLabels = {
  independent_asset_versions: '独立素材',
  supported_subject: '支撑关系',
  registered_environment: '注册环境',
  registered_boundary: '环境边界',
  multi_subject_interaction: '多主体交互',
  state_transition: '状态动作',
  contact_cue: '接触时刻',
  attached_prop: '附着道具',
  front_occlusion: '前景遮挡',
  boundary_registration: '边界注册',
  boundary_crossing: '穿越边界',
  contact_zone: '接触区域',
  state_atlas: '姿态状态组',
}
const primitiveSummary = computed(() => (props.shot?.plan_summary_json?.semantic_primitives || []).slice(0, 4).map((key) => primitiveLabels[key] || key).join(' · '))
const continuitySummary = computed(() => {
  const items = props.shot?.continuity || []
  const satisfied = items.filter((item) => item.status === 'satisfied').length
  const failed = items.filter((item) => item.status === 'failed').length
  return failed ? `${failed} 项失败` : `${satisfied}/${items.length} 已锁定`
})
const phaseNote = computed(() => {
  if (props.shot?.families?.length) {
    if (environmentOnly.value) return '系统只保留一张需要你审核的环境底板；雾气漂移、空气流动与轻微运镜由本地程序动画完成，不会额外调用图片 API。'
    return `系统已从当前分镜组合 ${primitiveSummary.value || '独立素材与主体动作'}；具体场景不是模式，所有镜头统一进入同一纸片动画生产链。`
  }
  return '生产版本已冻结；先执行镜头分析，生成干净背景、独立主体与动态证明计划。'
})
const audioGateTitle = computed(() => {
  if (props.shot?.audio?.ready) return props.shot.audio.audio_mode === 'silent' ? '本镜已明确静音' : '当前声音版本已就绪'
  return '声音尚未满足预览与正式制作要求'
})
const audioGateDescription = computed(() => {
  if (props.shot?.audio?.ready) {
    return props.shot.audio.audio_mode === 'silent'
      ? '下一次 snapshot 不会带入音轨和字幕；这是用户明确选择，不是系统自动忽略。'
      : '对白、旁白、时间和字幕会与素材、动作一起固定到同一 snapshot。'
  }
  return (props.shot?.audio?.missing || []).map((item) => item.reason).join('；') || '请生成、上传对应音频，或明确选择静音。'
})

const shotImage = computed(() => {
  const value = props.shot?.storyboard?.local_path || props.shot?.storyboard?.image_url
  if (!value) return ''
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/static/')) return value
  return `/static/${String(value).replace(/^\/+/, '')}`
})
const proofImage = computed(() => props.shot?.evidence?.find((item) => item.target_key?.includes('peak'))?.full_url || props.shot?.evidence?.[0]?.full_url || '')
const formalVideoUrl = computed(() => {
  const video = props.shot?.formal_video
  if (!video || video.status !== 'completed') return ''
  const value = video.video_url || video.local_path
  if (!value) return ''
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/static/')) return value
  return `/static/${String(value).replace(/^\/+/, '')}`
})
const stageVideoUrl = computed(() => formalVideoUrl.value || props.shot?.latest_preview?.preview_url || '')
const stageMediaLabel = computed(() => {
  if (formalVideoUrl.value) return props.shot?.status === 'published' ? '正式发布视频' : '正式渲染视频'
  if (props.shot?.latest_preview?.preview_url) return '同 snapshot 低清预览'
  if (props.shot?.evidence?.length) return '动态门禁证据帧'
  return '只作为构图与风格参考'
})

function tierLabel(tier) {
  return { draft: '草稿档', balanced: '均衡档', 'full-depth': '全深度档' }[tier] || tier || '均衡档'
}
function shortHash(hash) { return hash ? `${hash.slice(0, 15)}…${hash.slice(-6)}` : '未冻结' }
function readySlots(family) { return (family?.slots || []).filter((slot) => slot.status === 'ready').length }
function shotStatusLabel(status) {
  if (environmentOnly.value) {
    const environmentStatus = {
      plan_confirmed: '环境计划已确认，等待生成授权', asset_pending: '环境底板生成中',
      asset_review: '环境底板待审核', asset_ready: '环境底板已批准', motion_ready: '环境动态已就绪',
      proof_ready: '环境动态检查通过', motion_failed: '环境动态需要自动修复', proof_failed: '环境动态证据未通过',
    }[status]
    if (environmentStatus) return environmentStatus
  }
  return {
    pending: '待分析', analyzed: '已分析', plan_confirmed: '计划已确认，等待生成授权', asset_pending: '素材生产中',
    asset_review: '素材待人工审核',
    asset_ready: '素材就绪', motion_ready: '动作就绪', proof_ready: '动态门禁通过', preview_ready: '预览待批准',
    approved: '已批准', rendering: '渲染中', rendered: '已渲染', published: '已发布', asset_failed: '素材失败',
    motion_failed: '动作门禁失败', proof_failed: '动态门禁失败', render_failed: '渲染失败',
    stale: '计划版本已失效', cancelled: '已取消',
  }[status] || status || '未知'
}
</script>

<style scoped>
.run-overview { min-height: 0; padding: 28px 34px 40px; animation: overview-in .22s ease both; }
@keyframes overview-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
.run-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.run-kicker { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; }
h2 { margin: 8px 0 6px; color: var(--paper-text); font: 600 28px/1.15 Georgia, 'Songti SC', serif; }
p { max-width: 680px; margin: 0; color: var(--paper-muted); font-size: var(--paper-fs-base); line-height: 1.7; }
.run-meta { display: flex; gap: 14px; color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.run-meta span + span { padding-left: 14px; border-left: 1px solid var(--paper-line); }
.production-track { display: grid; grid-template-columns: repeat(7, minmax(90px, 1fr)); margin: 30px 0; border-top: 1px solid var(--paper-line); }
.track-step { position: relative; display: flex; gap: 8px; padding: 16px 8px 0 0; color: var(--paper-dim); }
.track-node { width: 20px; height: 20px; display: grid; place-items: center; margin-top: -27px; border: 1px solid var(--paper-line); border-radius: 50%; background: var(--paper-workspace); font: 600 var(--paper-fs-sm) ui-monospace, monospace; }
.track-copy { display: flex; flex-direction: column; gap: 4px; }
.track-copy strong { font-size: var(--paper-fs-sm); }
.track-copy small { font-size: var(--paper-fs-xs); }
.track-step.done, .track-step.current { color: var(--paper-text); }
.track-step.done .track-node, .track-step.current .track-node { border-color: var(--paper-accent); color: var(--paper-accent); }
.track-step.current .track-node { box-shadow: 0 0 0 5px color-mix(in srgb, var(--paper-accent) 11%, transparent); }
.run-audio-gate { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 18px; margin: -8px 0 26px; padding: 15px 17px; border-left: 2px solid #a97e3c; background: #262219; }
.run-audio-gate.ready { border-left-color: #6d966f; background: #1d241d; }
.run-audio-gate > div:first-child { min-width: 0; }
.run-audio-gate span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .12em; }
.run-audio-gate strong { display: block; margin-top: 4px; color: var(--paper-text); font-size: var(--paper-fs-base); }
.run-audio-gate p { margin-top: 3px; color: var(--paper-muted); font-size: var(--paper-fs-sm); }
.audio-version-facts { display: flex; gap: 6px; }
.audio-version-facts span { padding: 5px 7px; border: 1px solid #3e5140; color: #9aba9b; letter-spacing: 0; }
.run-audio-gate button { padding: 8px 10px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-text); font-size: var(--paper-fs-sm); cursor: pointer; }
.run-audio-gate button:hover:not(:disabled) { border-color: var(--paper-accent); color: var(--paper-accent); }
.run-audio-gate button:disabled { opacity: .4; cursor: not-allowed; }
.shot-stage { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(240px, .7fr); gap: 26px; }
.stage-preview { position: relative; min-height: 360px; overflow: hidden; border-radius: 3px; background: #151514; }
.stage-preview img, .stage-preview video { width: 100%; height: 100%; min-height: 360px; object-fit: contain; background: #111; }
.stage-empty { min-height: 360px; display: grid; place-content: center; gap: 8px; text-align: center; color: #6d675d; }
.stage-empty span { font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .2em; }
.stage-empty strong { color: #9d9587; font: 500 17px Georgia, serif; }
.stage-caption { position: absolute; right: 12px; bottom: 12px; left: 12px; display: flex; justify-content: space-between; padding: 9px 11px; background: rgb(15 15 14 / 78%); color: #a8a195; font-size: var(--paper-fs-sm); backdrop-filter: blur(10px); }
.reject-preview-button { position: absolute; top: 12px; right: 12px; z-index: 2; border: 1px solid rgb(163 50 43 / 70%); border-radius: 3px; padding: 7px 11px; background: rgb(23 20 18 / 82%); color: #d8c9a7; font-size: var(--paper-fs-sm); cursor: pointer; backdrop-filter: blur(8px); }
.reject-preview-button:disabled { opacity: .45; cursor: wait; }
.contract-panel { padding: 4px 0; }
.panel-label { padding-bottom: 12px; border-bottom: 1px solid var(--paper-line); color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .15em; }
dl { margin: 0; }
dl div { display: flex; justify-content: space-between; gap: 20px; padding: 13px 0; border-bottom: 1px solid var(--paper-line-soft); }
dt { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
dd { margin: 0; color: var(--paper-text); font-size: var(--paper-fs-sm); text-align: right; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--paper-muted); }
.phase-note { margin-top: 18px; padding-left: 12px; border-left: 2px solid var(--paper-accent); color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.7; }
.pass { color: #83a982; }
.attention-text { color: #d1ad69; }
.family-list { margin-top: 14px; border-top: 1px solid var(--paper-line-soft); }
.family-row { display: flex; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--paper-line-soft); color: var(--paper-text); font: 600 var(--paper-fs-sm) ui-monospace, monospace; }
.family-row small { color: var(--paper-dim); font: 400 var(--paper-fs-xs) ui-monospace, monospace; }
@media (max-width: 1100px) {
  .production-track { grid-template-columns: repeat(4, 1fr); row-gap: 26px; }
  .shot-stage { grid-template-columns: 1fr; }
  .run-audio-gate { grid-template-columns: 1fr auto; }
  .audio-version-facts { display: none; }
}
</style>
