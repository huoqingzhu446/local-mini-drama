<template>
  <section v-if="report || evidence.length" class="motion-evidence" aria-labelledby="motion-evidence-title">
    <header class="evidence-heading">
      <div>
        <span>MOTION EVIDENCE</span>
        <h3 id="motion-evidence-title">动作是否真的发生</h3>
        <p>门禁同时检查动作合同、主体轨道和证据帧；画面有变化不等于动作符合脚本。</p>
      </div>
      <div class="gate-state" :class="report?.pass ? 'passed' : 'failed'">
        <strong>{{ report?.pass ? '语义门禁通过' : '需要修正动作' }}</strong>
        <small>{{ passedCount }}/{{ businessAssertions.length }} 项符合合同</small>
      </div>
    </header>

    <div class="gate-grid">
      <article v-for="item in businessAssertions" :key="item.key" :class="item.pass ? 'passed' : 'failed'">
        <div>
          <span>{{ assertionLabel(item.key) }}</span>
          <strong>{{ formatActual(item) }}</strong>
        </div>
        <p>{{ assertionExplanation(item) }}</p>
        <button v-if="!item.pass" type="button" :disabled="busy" @click="$emit('revise', repairInstruction(item.key))">
          只修这一项
        </button>
      </article>
    </div>

    <section v-if="revisionChanges.length" class="revision-summary">
      <div>
        <span>最近一次动作修订</span>
        <strong>{{ latestRevision.instruction }}</strong>
      </div>
      <ul>
        <li v-for="item in revisionChanges" :key="`${item.target}:${item.property}`">
          <span>{{ changeLabel(item) }}</span>
          <strong>{{ changeValue(item.before) }} → {{ changeValue(item.after) }}</strong>
        </li>
      </ul>
    </section>

    <div v-if="evidence.length" class="evidence-workspace">
      <nav aria-label="动作证据帧">
        <button
          v-for="item in evidence"
          :key="item.id || item.target_key"
          type="button"
          :class="{ active: item === selectedEvidence, failed: item.status !== 'passed' }"
          @click="selectedEvidenceKey = item.id || item.target_key"
        >
          <span>{{ targetLabel(item.target_key) }}</span>
          <small>{{ frameTime(item.frame) }}</small>
          <i>{{ item.status === 'passed' ? '通过' : '失败' }}</i>
        </button>
      </nav>

      <main>
        <img v-if="selectedEvidence?.full_url" :src="selectedEvidence.full_url" :alt="`${targetLabel(selectedEvidence.target_key)}证据帧`" />
        <div v-else class="evidence-empty">证据帧文件暂不可用</div>
      </main>

      <aside>
        <div class="frame-title">
          <span>{{ targetLabel(selectedEvidence?.target_key) }}</span>
          <strong>第 {{ selectedEvidence?.frame ?? 0 }} 帧</strong>
        </div>
        <dl>
          <div><dt>画面变化</dt><dd>{{ percent(selectedEvidence?.metrics_json?.changed_pixel_ratio) }}</dd></div>
          <div><dt>平均差异</dt><dd>{{ decimal(selectedEvidence?.metrics_json?.mean_absolute_difference) }}</dd></div>
        </dl>
        <ul>
          <li v-for="(item, index) in selectedEvidence?.assertion_json || []" :key="`${item.type}-${index}`" :class="item.pass ? 'passed' : 'failed'">
            <span>{{ evidenceAssertionLabel(item) }}</span>
            <strong>{{ evidenceActual(item) }}</strong>
          </li>
        </ul>
      </aside>
    </div>

    <details v-if="technicalAssertions.length" class="technical-details">
      <summary>查看轨道与帧范围技术检查（{{ technicalAssertions.length }}）</summary>
      <ul>
        <li v-for="item in technicalAssertions" :key="item.key" :class="item.pass ? 'passed' : 'failed'">
          <code>{{ item.key }}</code><span>{{ item.pass ? '通过' : '失败' }}</span>
        </li>
      </ul>
    </details>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  shot: { type: Object, default: null },
  busy: { type: Boolean, default: false },
})
defineEmits(['revise'])

