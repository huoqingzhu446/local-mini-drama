import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findBestUnpublishedRun,
  isEnvironmentProductionShot,
  paperProductionActionDescription,
  paperProductionActionLabel,
  unpublishedRunResumeLabel,
} from '../src/utils/paperStudioProduction.js'
import {
  paperAssetPurposeLabel,
  paperAssetSlotLabel,
  paperAssetStateLabel,
  paperAssetTypeLabel,
} from '../src/utils/paperAssetLabels.js'
import {
  isEditablePaperBlueprint,
  paperBlueprintCompatibility,
} from '../src/utils/paperBlueprintCompatibility.js'
import {
  audioStatusLabel,
  episodeStatusLabel,
  mergeStatusLabel,
  shotStatusLabel,
  storyboardStatusLabel,
} from '../src/utils/paperStudioLabels.js'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

test('environment production uses concrete user-facing step names', () => {
  const shot = {
    storyboard: { environment_only: true },
    next_action: { type: 'plan_motion', label: '规划主体动作' },
    last_error_json: {},
  }
  assert.equal(isEnvironmentProductionShot(shot), true)
  assert.equal(paperProductionActionLabel(shot), '生成环境动态')
  assert.match(paperProductionActionDescription(shot), /环境氛围漂移、空气流动和轻微运镜/)
})

test('legacy missing environment state offers an automatic zero-cost recovery action', () => {
  const shot = {
    plan_summary_json: { environment_only: true },
    next_action: { type: 'revise_motion', label: '修订动作计划' },
    last_error_json: { code: 'PAPER_STUDIO_STATE_ASSET_MISSING' },
  }
  assert.equal(paperProductionActionLabel(shot), '自动补齐环境过渡并继续')
  assert.match(paperProductionActionDescription(shot), /不会再次调用图片 API/)
})

test('non-environment production preserves the backend action label', () => {
  const shot = {
    storyboard: { environment_only: false },
    next_action: { type: 'plan_motion', label: '规划主体动作' },
  }
  assert.equal(paperProductionActionLabel(shot, '规划主体动作'), '规划主体动作')
  assert.equal(paperProductionActionDescription(shot, '原说明'), '原说明')
})

test('unfinished production resumes the most advanced matching version instead of creating an empty duplicate', () => {
  const selection = { paper_storyboard_ids: [17], paper_storyboard_revision_ids: [48] }
  const runs = [
    { id: 25, run_number: 12, paper_episode_id: 8, status: 'preview_ready', progress: 78, selection_json: selection, updated_at: '2026-07-31T10:04:21.723Z' },
    { id: 26, run_number: 13, paper_episode_id: 8, status: 'draft', progress: 0, selection_json: selection, updated_at: '2026-07-31T10:07:25.024Z' },
    { id: 27, run_number: 14, paper_episode_id: 8, status: 'draft', progress: 0, selection_json: selection, updated_at: '2026-07-31T10:07:59.874Z' },
  ]
  const recovered = findBestUnpublishedRun(runs, { paperEpisodeId: 8, storyboardIds: [17], revisionIds: [48] })
  assert.equal(recovered.id, 25)
  assert.equal(unpublishedRunResumeLabel(recovered), '预览视频已生成，等待批准')
  assert.equal(findBestUnpublishedRun(runs, { paperEpisodeId: 8, storyboardIds: [17], revisionIds: [49] }), null)

  const view = readFileSync(join(srcRoot, 'views', 'PaperStudio.vue'), 'utf8')
  assert.match(view, /继续未发布版本/)
  assert.match(view, /刷新不会删除/)
  assert.match(view, /已恢复未发布版本/)
})

test('asset review labels identify the actual subject, state, type and purpose', () => {
  const slot = {
    slot_key: 'subject_start',
    asset_type: 'character-cutout',
    generation_purpose: 'map_character_marker',
    constraints_json: { identity: '王离', state: 'map_marker' },
  }
  assert.equal(paperAssetSlotLabel(slot), '王离 · 平面标记剪影')
  assert.equal(paperAssetStateLabel('map_marker'), '平面标记剪影')
  assert.equal(paperAssetTypeLabel(slot), '角色透明层')
  assert.equal(paperAssetPurposeLabel(slot), '生成在平面底图上显现的主体标记')
  assert.equal(paperAssetSlotLabel({ slot_key: 'clean_plate', asset_type: 'environment', constraints_json: { label: '干净战役地图底图' } }), '干净战役地图底图')
})

