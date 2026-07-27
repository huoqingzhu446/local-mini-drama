<template>
  <Teleport to="body">
    <Transition name="paper-task-drawer">
      <div v-if="open" class="task-center-layer" @keydown.esc="$emit('close')">
        <button class="drawer-backdrop" type="button" aria-label="关闭任务中心" @click="$emit('close')"></button>
        <aside ref="drawer" class="task-center" role="dialog" aria-modal="true" aria-labelledby="paper-task-title" tabindex="-1">
          <header>
            <div>
              <span>PROJECT TASKS</span>
              <h2 id="paper-task-title">任务与调用</h2>
            </div>
            <div class="drawer-actions">
              <button type="button" :disabled="loading" @click="$emit('refresh')">{{ loading ? '更新中' : '更新' }}</button>
              <button type="button" aria-label="关闭任务中心" @click="$emit('close')">×</button>
            </div>
          </header>

          <section v-if="restoreLabel" class="restore-summary">
            <span>已恢复上次位置</span>
            <strong>{{ restoreLabel }}</strong>
            <button type="button" @click="$emit('dismiss-restore')">知道了</button>
          </section>

          <section v-if="onboarding.length" class="onboarding">
            <div class="section-heading">
              <span>首次制作清单</span>
              <i>{{ onboarding.filter((item) => item.done).length }}/{{ onboarding.length }}</i>
            </div>
            <ol>
              <li v-for="item in onboarding" :key="item.key" :class="{ done: item.done }">
                <span>{{ item.done ? '✓' : onboarding.indexOf(item) + 1 }}</span>
                <div><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></div>
              </li>
            </ol>
            <div v-if="canCreateExample" class="example-draft">
              <div>
                <strong>还没有内容？从四镜草稿开始</strong>
                <small>只写入一个通用示例分集和 4 个可编辑分镜，不创建生产版本，也不调用图片 API。</small>
              </div>
              <button type="button" :disabled="exampleBusy" @click="$emit('create-example')">
                {{ exampleBusy ? '正在复制…' : '复制示例草稿' }}
              </button>
            </div>
          </section>

          <nav class="task-sections" aria-label="任务分类">
            <button
              v-for="item in sections"
              :key="item.key"
              type="button"
              :class="{ active: section === item.key }"
              @click="$emit('update:section', item.key)"
            >
              <span>{{ item.label }}</span>
              <i>{{ item.count }}</i>
            </button>
          </nav>

          <section v-if="section === 'costs'" class="costs-panel">
            <div class="cost-ledger">
              <div><span>授权最多调用</span><strong>{{ center?.costs?.max_authorized_calls || 0 }}</strong><small>次</small></div>
              <div><span>剩余授权</span><strong>{{ center?.costs?.remaining_authorized_calls || 0 }}</strong><small>次</small></div>
              <div><span>API 实际返回</span><strong>{{ center?.costs?.generated_versions || 0 }}</strong><small>个版本</small></div>
              <div><span>审核接受</span><strong>{{ center?.costs?.accepted_versions || 0 }}</strong><small>个版本</small></div>
              <div><span>失败／退回</span><strong>{{ center?.costs?.failed_versions || 0 }}</strong><small>个版本</small></div>
              <div><span>当前采用</span><strong>{{ center?.costs?.adopted_versions || 0 }}</strong><small>个版本</small></div>
            </div>
            <p>已执行授权预计 {{ center?.costs?.estimated_calls || 0 }} 张；未采用 {{ center?.costs?.unused_versions || 0 }} 个版本。本地上传、Mask 修正和重新抠图不计入图片 API 返回数。</p>
            <div v-if="center?.costs?.slot_usage?.length" class="slot-usage">
              <div class="section-heading"><span>槽位调用明细</span><i>{{ center.costs.slot_usage.length }}</i></div>
              <button v-for="slot in center.costs.slot_usage" :key="slot.slot_id" type="button" @click="$emit('navigate', slot)">
                <span class="slot-kind">{{ assetTypeLabel(slot.asset_type) }}</span>
                <span><strong>{{ slot.storyboard_title || slotLabel(slot.slot_key) }}</strong><small>{{ slot.episode_title }} · {{ slotLabel(slot.slot_key) }}</small></span>
                <span class="slot-numbers">返回 {{ slot.generated_versions }} · 采用 {{ slot.adopted_versions }}</span>
              </button>
            </div>
            <div v-if="center?.costs?.authorizations?.length" class="authorization-list">
              <div class="section-heading"><span>授权记录</span><i>{{ center.costs.authorizations.length }}</i></div>
              <article v-for="authorization in center.costs.authorizations" :key="authorization.id">
                <div>
                  <strong>{{ authorization.provider || '未记录服务商' }} · {{ authorization.model || '默认模型' }}</strong>
                  <small>R{{ String(authorization.run_id).padStart(2, '0') }} · {{ authorization.status }}</small>
                </div>
                <span>{{ authorization.estimated_image_count }} 张 · 最多 {{ authorization.estimated_image_count * Math.max(1, authorization.max_attempts || 1) }} 次</span>
              </article>
            </div>
            <div v-else class="empty-state"><strong>还没有图片授权</strong><span>确认蓝图不会产生图片调用。</span></div>
          </section>

          <section v-else class="task-list">
            <article v-for="task in activeTasks" :key="task.id" class="task-item">
              <button class="task-target" type="button" @click="$emit('navigate', task)">
                <span class="task-index">{{ String(task.shot_number || 0).padStart(2, '0') }}</span>
                <span class="task-copy">
                  <strong>{{ task.title }}</strong>
                  <small>{{ task.episode_title }} · {{ task.run_id ? `R${String(task.run_number).padStart(2, '0')}` : '尚未创建生产版本' }}</small>
                  <em>{{ task.label }}</em>
                </span>
                <span class="task-arrow">→</span>
              </button>
              <div class="task-facts">
                <span v-if="task.required_asset_count">素材 {{ task.ready_asset_count }}/{{ task.required_asset_count }}</span>
                <span v-if="task.active_slot">当前：{{ activeSlotLabel(task.active_slot) }}</span>
                <span>图片调用 {{ task.image_api_call_count || 0 }}</span>
                <time v-if="task.updated_at">更新于 {{ formatTime(task.updated_at) }}</time>
              </div>
              <p v-if="task.missing_fields?.length" class="task-note">还缺：{{ missingFieldLabel(task.missing_fields) }}</p>
              <p v-else-if="task.last_event" class="task-note" :class="task.last_event.severity">
                {{ task.last_event.title }}：{{ task.last_event.message }}
              </p>
              <div class="task-actions">
                <button type="button" class="handle-action" @click="$emit('navigate', task)">{{ task.next_action?.label || '去处理' }}</button>
                <button v-if="task.controls?.can_pause" type="button" @click="$emit('control', task, 'pause')">暂停</button>
                <button v-if="task.controls?.can_resume" type="button" @click="$emit('control', task, 'resume')">恢复</button>
                <button v-if="task.controls?.can_cancel" type="button" class="cancel-action" @click="$emit('control', task, 'cancel')">取消版本</button>
              </div>
            </article>
            <div v-if="!activeTasks.length" class="empty-state">
              <strong>{{ emptyCopy.title }}</strong>
              <span>{{ emptyCopy.detail }}</span>
            </div>
          </section>

          <footer>
            <span>数据只保存在本机项目数据库中</span>
            <time v-if="center?.updated_at">{{ new Date(center.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</time>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  center: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  section: { type: String, default: 'attention' },
  onboarding: { type: Array, default: () => [] },
  restoreLabel: { type: String, default: '' },
  canCreateExample: { type: Boolean, default: false },
  exampleBusy: { type: Boolean, default: false },
})

defineEmits(['close', 'refresh', 'navigate', 'control', 'create-example', 'dismiss-restore', 'update:section'])

const drawer = ref(null)
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
  drawer.value?.focus()
})

