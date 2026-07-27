<template>
  <header class="studio-header">
    <button class="back-button" type="button" @click="$emit('back')">←</button>
    <div class="identity">
      <div class="eyebrow">PAPER STUDIO · INDEPENDENT MODE</div>
      <div class="title-row">
        <h1>纸片动画工作室</h1>
        <span class="project-name">{{ drama?.title || '未命名项目' }}</span>
      </div>
    </div>
    <div class="header-status">
      <span class="status-dot" :class="doctor?.ok ? 'is-ok' : 'is-warning'"></span>
      <span>{{ doctor?.ok ? '基础环境就绪' : '环境需要处理' }}</span>
      <span class="schema-label">Schema {{ project?.schema_version || 3 }}</span>
    </div>
    <div class="header-actions">
      <div class="task-entries" aria-label="项目任务">
        <button type="button" @click="$emit('tasks', 'attention')"><span>任务</span><i>{{ taskCenter?.summary?.total || 0 }}</i></button>
        <button type="button" :class="{ urgent: waitingCount > 0 }" @click="$emit('tasks', 'attention')"><span>等待你</span><i>{{ waitingCount }}</i></button>
        <button type="button" @click="$emit('tasks', 'costs')"><span>图片调用</span><i>{{ taskCenter?.costs?.generated_versions || 0 }}</i></button>
      </div>
      <button type="button" class="quiet-action" @click="$emit('legacy')">旧工作台（可选）</button>
      <button type="button" class="quiet-action" :disabled="busy" @click="$emit('refresh')">刷新</button>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  drama: { type: Object, default: null },
  project: { type: Object, default: null },
  doctor: { type: Object, default: null },
  taskCenter: { type: Object, default: null },
  busy: { type: Boolean, default: false },
})

defineEmits(['back', 'legacy', 'refresh', 'tasks'])
const waitingCount = computed(() => Number(props.taskCenter?.summary?.attention || 0) + Number(props.taskCenter?.summary?.failed || 0))
</script>

<style scoped>
.studio-header {
  height: 72px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 24px;
  border-bottom: 1px solid var(--paper-line);
  background: color-mix(in srgb, var(--paper-shell) 94%, transparent);
  backdrop-filter: blur(16px);
}
.back-button {
  width: 34px;
  height: 34px;
  border: 1px solid var(--paper-line);
  border-radius: 50%;
  background: transparent;
  color: var(--paper-text);
  font-size: var(--paper-fs-xl);
  cursor: pointer;
  transition: border-color .16s ease, transform .16s ease;
}
.back-button:hover { border-color: var(--paper-accent); transform: translateX(-2px); }
.identity { min-width: 270px; }
.eyebrow { color: var(--paper-accent); font-size: var(--paper-fs-sm); letter-spacing: .18em; font-weight: 700; }
.title-row { display: flex; align-items: baseline; gap: 12px; margin-top: 3px; }
h1 { margin: 0; color: var(--paper-text); font-size: var(--paper-fs-xl); letter-spacing: -.02em; }
.project-name { color: var(--paper-muted); font-size: var(--paper-fs-base); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-status { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--paper-muted); font-size: var(--paper-fs-base); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #cf6657; }
.status-dot.is-ok { background: #7ea27c; box-shadow: 0 0 0 4px rgb(126 162 124 / 10%); }
.schema-label { margin-left: 6px; padding-left: 12px; border-left: 1px solid var(--paper-line); }
.header-actions { display: flex; gap: 8px; }
.task-entries { display: flex; align-items: center; border-right: 1px solid var(--paper-line); padding-right: 8px; }
.task-entries button { display: flex; align-items: center; gap: 5px; padding: 8px 7px; border: 0; background: transparent; color: var(--paper-dim); font-size: var(--paper-fs-xs); cursor: pointer; }
.task-entries button:hover { background: var(--paper-hover); color: var(--paper-text); }
.task-entries i { min-width: 15px; color: var(--paper-muted); font: 700 var(--paper-fs-xs) ui-monospace, monospace; font-style: normal; text-align: center; }
.task-entries button.urgent i { color: var(--paper-accent); }
.quiet-action { border: 0; background: transparent; color: var(--paper-muted); padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.quiet-action:hover:not(:disabled) { color: var(--paper-text); background: var(--paper-hover); }
.quiet-action:disabled { opacity: .45; cursor: wait; }
@media (max-width: 900px) {
  .header-status, .project-name { display: none; }
  .studio-header { padding: 0 14px; }
  .identity { min-width: 0; }
  .header-actions .quiet-action:first-child { display: none; }
  .task-entries button span { display: none; }
}
</style>