const selectedEvidenceKey = ref(null)
const proof = computed(() => (props.shot?.proof_runs || []).find((item) => item.run_kind === 'motion_proof' && item.report_json?.motion_gate)
  || (props.shot?.proof_runs || []).find((item) => item.report_json?.motion_gate)
  || null)
const report = computed(() => proof.value?.report_json?.motion_gate || null)
const evidence = computed(() => props.shot?.evidence || [])
const selectedEvidence = computed(() => evidence.value.find((item) => String(item.id || item.target_key) === String(selectedEvidenceKey.value))
  || evidence.value[0]
  || null)
const businessAssertions = computed(() => (report.value?.assertions || []).filter((item) => (
  item.metric || ['camera_only_false', 'visible_subject_tracks', 'primary_action_catalogued'].includes(item.key)
)))
const technicalAssertions = computed(() => (report.value?.assertions || []).filter((item) => !businessAssertions.value.includes(item)))
const passedCount = computed(() => businessAssertions.value.filter((item) => item.pass).length)
const latestRevision = computed(() => props.shot?.motion_revisions?.[0] || null)
const revisionChanges = computed(() => latestRevision.value?.patch_json?.changes || [])

watch(() => props.shot?.id, () => { selectedEvidenceKey.value = evidence.value[0]?.id || evidence.value[0]?.target_key || null }, { immediate: true })
watch(evidence, () => {
  if (!evidence.value.some((item) => String(item.id || item.target_key) === String(selectedEvidenceKey.value))) {
    selectedEvidenceKey.value = evidence.value[0]?.id || evidence.value[0]?.target_key || null
  }
}, { deep: true })