function assetTypeLabel(value) {
  return ({
    clean_plate: '干净背景', environment: '干净背景', actor: '角色层',
    'character-cutout': '角色层', 'subject-cutout': '主体层', prop: '道具层',
    'prop-cutout': '道具层', 'effect-cutout': '效果层', occlusion: '遮挡层',
    'occluder-cutout': '前景遮挡层', 'occlusion-mask': '遮挡 Mask', shadow: '阴影层',
  })[value] || value || '素材'
}

function slotLabel(value) {
  const key = String(value || '')
  if (key === 'clean_plate') return '干净背景'
  if (/actor|subject/.test(key)) return '主体状态'
  if (/prop|impact|support|boat_body/.test(key)) return '道具状态'
  if (/occlud|mask|rail/.test(key)) return '前景遮挡'
  if (/effect|splash/.test(key)) return '效果层'
  return key || '待处理素材'
}

function activeSlotLabel(slot = {}) {
  const type = assetTypeLabel(slot.asset_type)
  const name = slotLabel(slot.slot_key)
  return type === name ? type : `${type} · ${name}`
}

function missingFieldLabel(fields = []) {
  const labels = { title: '标题', description: '画面描述', action: '主体动作' }
  return fields.map((field) => labels[field] || field).join('、')
}

function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const sections = computed(() => [
  { key: 'attention', label: '等待你', count: props.center?.summary?.attention || 0 },
  { key: 'processing', label: '处理中', count: props.center?.summary?.processing || 0 },
  { key: 'failed', label: '失败', count: props.center?.summary?.failed || 0 },
  { key: 'completed', label: '完成', count: props.center?.summary?.completed || 0 },
  { key: 'costs', label: '图片调用', count: props.center?.costs?.generated_versions || 0 },
])

