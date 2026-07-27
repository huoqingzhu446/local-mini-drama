import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPaperRestoreLabel,
  hasExplicitPaperRoute,
  loadPaperStudioContext,
  normalizePaperStudioContext,
  paperStudioContextKey,
  savePaperStudioContext,
} from '../src/utils/paperStudioExperience.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

test('paper studio context persists only valid ids and a known stage', () => {
  const storage = memoryStorage()
  const saved = savePaperStudioContext(storage, 3, {
    paper_episode_id: '5', paper_storyboard_id: 9, run_id: -1, shot_id: 'bad', stage: 'delivery',
  })
  assert.equal(saved.paper_episode_id, 5)
  assert.equal(saved.paper_storyboard_id, 9)
  assert.equal(saved.run_id, null)
  assert.equal(loadPaperStudioContext(storage, 3).stage, 'delivery')
  assert.match(storage.getItem(paperStudioContextKey(3)), /"version":1/)
})

test('invalid or corrupt persisted context is ignored safely', () => {
  const storage = memoryStorage()
  storage.setItem(paperStudioContextKey(3), '{bad json')
  assert.equal(loadPaperStudioContext(storage, 3), null)
  assert.equal(normalizePaperStudioContext({ stage: 'unknown' }).stage, 'authoring')
})

test('route context wins detection and recovery summary stays operational', () => {
  assert.equal(hasExplicitPaperRoute({}), false)
  assert.equal(hasExplicitPaperRoute({ run: '12' }), true)
  const label = buildPaperRestoreLabel({ run_id: 12, shot_id: 21, stage: 'production' }, {
    episodeTitle: '体验闭环验收分集', runLabel: 'R03', shotLabel: '分镜 01',
  })
  assert.equal(label, '体验闭环验收分集 · R03 · 分镜 01 · 正式制作')
})