test('blueprint editor exposes entity evidence and ground-contact safeguards without blocking legacy evidence gaps', () => {
  const component = readFileSync(join(srcRoot, 'components', 'paper-studio', 'PaperBlueprintEditor.vue'), 'utf8')
  assert.match(component, /剧本证据/)
  assert.match(component, /落地区域/)
  assert.match(component, /大型接地道具（车辆、推车、大型器物等）不能设置为手持关系/)
  assert.match(component, /function bindingWarning/)
  assert.match(component, /if \(!evidence \|\| !name\) return false/)
})

test('paper studio status labels remain centralized without conflating status domains', () => {
  assert.equal(shotStatusLabel('plan_confirmed'), '计划已确认，等待生成授权')
  assert.equal(shotStatusLabel('plan_confirmed', { compact: true }), '计划确认')
  assert.equal(storyboardStatusLabel('ready'), '参考图就绪')
  assert.equal(episodeStatusLabel('merging'), '合并中')
  assert.equal(audioStatusLabel('superseded'), '历史版本')
  assert.equal(mergeStatusLabel('stale'), '分镜已更新，需要重新合并')
})

test('recovered legacy blueprints remain viewable without entering the current editor contract', () => {
  const recovered = {
    schema_version: 1,
    recovered: true,
    planner_version: 5,
    visual_scenes: [],
    transition: {},
    asset_families: [],
  }
  const compatibility = paperBlueprintCompatibility(recovered)
  assert.equal(compatibility.editable, false)
  assert.equal(compatibility.recovered, true)
  assert.deepEqual(compatibility.missing, ['entities', 'relations', 'generation_slots', 'action_contract'])

  const current = {
    entities: [{ key: 'actor_1', name: '守城士兵', states: ['standing'] }],
    relations: [],
    generation_slots: [{ slot_key: 'subject_start' }],
    action_contract: { waypoints: [], phases: [] },
  }
  assert.equal(isEditablePaperBlueprint(current), true)

  const component = readFileSync(join(srcRoot, 'components', 'paper-studio', 'PaperBlueprintEditor.vue'), 'utf8')
  assert.match(component, /blueprintCompatibility\.editable/)
  assert.match(component, /恢复版蓝图仅供查看/)
  assert.match(component, /不会在进入页面时调用图片 API/)
})

test('scene continuity UI exposes scene groups, background cost mode and five-phase transition evidence', () => {
  const blueprint = readFileSync(join(srcRoot, 'components', 'paper-studio', 'PaperBlueprintEditor.vue'), 'utf8')
  const evidence = readFileSync(join(srcRoot, 'components', 'paper-studio', 'PaperMotionEvidencePanel.vue'), 'utf8')
  assert.match(blueprint, /场景与转场时间轴/)
  assert.match(blueprint, /正确模式：独立新背景/)
  assert.match(blueprint, /零调用模式：同地点虚拟机位/)
  assert.match(blueprint, /只看这个转场/)
  assert.match(evidence, /当前只显示.*五阶段证据/)
  assert.match(evidence, /亮度跳变/)
  assert.match(evidence, /transition_visual_change/)
  assert.match(evidence, /pre: '前'/)
  assert.match(evidence, /post: '后'/)
})

test('environment asset review compares the selected composition reference with the formal material and blocks missing evidence', () => {
  const component = readFileSync(join(srcRoot, 'components', 'paper-studio', 'PaperAssetReviewWorkbench.vue'), 'utf8')
  const view = readFileSync(join(srcRoot, 'views', 'PaperStudio.vue'), 'utf8')
  assert.match(component, /构图参考/)
  assert.match(component, /正式素材/)
  assert.match(component, /构图 · 时代 · 天气 · 损毁 · 色调 · 媒介/)
  assert.match(component, /referenceGatePassed/)
  assert.match(component, /这版素材不能批准/)
  assert.match(component, /只重新生成这一张/)
  assert.match(component, /重新生成已排队/)
  assert.match(component, /generationActive/)
  assert.match(component, /authorized_slot_ids/)
  assert.match(component, /退回这版错误素材/)
  assert.match(component, /内容主体/)
  assert.match(component, /状态\/阶段/)
  assert.match(component, /内部槽位/)
  assert.match(view, /authorizeAndStartGeneration\(quote\)/)
  assert.match(view, /regeneratingSlotId/)
  assert.match(view, /重新生成任务已排队/)
  assert.match(view, /currentActionQueueState/)
  assert.match(view, /已排队，等待后台执行/)
  assert.match(view, /正式素材未携带已选构图参考/)
})