const activeTasks = computed(() => props.center?.groups?.[props.section] || [])
const emptyCopy = computed(() => ({
  attention: { title: '没有等待你的任务', detail: '可以继续当前分镜，系统不会制造额外提醒。' },
  processing: { title: '当前没有后台任务', detail: '开始生成或渲染后会在这里持续更新。' },
  failed: { title: '没有失败任务', detail: '动态门禁和正式渲染目前没有待处理失败。' },
  completed: { title: '还没有已发布分镜', detail: '正式发布后会保留在这里供快速返回。' },
}[props.section] || { title: '暂无内容', detail: '' }))
</script>

<style scoped>
.task-center-layer { --bg: #171816; --panel: #1d1e1b; --line: #34342f; --line-soft: #2a2b28; --text: #eee8dc; --muted: #aaa397; --dim: #6f6b63; --accent: #d5a954; position: fixed; inset: 0; z-index: 2400; }
.drawer-backdrop { position: absolute; inset: 0; width: 100%; border: 0; background: rgb(7 8 7 / 54%); backdrop-filter: blur(3px); cursor: default; }
.task-center { position: absolute; top: 0; right: 0; bottom: 0; width: min(460px, 94vw); overflow-y: auto; outline: 0; border-left: 1px solid var(--line); background: var(--bg); box-shadow: -30px 0 70px rgb(0 0 0 / 34%); color: var(--text); font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.task-center > header { position: sticky; top: 0; z-index: 2; min-height: 76px; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; border-bottom: 1px solid var(--line); background: rgb(23 24 22 / 94%); backdrop-filter: blur(14px); }
header span { color: var(--accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .18em; }
h2 { margin: 4px 0 0; font-size: var(--paper-fs-xl); letter-spacing: -.02em; }
.drawer-actions { display: flex; gap: 4px; }
.drawer-actions button { min-width: 34px; height: 34px; padding: 0 9px; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.drawer-actions button:last-child { font-size: var(--paper-fs-display); font-weight: 200; }
.drawer-actions button:hover { background: #242522; color: var(--text); }
.restore-summary { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 15px 88px 15px 22px; border-bottom: 1px solid #4e422a; background: #25231d; }
.restore-summary span { color: var(--accent); font-size: var(--paper-fs-xs); font-weight: 700; letter-spacing: .08em; }
.restore-summary strong { font-size: var(--paper-fs-sm); font-weight: 500; line-height: 1.5; }
.restore-summary button { position: absolute; top: 18px; right: 20px; border: 0; background: transparent; color: var(--muted); font-size: var(--paper-fs-xs); cursor: pointer; }
.onboarding { padding: 19px 22px 17px; border-bottom: 1px solid var(--line); }
.section-heading { display: flex; justify-content: space-between; margin-bottom: 13px; color: var(--dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .1em; }
.section-heading i { color: var(--muted); font-style: normal; }
.onboarding ol { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
.onboarding li { display: grid; grid-template-columns: 23px 1fr; gap: 10px; align-items: start; color: var(--muted); }
.onboarding li > span { width: 21px; height: 21px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 50%; color: var(--dim); font: 700 var(--paper-fs-xs) ui-monospace, monospace; }
.onboarding li.done > span { border-color: #52664f; color: #8dad88; }
.onboarding li div { display: flex; flex-direction: column; gap: 2px; }
.onboarding strong { color: var(--text); font-size: var(--paper-fs-sm); }
.onboarding small { color: var(--dim); font-size: var(--paper-fs-xs); line-height: 1.45; }
.example-draft { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line-soft); }
.example-draft div { display: flex; flex-direction: column; gap: 4px; }
.example-draft strong { font-size: var(--paper-fs-sm); }
.example-draft button { padding: 9px 11px; border: 1px solid #5b4c2f; background: #29251c; color: var(--accent); font-size: var(--paper-fs-xs); cursor: pointer; }
.example-draft button:disabled { opacity: .45; cursor: wait; }
.task-sections { position: sticky; top: 76px; z-index: 1; display: grid; grid-template-columns: repeat(5, 1fr); border-bottom: 1px solid var(--line); background: rgb(23 24 22 / 96%); }
.task-sections button { position: relative; min-width: 0; padding: 13px 4px 11px; border: 0; background: transparent; color: var(--dim); font-size: var(--paper-fs-xs); cursor: pointer; }
.task-sections button::after { content: ''; position: absolute; right: 10px; bottom: -1px; left: 10px; height: 2px; background: transparent; }
.task-sections button.active { color: var(--text); }
.task-sections button.active::after { background: var(--accent); }
.task-sections i { display: inline-block; min-width: 15px; margin-left: 3px; color: var(--accent); font-style: normal; }
.task-list { min-height: 260px; }
.task-item { padding: 13px 22px 15px; border-bottom: 1px solid var(--line-soft); }
.task-target { width: 100%; display: grid; grid-template-columns: 30px minmax(0, 1fr) 18px; gap: 11px; align-items: center; padding: 3px 0 7px; border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.task-target:hover .task-copy strong { color: var(--accent); }
.task-index { color: var(--accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; }
.task-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.task-copy strong { overflow: hidden; font-size: var(--paper-fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.task-copy small { color: var(--dim); font-size: var(--paper-fs-xs); }
.task-copy em { color: var(--muted); font-size: var(--paper-fs-xs); font-style: normal; }
.task-arrow { color: var(--dim); font-size: var(--paper-fs-lg); transition: color .14s ease, transform .14s ease; }
.task-target:hover .task-arrow { color: var(--accent); transform: translateX(2px); }
.task-facts { display: flex; flex-wrap: wrap; gap: 5px 12px; margin: 5px 0 0 41px; color: var(--dim); font-size: var(--paper-fs-xs); }
.task-note { margin: 8px 0 0 41px; padding-left: 8px; border-left: 2px solid #57534a; color: var(--muted); font-size: var(--paper-fs-xs); line-height: 1.5; }
.task-note.error { border-left-color: #b96555; }
.task-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0 41px; }
.task-actions button { padding: 7px 9px; border: 1px solid var(--line); background: transparent; color: var(--muted); font-size: var(--paper-fs-xs); cursor: pointer; }
.task-actions button:hover { border-color: #56564f; color: var(--text); }
.task-actions .handle-action { border-color: #5b4c2f; color: var(--accent); }
.task-actions .cancel-action { color: #c98274; }
.empty-state { min-height: 220px; display: grid; place-content: center; gap: 5px; padding: 26px; color: var(--dim); text-align: center; }
.empty-state strong { color: var(--muted); font: 500 15px Georgia, serif; }
.empty-state span { font-size: var(--paper-fs-xs); }
.costs-panel { padding: 0 22px 26px; }
.cost-ledger { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--line); }
.cost-ledger div { display: flex; flex-direction: column; gap: 3px; padding: 17px 10px 14px 0; border-bottom: 1px solid var(--line-soft); }
.cost-ledger span, .cost-ledger small { color: var(--dim); font-size: var(--paper-fs-xs); }
.cost-ledger strong { color: var(--text); font: 500 25px Georgia, serif; }
.costs-panel > p { margin: 13px 0 19px; color: var(--dim); font-size: var(--paper-fs-xs); line-height: 1.6; }
.slot-usage { margin-bottom: 20px; }
.slot-usage button { width: 100%; display: grid; grid-template-columns: 62px minmax(0, 1fr) auto; gap: 9px; align-items: center; padding: 11px 0; border: 0; border-top: 1px solid var(--line-soft); background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.slot-usage button:hover strong { color: var(--accent); }
.slot-usage button > span:nth-child(2) { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.slot-usage strong, .slot-usage small { overflow: hidden; font-size: var(--paper-fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.slot-usage small, .slot-kind, .slot-numbers { color: var(--dim); }
.slot-kind, .slot-numbers { font-size: var(--paper-fs-xs); }
.authorization-list article { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 0; border-top: 1px solid var(--line-soft); }
.authorization-list article div { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.authorization-list strong { overflow: hidden; font-size: var(--paper-fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.authorization-list small { color: var(--dim); font-size: var(--paper-fs-xs); }
.authorization-list article > span { color: var(--accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; }
footer { display: flex; justify-content: space-between; padding: 13px 22px; border-top: 1px solid var(--line); color: var(--dim); font-size: var(--paper-fs-xs); }
.paper-task-drawer-enter-active, .paper-task-drawer-leave-active { transition: opacity .18s ease; }
.paper-task-drawer-enter-active .task-center, .paper-task-drawer-leave-active .task-center { transition: transform .2s cubic-bezier(.2,.8,.2,1); }
.paper-task-drawer-enter-from, .paper-task-drawer-leave-to { opacity: 0; }
.paper-task-drawer-enter-from .task-center, .paper-task-drawer-leave-to .task-center { transform: translateX(100%); }
@media (prefers-reduced-motion: reduce) { .paper-task-drawer-enter-active, .paper-task-drawer-leave-active, .paper-task-drawer-enter-active .task-center, .paper-task-drawer-leave-active .task-center { transition: none; } }
</style>
