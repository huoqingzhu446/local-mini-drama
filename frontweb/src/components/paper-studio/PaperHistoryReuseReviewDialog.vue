<template>
  <div v-if="open" class="review-backdrop">
    <section ref="dialogRef" class="review-dialog" role="dialog" aria-modal="true" aria-labelledby="reuse-review-title" tabindex="-1">
      <header>
        <div>
          <span>HISTORY REUSE REVIEW</span>
          <h2 id="reuse-review-title">逐张确认历史候选</h2>
          <p>这些图片文件完整且曾获批准，但视觉合同有变化。未明确选择前不会复用，也不会调用图片 API。</p>
        </div>
        <button type="button" aria-label="关闭历史候选审核" @click="emit('cancel')">×</button>
      </header>
      <div class="review-list">
        <article v-for="slot in reviewSlots" :key="slot.slot_id">
          <img v-if="slot.preview_url" :src="slot.preview_url" :alt="`${slot.slot_key} 历史复用候选`" />
          <div v-else class="missing-preview">没有可用预览</div>
          <div class="candidate-copy">
            <span>{{ slot.family_key }} / {{ slot.slot_key }}</span>
            <strong>来自 V{{ slot.source_asset_version_id }} · 需要人工判断</strong>
            <small>{{ reasonLabels(slot.reasons).join('、') || '视觉合同部分变化' }}</small>
            <p>采用：建立可追溯复用，图片 API 0 次。差异生成：该候选退出本槽位，之后进入费用报价。</p>
          </div>
          <div class="candidate-choice" role="group" :aria-label="`${slot.slot_key} 处理方式`">
            <button type="button" :class="{ active: choices[slot.slot_id] === 'accepted' }" @click="choices[slot.slot_id] = 'accepted'">采用旧图 · 0 调用</button>
            <button type="button" :class="{ active: choices[slot.slot_id] === 'declined' }" @click="choices[slot.slot_id] = 'declined'">改为差异生成</button>
          </div>
        </article>
      </div>
      <footer>
        <div>
          <strong>已处理 {{ resolvedCount }}/{{ reviewSlots.length }}</strong>
          <small>采用 {{ acceptedCount }} · 差异生成 {{ declinedCount }}</small>
        </div>
        <button type="button" class="cancel" :disabled="busy" @click="emit('cancel')">返回</button>
        <button type="button" class="confirm" :disabled="busy || resolvedCount !== reviewSlots.length" @click="confirm">
          {{ busy ? '正在记录…' : '确认选择并重新报价' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  preview: { type: Object, default: null },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['confirm', 'cancel'])
const choices = reactive({})
const dialogRef = ref(null)
const reviewSlots = computed(() => (props.preview?.slots || []).filter((slot) => slot.source_kind === 'history_review_required'))
const resolvedCount = computed(() => reviewSlots.value.filter((slot) => ['accepted', 'declined'].includes(choices[slot.slot_id])).length)
const acceptedCount = computed(() => reviewSlots.value.filter((slot) => choices[slot.slot_id] === 'accepted').length)
const declinedCount = computed(() => reviewSlots.value.filter((slot) => choices[slot.slot_id] === 'declined').length)

watch(() => [props.open, props.preview?.reuse_preview_fingerprint], async ([open]) => {
  for (const key of Object.keys(choices)) delete choices[key]
  if (open) {
    await nextTick()
    dialogRef.value?.focus()
  }
})

function reasonLabels(reasons = []) {
  const labels = {
    visual_contract_changed: '画面合同发生变化',
    generation_purpose_changed: '素材用途发生变化',
    source_not_approved: '来源没有有效批准',
    file_missing: '文件缺失',
    hash_mismatch: '文件 hash 异常',
  }
  return reasons.map((reason) => labels[reason] || reason)
}

function confirm() {
  if (resolvedCount.value !== reviewSlots.value.length) return
  emit('confirm', reviewSlots.value.map((slot) => ({
    slot_id: Number(slot.slot_id),
    source_asset_version_id: Number(slot.source_asset_version_id),
    decision: choices[slot.slot_id],
  })))
}
</script>

<style scoped>
.review-backdrop { position: fixed; inset: 0; z-index: 96; display: grid; place-items: center; padding: 24px; background: rgb(7 8 7 / 82%); backdrop-filter: blur(6px); }
.review-dialog { width: min(920px, calc(100vw - 40px)); max-height: calc(100vh - 48px); overflow-y: auto; outline: none; border: 1px solid #665737; background: #191a17; color: var(--paper-text); box-shadow: 0 26px 90px rgb(0 0 0 / 58%); }
.review-dialog > header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 24px; padding: 22px 26px 18px; border-bottom: 1px solid var(--paper-line); background: rgb(25 26 23 / 97%); }
.review-dialog header span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .15em; }
.review-dialog h2 { margin: 5px 0 0; font: 600 24px/1.25 Georgia, 'Songti SC', serif; }
.review-dialog header p { max-width: 680px; margin: 7px 0 0; color: var(--paper-dim); font-size: 12px; line-height: 1.55; }
.review-dialog header button { width: 34px; height: 34px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: 22px; cursor: pointer; }
.review-list { padding: 4px 26px 10px; }
.review-list article { display: grid; grid-template-columns: 180px minmax(0, 1fr) 176px; gap: 20px; padding: 20px 0; border-bottom: 1px solid var(--paper-line); }
.review-list img, .missing-preview { width: 180px; height: 118px; display: grid; place-items: center; object-fit: cover; background: #10110e; color: var(--paper-dim); font-size: 11px; }
.candidate-copy { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.candidate-copy span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; }
.candidate-copy strong { font-size: 14px; }
.candidate-copy small { color: #bd826e; font-size: 11px; }
.candidate-copy p { margin: 4px 0 0; color: var(--paper-dim); font-size: 11px; line-height: 1.55; }
.candidate-choice { display: flex; flex-direction: column; gap: 8px; }
.candidate-choice button { min-height: 38px; padding: 7px 10px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); cursor: pointer; }
.candidate-choice button.active { border-color: var(--paper-accent); background: #2a261a; color: var(--paper-accent); }
.review-dialog > footer { position: sticky; bottom: 0; display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px; padding: 16px 26px; border-top: 1px solid var(--paper-line); background: rgb(25 26 23 / 97%); }
.review-dialog footer div { display: flex; flex-direction: column; gap: 3px; }
.review-dialog footer strong { font-size: 12px; }
.review-dialog footer small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.review-dialog footer button { min-height: 38px; padding: 0 16px; cursor: pointer; }
.review-dialog footer .cancel { border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); }
.review-dialog footer .confirm { border: 0; background: var(--paper-accent); color: #211c13; font-weight: 800; }
button:focus-visible { outline: 2px solid var(--paper-accent); outline-offset: 2px; }
@media (max-width: 760px) {
  .review-list article { grid-template-columns: 120px 1fr; }
  .review-list img, .missing-preview { width: 120px; height: 90px; }
  .candidate-choice { grid-column: 1 / -1; flex-direction: row; }
  .candidate-choice button { flex: 1; }
  .review-dialog > footer { grid-template-columns: 1fr 1fr; }
  .review-dialog footer div { grid-column: 1 / -1; }
}
</style>
