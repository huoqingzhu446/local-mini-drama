import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildTransitionGateRecovery,
  isTransitionGateError,
} from '../src/utils/paperStudioRecovery.js'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

test('transition gate recovery turns backend failures into concrete editing advice', () => {
  const recovery = buildTransitionGateRecovery({
    code: 'PAPER_STUDIO_TRANSITION_GATE_FAILED',
    details: {
      recovery_context: { shot_id: 13, paper_storyboard_id: 9, shot_number: 3, title: '巨鹿危城' },
      failures: [
        { key: 'transition:city_to_wall:duration', message: '城内到城墙转场只有 0.1 秒' },
        { key: 'event_density', message: '同一帧出现 3 个主要事件' },
      ],
    },
  })

  assert.equal(recovery.context.paper_storyboard_id, 9)
  assert.equal(recovery.context.title, '巨鹿危城')
  assert.equal(recovery.focusField, 'duration')
  assert.match(recovery.summary, /2 项连续性问题/)
  assert.match(recovery.failures[0].advice, /延长分镜时长/)
  assert.match(recovery.failures[1].advice, /错开场景切换/)
})

test('transition recovery remains actionable when an older backend omits detailed failures', () => {
  const recovery = buildTransitionGateRecovery(
    { code: 'PAPER_STUDIO_TRANSITION_GATE_FAILED', details: {} },
    { paper_storyboard_id: 17, shot_number: 4, title: '城门' },
  )
  assert.equal(recovery.context.paper_storyboard_id, 17)
  assert.equal(recovery.visibleFailures.length, 1)
  assert.match(recovery.visibleFailures[0].advice, /简化同一分镜/)
  assert.equal(buildTransitionGateRecovery({ code: 'OTHER_ERROR' }), null)
  assert.equal(isTransitionGateError({ apiCode: 'PAPER_STUDIO_TRANSITION_GATE_FAILED' }), true)
})

test('paper studio exposes a solution action instead of treating continuity failures as reload errors', () => {
  const view = readFileSync(join(srcRoot, 'views', 'PaperStudio.vue'), 'utf8')
  const request = readFileSync(join(srcRoot, 'utils', 'request.js'), 'utf8')
  assert.match(view, /查看解决方案/)
  assert.match(view, /预览零调用修复/)
  assert.match(view, /查看全部历史图片/)
  assert.match(view, /旧计划和所有历史图片都会保留/)
  assert.match(view, /preview\.repairability/)
  assert.match(view, /buildTransitionGateRecovery/)
  assert.match(request, /PAPER_STUDIO_TRANSITION_GATE_FAILED/)
  assert.match(request, /PAPER_STUDIO_CONTINUITY_REPAIR_RENDER_ACTIVE/)
})
