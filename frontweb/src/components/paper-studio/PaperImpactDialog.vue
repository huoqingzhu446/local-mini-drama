<template>
  <Teleport to="body">
    <Transition name="paper-impact">
      <div v-if="open" class="impact-layer" @keydown.esc="$emit('cancel')">
        <button class="impact-backdrop" type="button" aria-label="取消" @click="$emit('cancel')"></button>
        <section ref="dialog" class="impact-dialog" role="alertdialog" aria-modal="true" aria-labelledby="impact-title" tabindex="-1">
          <header>
            <span>{{ tone === 'danger' ? 'HIGH IMPACT' : 'BEFORE YOU CONTINUE' }}</span>
            <h2 id="impact-title">{{ title }}</h2>
            <p>{{ description }}</p>
          </header>
          <dl>
            <div><dt>保留</dt><dd>{{ impact.preserves || '当前已保存版本与历史记录' }}</dd></div>
            <div><dt>失效</dt><dd>{{ impact.invalidates || '无' }}</dd></div>
            <div class="cost"><dt>调用</dt><dd>{{ impact.cost || '0 次外部调用' }}</dd></div>
          </dl>
          <footer>
            <button type="button" class="cancel" :disabled="busy" @click="$emit('cancel')">{{ cancelLabel }}</button>
            <button type="button" class="confirm" :class="tone" :disabled="busy" @click="$emit('confirm')">{{ busy ? '处理中…' : confirmLabel }}</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '确认当前操作？' },
  description: { type: String, default: '' },
  impact: { type: Object, default: () => ({}) },
  confirmLabel: { type: String, default: '确认继续' },
  cancelLabel: { type: String, default: '取消' },
  tone: { type: String, default: 'warning' },
  busy: { type: Boolean, default: false },
})

defineEmits(['confirm', 'cancel'])
const dialog = ref(null)
let returnFocus = null
watch(() => props.open, async (open) => {
  if (!open) {
    await nextTick()
    if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus()
    returnFocus = null
    return
  }
  returnFocus = document.activeElement
  await nextTick()
  dialog.value?.focus()
})
</script>

<style scoped>
.impact-layer { --line: #3a3932; --text: #eee8dc; --muted: #aaa397; --dim: #777166; --accent: #d5a954; position: fixed; inset: 0; z-index: 2500; display: grid; place-items: center; padding: 24px; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.impact-backdrop { position: absolute; inset: 0; width: 100%; border: 0; background: rgb(7 8 7 / 72%); backdrop-filter: blur(6px); }
.impact-dialog { position: relative; width: min(520px, 94vw); outline: 0; border: 1px solid var(--line); background: #1a1b18; box-shadow: 0 30px 90px rgb(0 0 0 / 46%); color: var(--text); }
header { padding: 26px 28px 20px; }
header span { color: var(--accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .18em; }
h2 { margin: 7px 0 8px; font: 500 22px Georgia, serif; letter-spacing: -.02em; }
header p { margin: 0; color: var(--muted); font-size: var(--paper-fs-sm); line-height: 1.65; }
dl { margin: 0; border-top: 1px solid var(--line); }
dl div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 16px; padding: 13px 28px; border-bottom: 1px solid #2d2e2a; }
dt { color: var(--dim); font-size: var(--paper-fs-xs); font-weight: 700; letter-spacing: .12em; }
dd { margin: 0; color: var(--muted); font-size: var(--paper-fs-sm); line-height: 1.55; }
dl .cost dd { color: var(--accent); }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 18px 28px 22px; }
footer button { min-width: 100px; padding: 10px 14px; border-radius: 2px; font-size: var(--paper-fs-sm); font-weight: 800; cursor: pointer; }
.cancel { border: 1px solid var(--line); background: transparent; color: var(--muted); }
.confirm { border: 0; background: var(--accent); color: #211c13; }
.confirm.danger { background: #b96555; color: #fff3ef; }
footer button:disabled { opacity: .42; cursor: wait; }
.paper-impact-enter-active, .paper-impact-leave-active { transition: opacity .16s ease; }
.paper-impact-enter-active .impact-dialog, .paper-impact-leave-active .impact-dialog { transition: transform .18s ease, opacity .18s ease; }
.paper-impact-enter-from, .paper-impact-leave-to { opacity: 0; }
.paper-impact-enter-from .impact-dialog, .paper-impact-leave-to .impact-dialog { opacity: 0; transform: translateY(10px) scale(.985); }
@media (prefers-reduced-motion: reduce) { .paper-impact-enter-active, .paper-impact-leave-active, .paper-impact-enter-active .impact-dialog, .paper-impact-leave-active .impact-dialog { transition: none; } }
</style>