function assertionLabel(key) {
  return {
    camera_only_false: '主体动作不是运镜替代',
    visible_subject_tracks: '可见主体轨道',
    primary_action_catalogued: '动作类型已识别',
    subject_translation: '人物移动距离',
    subject_state_progression: '人物状态变化',
    posture_vertical_change: '姿态高度变化',
    subject_action_range: '主体动作幅度',
    action_object_follows_subject: '道具跟随距离',
    action_object_state_progression: '道具状态变化',
    release_cue_exists: '放下道具时刻',
    actor_reaches_destination: '人物到达目标',
    actor_has_seated_state: '坐下状态',
    prop_follows_actor: '道具跟随人物',
    prop_releases: '道具释放状态',
    support_occlusion_final: '前景遮挡关系',
  }[key] || key
}
function formatActual(item) {
  if (item.key === 'camera_only_false') return item.pass ? '主体在动' : '只有运镜'
  if (item.metric === 'cue_exists') return item.pass ? '已找到' : '未找到'
  if (Array.isArray(item.actual)) return `${item.actual.length} 项`
  if (typeof item.actual === 'number') return decimal(item.actual)
  if (typeof item.actual === 'boolean') return item.actual ? '是' : '否'
  return item.pass ? '已通过' : '未通过'
}
function assertionExplanation(item) {
  if (item.min != null) return `实测 ${formatActual(item)}，合同要求至少 ${decimal(item.min)}`
  if (item.expected != null && !Array.isArray(item.expected)) return `实测 ${formatActual(item)}，合同期望 ${String(item.expected)}`
  return item.pass ? '符合当前动作合同' : '与当前动作合同不一致'
}
function repairInstruction(key) {
  return {
    subject_translation: '只修正人物位移：让人物清楚地从起点移动到目标位置，不改变其他素材和动作时刻。',
    actor_reaches_destination: '只修正人物终点：让人物到达动作合同中的目标关键点。',
    subject_state_progression: '只修正人物状态：补齐起始、动作中和结束三个阶段。',
    posture_vertical_change: '只修正姿态高度变化：让起身或坐下在主体高度上清楚可见，不改变运镜。',
    subject_action_range: '只修正主体动作幅度：增强主体自身动作，不用摄像机运动代替。',
    action_object_follows_subject: '只修正道具跟随：手持阶段让道具与人物同步移动。',
    prop_follows_actor: '只修正道具跟随：手持阶段让道具与人物同步移动。',
    action_object_state_progression: '只修正道具状态：补齐手持、携带和释放三个阶段。',
    release_cue_exists: '只修正放下道具事件：加入明确的释放时刻。',
    prop_releases: '只修正道具释放：结束时让道具脱离人物并落在目标位置。',
    support_occlusion_final: '只修正前景遮挡：在合同指定阶段恢复正确的前后层级。',
  }[key] || `只修正门禁失败项 ${assertionLabel(key)}，保留其它已通过动作。`
}
function changeLabel(item) {
  const target = /prop/i.test(item.target) ? '道具' : /actor|subject|character/i.test(item.target) ? '人物' : item.target
  return `${target}${{ x: '横向位移', y: '纵向位移', rotation: '旋转幅度', state: '状态阶段', release_prop: '释放时刻' }[item.property] || item.property}`
}
function changeValue(value) {
  if (!value) return '无'
  if (value.exists != null) return value.exists ? `第 ${value.frame} 帧` : '缺失'
  if (value.distinct_states != null) return `${value.distinct_states} 状态（${value.initial} / ${value.final}）`
  if (value.range != null) return `${decimal(value.range)}（${decimal(value.initial)} / ${decimal(value.final)}）`
  return '已变化'
}
function targetLabel(key) { return { subject_start: '起始状态', subject_action: '动作过程', subject_final: '结束状态', carry_start: '持物起点', carry_arrive: '到达目标', carry_final: '坐下与放置' }[key] || key || '证据帧' }
function frameTime(frame) { return `${(Number(frame || 0) / Number(props.shot?.motion_plan?.plan_json?.fps || 30)).toFixed(1)}s` }
function evidenceAssertionLabel(item) {
  if (item.type === 'state_equals') return `${item.target} 状态`
  if (item.type === 'track_range') return `${item.target} ${item.property} 位移`
  if (item.type === 'relation_exists') return `${item.node} 关系`
  if (item.type === 'subject_pixel_change') return '主体像素变化'
  if (item.type === 'camera_only') return '是否仅运镜'
  return item.type
}
function evidenceActual(item) {
  if (typeof item.actual === 'object' && item.actual) return item.actual.predicate || item.actual.role || item.actual.node || '存在'
  if (typeof item.actual === 'number') return decimal(item.actual)
  if (typeof item.actual === 'boolean') return item.actual ? '是' : '否'
  return String(item.actual ?? (item.pass ? '通过' : '缺失'))
}
function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%` }
function decimal(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(2).replace(/\.00$/, '') : '—' }
</script>

<style scoped>
.motion-evidence { margin-top: 30px; padding-top: 24px; border-top: 1px solid var(--paper-line); }
.evidence-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.evidence-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .14em; }
.evidence-heading h3 { margin: 6px 0 0; color: var(--paper-text); font: 600 20px Georgia, 'Songti SC', serif; }
.evidence-heading p { margin: 6px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-sm); }
.gate-state { min-width: 150px; text-align: right; }
.gate-state strong, .gate-state small { display: block; }
.gate-state strong { color: #d48676; font-size: var(--paper-fs-base); }
.gate-state.passed strong { color: #83a982; }
.gate-state small { margin-top: 5px; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.gate-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; margin-top: 16px; background: var(--paper-line); border: 1px solid var(--paper-line); }
.gate-grid article { min-height: 92px; padding: 13px; background: #181916; }
.gate-grid article > div { display: flex; justify-content: space-between; gap: 12px; }
.gate-grid span { color: var(--paper-muted); font-size: var(--paper-fs-xs); }
.gate-grid strong { color: #d48676; font: 600 11px ui-monospace, monospace; }
.gate-grid article.passed strong { color: #83a982; }
.gate-grid p { margin: 8px 0 0; color: var(--paper-dim); font-size: var(--paper-fs-xs); line-height: 1.5; }
.gate-grid button { margin-top: 9px; border: 1px solid #7f5149; padding: 6px 8px; background: transparent; color: #d59a8c; font-size: var(--paper-fs-xs); cursor: pointer; }
.revision-summary { display: grid; grid-template-columns: minmax(180px, .7fr) minmax(0, 1.3fr); gap: 18px; margin-top: 12px; padding: 14px; border-left: 2px solid var(--paper-accent); background: #1a1b17; }
.revision-summary > div span, .revision-summary > div strong { display: block; }
.revision-summary > div span { color: var(--paper-accent); font-size: var(--paper-fs-xs); }
.revision-summary > div strong { margin-top: 5px; color: var(--paper-text); font-size: var(--paper-fs-sm); line-height: 1.5; }
.revision-summary ul { margin: 0; padding: 0; list-style: none; }
.revision-summary li { display: flex; justify-content: space-between; gap: 14px; padding: 5px 0; border-bottom: 1px solid var(--paper-line-soft); font-size: var(--paper-fs-xs); }
.revision-summary li span { color: var(--paper-muted); }
.revision-summary li strong { color: #83a982; font: 600 var(--paper-fs-xs) ui-monospace, monospace; text-align: right; }
.evidence-workspace { display: grid; grid-template-columns: 150px minmax(320px, 1fr) 230px; min-height: 360px; margin-top: 16px; border: 1px solid var(--paper-line); background: #11120f; }
.evidence-workspace nav { border-right: 1px solid var(--paper-line); background: #191a17; }
.evidence-workspace nav button { width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; padding: 12px; border: 0; border-bottom: 1px solid #292a26; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.evidence-workspace nav button.active { box-shadow: inset 2px 0 var(--paper-accent); background: #242520; color: var(--paper-text); }
.evidence-workspace nav span { font-size: var(--paper-fs-sm); }
.evidence-workspace nav small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.evidence-workspace nav i { grid-column: 2; grid-row: 1 / 3; align-self: center; color: #83a982; font-size: var(--paper-fs-xs); font-style: normal; }
.evidence-workspace nav button.failed i { color: #d48676; }
.evidence-workspace main { display: grid; place-items: center; overflow: hidden; padding: 18px; background: #0d0e0c; }
.evidence-workspace main img { display: block; max-width: 100%; max-height: 520px; object-fit: contain; }
.evidence-empty { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.evidence-workspace aside { padding: 16px; border-left: 1px solid var(--paper-line); background: #1a1b18; }
.frame-title span, .frame-title strong { display: block; }
.frame-title span { color: var(--paper-accent); font-size: var(--paper-fs-xs); }
.frame-title strong { margin-top: 5px; color: var(--paper-text); font-size: var(--paper-fs-lg); }
dl { margin: 14px 0 0; border-top: 1px solid var(--paper-line); }
dl div { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #292a26; font-size: var(--paper-fs-xs); }
dt { color: var(--paper-dim); }
dd { margin: 0; color: var(--paper-muted); }
.evidence-workspace ul, .technical-details ul { margin: 12px 0 0; padding: 0; list-style: none; }
.evidence-workspace li { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 7px 0; border-bottom: 1px solid #292a26; font-size: var(--paper-fs-xs); }
.evidence-workspace li span { color: var(--paper-muted); }
.evidence-workspace li strong { color: #d48676; }
.evidence-workspace li.passed strong { color: #83a982; }
.technical-details { margin-top: 10px; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.technical-details summary { cursor: pointer; }
.technical-details li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid var(--paper-line-soft); }
.technical-details li span { color: #d48676; }
.technical-details li.passed span { color: #83a982; }
@media (max-width: 1120px) { .evidence-workspace { grid-template-columns: 130px 1fr; } .evidence-workspace aside { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--paper-line); } }
</style>
