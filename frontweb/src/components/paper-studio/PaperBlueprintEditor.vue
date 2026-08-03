<template>
  <section v-if="blueprintCompatibility.editable" class="blueprint-editor" aria-labelledby="blueprint-title">
    <header class="blueprint-header">
      <div>
        <span>PRODUCTION BLUEPRINT · B{{ String(shot?.blueprint?.revision_number || 1).padStart(2, '0') }}</span>
        <h3 id="blueprint-title">生成前先检查拆层和动作</h3>
        <p>这里的修改会真实重编译素材槽位、图层关系和动作计划，不会只保存一份说明文字。</p>
      </div>
      <div class="blueprint-state" :class="shot?.blueprint?.status">
        {{ shot?.blueprint?.status === 'confirmed' ? '已确认' : dirty ? '有未保存修改' : '待确认' }}
      </div>
    </header>

    <div class="blueprint-impact">
      <strong>修改影响</strong>
      <span>保存会生成新的蓝图版本，并使尚未执行的旧图片生成授权失效；不会删除历史蓝图。</span>
    </div>

    <div class="blueprint-grid">
      <section class="blueprint-panel entity-panel">
        <div class="panel-heading">
          <div><span>01</span><strong>实体与独立层</strong></div>
          <button type="button" :disabled="!editable" @click="addEntity">新增实体</button>
        </div>
        <p class="panel-help">角色、可移动道具应当是独立层；长椅、门框等可作为环境锚点。</p>
        <article v-for="(entity, index) in blueprint.entities" :key="entity.key" class="entity-card">
          <div class="entity-card-title">
            <code>{{ entity.key }}</code>
            <div>
              <button type="button" :disabled="!editable" @click="splitEntity(entity)">拆分副本</button>
              <button type="button" :disabled="!editable || blueprint.entities.length <= 1" class="danger-text" @click="removeEntity(entity.key)">移除</button>
            </div>
          </div>
          <div class="field-grid">
            <label>
              <span>名称</span>
              <input v-model.trim="entity.name" :disabled="!editable" maxlength="120" />
            </label>
            <label>
              <span>类型</span>
              <select v-model="entity.type" :disabled="!editable">
                <option value="character">角色</option>
                <option value="prop">道具</option>
                <option value="environment_anchor">环境锚点</option>
                <option value="effect">效果</option>
              </select>
            </label>
            <label>
              <span>业务角色</span>
              <input v-model.trim="entity.role" :disabled="!editable" maxlength="80" />
            </label>
            <label>
              <span>动作状态（逗号分隔）</span>
              <input :value="entity.states.join(', ')" :disabled="!editable" @change="setStates(entity, $event.target.value)" />
            </label>
          </div>
          <div class="entity-switches">
            <label><input v-model="entity.independent_layer" type="checkbox" :disabled="!editable || entity.type === 'environment_anchor'" />独立图层</label>
            <label><input v-model="entity.reusable" type="checkbox" :disabled="!editable" />跨镜复用</label>
          </div>
          <div v-if="entity.attributes?.source_evidence || entity.source_library_id" class="entity-binding" :class="{ warning: bindingWarning(entity) }">
            <strong>{{ entity.source_library_id ? `实体库 #${entity.source_library_id}` : '匿名/临时实体' }}</strong>
            <span>剧本证据：{{ entity.attributes?.source_evidence || '未提供' }}</span>
          </div>
          <div v-if="entity.attributes?.placement" class="entity-placement">
            接触：{{ entity.attributes.placement.contact_kind || 'base' }} · 落地区域：{{ entity.attributes.placement.region_key || '未指定' }}
          </div>
          <div v-if="blueprint.entities.length > 1" class="merge-row">
            <select v-model="mergeTargetByKey[entity.key]" :disabled="!editable">
              <option value="">选择合并目标</option>
              <option v-for="target in blueprint.entities.filter((item) => item.key !== entity.key)" :key="target.key" :value="target.key">
                {{ target.name }}（{{ target.key }}）
              </option>
            </select>
            <button type="button" :disabled="!editable || !mergeTargetByKey[entity.key]" @click="mergeEntity(entity.key, mergeTargetByKey[entity.key])">合并到目标</button>
          </div>
          <small>实体 {{ index + 1 }} · {{ entity.independent_layer ? '单独生成/上传' : '保留在环境层' }}</small>
        </article>
      </section>

      <section class="blueprint-panel action-panel">
        <div class="panel-heading"><div><span>02</span><strong>动作合同</strong></div></div>
        <p class="panel-help">系统会用这里的阶段和关键点编译动作，并据此生成动态门禁。</p>
        <div class="field-grid contract-fields">
          <label>
            <span>主动作</span>
            <select v-model="blueprint.action_contract.primary_action" :disabled="!editable">
              <option v-for="action in blueprintActions" :key="action.key" :value="action.key" :disabled="action.compatibility_only">
                {{ action.label }}
              </option>
            </select>
          </label>
          <label>
            <span>方向</span>
            <select v-model="blueprint.action_contract.direction" :disabled="!editable">
              <option value="left_to_right">从左到右</option>
              <option value="right_to_left">从右到左</option>
              <option value="forward">向前</option>
              <option value="backward">向后</option>
              <option value="stationary">原地</option>
            </select>
          </label>
          <EntitySelect v-model="blueprint.action_contract.actor_key" label="动作主体" :entities="blueprint.entities" :disabled="!editable" />
          <EntitySelect v-model="blueprint.action_contract.object_key" label="携带/作用对象" :entities="blueprint.entities" :disabled="!editable" allow-empty />
          <EntitySelect v-model="blueprint.action_contract.support_key" label="目标/支撑物" :entities="blueprint.entities" :disabled="!editable" allow-empty />
          <label><span>起始状态</span><input v-model.trim="blueprint.action_contract.start_state" :disabled="!editable" /></label>
          <label><span>结束状态</span><input v-model.trim="blueprint.action_contract.end_state" :disabled="!editable" /></label>
        </div>

        <div class="subsection-heading">
          <strong>位置关键点</strong>
          <button type="button" :disabled="!editable" @click="addWaypoint">新增关键点</button>
        </div>
        <div class="waypoint-list">
          <div v-for="(waypoint, index) in blueprint.action_contract.waypoints" :key="`${waypoint.key}-${index}`" class="waypoint-row">
            <input v-model.trim="waypoint.label" :disabled="!editable" aria-label="关键点名称" />
            <label><span>X</span><input v-model.number="waypoint.x" type="number" min="-1" max="1" step="0.01" :disabled="!editable" /></label>
            <label><span>Y</span><input v-model.number="waypoint.y" type="number" min="-1" max="1" step="0.01" :disabled="!editable" /></label>
            <button type="button" :disabled="!editable || blueprint.action_contract.waypoints.length <= 1" @click="removeWaypoint(index)">移除</button>
          </div>
        </div>

        <div class="subsection-heading">
          <strong>动作阶段</strong>
          <button type="button" :disabled="!editable" @click="addPhase">新增阶段</button>
        </div>
        <div class="phase-list">
          <article v-for="(item, index) in blueprint.action_contract.phases" :key="`${item.key}-${index}`">
            <input v-model.trim="item.label" :disabled="!editable" aria-label="阶段名称" />
            <label><span>开始</span><input v-model.number="item.start_ratio" type="number" min="0" max="1" step="0.01" :disabled="!editable" /></label>
            <label><span>结束</span><input v-model.number="item.end_ratio" type="number" min="0" max="1" step="0.01" :disabled="!editable" /></label>
            <input v-model.trim="item.actor_state" :disabled="!editable" aria-label="角色状态" placeholder="角色状态" />
            <input v-model.trim="item.object_state" :disabled="!editable" aria-label="道具状态" placeholder="道具状态（可空）" />
            <button type="button" :disabled="!editable || blueprint.action_contract.phases.length <= 1" @click="removePhase(index)">移除</button>
          </article>
        </div>
      </section>
    </div>

    <section class="blueprint-panel relation-panel">
      <div class="panel-heading">
        <div><span>03</span><strong>图层与动作关系</strong></div>
        <button type="button" :disabled="!editable" @click="addRelation">新增关系</button>
      </div>
      <p class="panel-help">关系决定谁跟随谁、何时释放，以及谁遮挡谁。</p>
      <div class="relation-list">
        <div v-for="(relation, index) in blueprint.relations" :key="relation.key" class="relation-row">
          <select v-model="relation.subject_key" :disabled="!editable" aria-label="关系主体">
            <option v-for="entity in blueprint.entities" :key="entity.key" :value="entity.key">{{ entity.name }}</option>
          </select>
          <select v-model="relation.predicate" :disabled="!editable" aria-label="关系类型">
            <option v-for="item in predicates" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
          <select v-model="relation.object_key" :disabled="!editable" aria-label="关系对象">
            <option v-for="entity in blueprint.entities" :key="entity.key" :value="entity.key">{{ entity.name }}</option>
          </select>
          <input v-model.trim="relation.start_phase" :disabled="!editable" aria-label="起始阶段" placeholder="起始阶段" />
          <input v-model.trim="relation.end_phase" :disabled="!editable" aria-label="结束阶段" placeholder="结束阶段" />
          <button type="button" :disabled="!editable" @click="blueprint.relations.splice(index, 1)">移除</button>
        </div>
        <p v-if="!blueprint.relations.length" class="empty-row">当前没有关系。涉及手持、支撑或遮挡的动作必须补充关系。</p>
      </div>
    </section>

    <section v-if="visualScenes.length" class="blueprint-panel scene-panel">
      <div class="panel-heading">
        <div><span>04</span><strong>场景与转场时间轴</strong></div>
        <b>{{ visualScenes.length }} 个场景 · {{ transitionContracts.length }} 个转场</b>
      </div>
      <p class="panel-help">地点变化会拆成完整场景组；字幕和声音保持在全局轨道，不跟随背景甩出画面。</p>
      <div class="scene-timeline">
        <template v-for="(scene, index) in visualScenes" :key="scene.key">
          <article class="scene-card">
            <header><span>SCENE {{ index + 1 }}</span><strong>{{ scene.label }}</strong><i>{{ confidenceLabel(scene.confidence) }}</i></header>
            <p>{{ scene.description }}</p>
            <dl>
              <div><dt>地点</dt><dd>{{ scene.location }}</dd></div>
              <div><dt>时间</dt><dd>{{ scene.time_context || '连续' }}</dd></div>
              <div><dt>环境素材</dt><dd><code>{{ scene.environment_family_key }}</code></dd></div>
              <div><dt>主体</dt><dd>{{ sceneSubjectLabel(scene) }}</dd></div>
              <div v-if="beatsForScene(scene.key).length"><dt>视觉节拍</dt><dd>{{ beatsForScene(scene.key).map((beat) => beat.motion_verb || beat.key).join(' / ') }}</dd></div>
            </dl>
          </article>
          <div v-if="transitionAfter(index)" class="transition-card">
            <span>{{ transitionKindLabel(transitionAfter(index).kind) }}</span>
            <strong>{{ transitionDuration(transitionAfter(index)) }}</strong>
            <small>{{ transitionAfter(index).direction || '无方向' }} · {{ transitionAfter(index).requires_new_plate ? '正确模式：独立新背景' : '零调用模式：同地点虚拟机位' }}</small>
            <label v-if="editable" class="transition-anchor">
              <span>转场锚点 {{ Math.round(Number(transitionAfter(index).anchor_ratio ?? defaultTransitionAnchor(index)) * 100) }}%</span>
              <input
                v-model.number="transitionAfter(index).anchor_ratio"
                type="range"
                min="0.05"
                max="0.95"
                step="0.01"
                :aria-label="`转场 ${index + 1} 时间锚点`"
              />
            </label>
            <label v-if="editable" class="transition-duration-input">
              <span>时长（秒）</span>
              <input v-model.number="transitionAfter(index).duration_seconds" type="number" min="0.3" max="3" step="0.1" />
            </label>
            <a
              v-if="shot?.evidence?.some((item) => String(item.target_key || '').startsWith(`${transitionAfter(index).key}_`))"
              :href="`#transition-evidence-${transitionAfter(index).key}`"
            >只看这个转场</a>
            <em v-else>生成动态证明后可逐帧查看</em>
          </div>
        </template>
      </div>
      <div v-if="lowConfidenceScenes.length" class="scene-warning">{{ lowConfidenceScenes.map((scene) => scene.label).join('、') }} 的场景识别置信度较低，请先核对地点和主体再确认蓝图。</div>
      <div v-if="lowConfidenceTransitions.length" class="scene-warning">{{ lowConfidenceTransitions.map((item) => transitionKindLabel(item.kind)).join('、') }} 的边界置信度较低，请核对关联字幕和转场位置。</div>
    </section>

    <section class="blueprint-panel slot-panel">
      <div class="panel-heading"><div><span>05</span><strong>预计正式素材</strong></div><b>{{ generationCount }} 个图片 API 槽位</b></div>
      <div class="slot-list">
        <article v-for="slot in blueprint.generation_slots" :key="`${slot.family_key}:${slot.slot_key}`">
          <div><strong>{{ slotLabel(slot) }}</strong><small>{{ slot.reason }}</small></div>
          <span :class="slot.source">{{ sourceLabel(slot.source) }}</span>
        </article>
      </div>
      <small>保存后系统会按修改后的蓝图重新计算槽位；费用以确认蓝图后的正式报价为准。</small>
    </section>

    <div v-if="validationIssues.length" class="blueprint-errors" role="alert">
      <strong>还不能保存</strong>
      <ul><li v-for="issue in validationIssues" :key="issue">{{ issue }}</li></ul>
    </div>

    <footer class="blueprint-actions">
      <span>{{ dirty ? '修改尚未写入生产版本' : `蓝图 B${shot?.blueprint?.revision_number || 1} 已保存` }}</span>
      <button type="button" class="secondary" :disabled="!dirty || busy || validationIssues.length" @click="save">{{ busy ? '保存中…' : '保存并重新编译' }}</button>
      <button type="button" class="primary" :disabled="dirty || busy || validationIssues.length || shot?.status !== 'analyzed'" @click="$emit('confirm')">确认蓝图，下一步查看费用</button>
    </footer>
  </section>

  <section v-else-if="blueprint" class="blueprint-editor blueprint-compatibility" aria-labelledby="blueprint-compatibility-title">
    <header class="blueprint-header">
      <div>
        <span>PRODUCTION BLUEPRINT · {{ blueprintCompatibility.recovered ? 'RECOVERED' : 'LEGACY' }}</span>
        <h3 id="blueprint-compatibility-title">{{ blueprintCompatibility.recovered ? '恢复版蓝图仅供查看' : '历史蓝图格式不完整' }}</h3>
        <p>这个生产版本早于当前可编辑蓝图结构，已恢复的素材、声音和视频仍会在下方正常展示。</p>
      </div>
      <div class="blueprint-state legacy">只读</div>
    </header>
    <div class="blueprint-impact">
      <strong>继续生产</strong>
      <span>请返回对应分镜新建生产版本；系统会按当前结构重新分析，不会覆盖这份历史记录，也不会在进入页面时调用图片 API。</span>
    </div>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, ref, watch } from 'vue'
import { paperBlueprintCompatibility } from '../../utils/paperBlueprintCompatibility.js'

const EntitySelect = defineComponent({
  name: 'EntitySelect',
  props: {
    modelValue: { type: String, default: null },
    label: { type: String, required: true },
    entities: { type: Array, default: () => [] },
    disabled: { type: Boolean, default: false },
    allowEmpty: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('label', {}, [
      h('span', {}, props.label),
      h('select', {
        value: props.modelValue ?? '', disabled: props.disabled,
        onChange: (event) => emit('update:modelValue', event.target.value || null),
      }, [
        ...(props.allowEmpty ? [h('option', { value: '' }, '无')] : []),
        ...props.entities.map((entity) => h('option', { value: entity.key }, `${entity.name}（${entity.key}）`)),
      ]),
    ])
  },
})

const props = defineProps({
  shot: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  actions: { type: Array, default: () => [] },
})
const emit = defineEmits(['save', 'confirm'])
const blueprint = ref(null)
const original = ref('')
const mergeTargetByKey = ref({})

const editable = computed(() => ['analyzed', 'plan_confirmed'].includes(props.shot?.status))
const dirty = computed(() => blueprint.value && JSON.stringify(blueprint.value) !== original.value)
const blueprintCompatibility = computed(() => paperBlueprintCompatibility(blueprint.value))
const generationCount = computed(() => (blueprint.value?.generation_slots || []).filter((slot) => slot.source === 'image_api').length)
const visualScenes = computed(() => blueprint.value?.visual_scenes || [])
const transitionContracts = computed(() => blueprint.value?.transition_contracts || [])
const blueprintActions = computed(() => {
  const selectable = props.actions
    .filter((action) => action.blueprint_supported && action.user_selectable)
    .map((action) => ({ ...action, compatibility_only: false }))
  const current = blueprint.value?.action_contract?.primary_action
  if (current && !selectable.some((action) => action.key === current)) {
    const catalogued = props.actions.find((action) => action.key === current)
    selectable.push({
      key: current,
      label: catalogued?.label || `${current}（历史动作）`,
      compatibility_only: true,
    })
  }
  return selectable
})
const visualBeats = computed(() => props.shot?.plan_summary_json?.visual_beats || [])
const lowConfidenceScenes = computed(() => visualScenes.value.filter((scene) => Number(scene.confidence ?? 1) < 0.75))
const lowConfidenceTransitions = computed(() => transitionContracts.value.filter((item) => Number(item.confidence ?? 1) < 0.75))
const predicates = [
  { value: 'holds', label: '手持' },
  { value: 'follows', label: '跟随' },
  { value: 'released_beside', label: '释放在旁边' },
  { value: 'sits_on', label: '坐在' },
  { value: 'moves_to', label: '移动到' },
  { value: 'occluded_by', label: '被遮挡' },
  { value: 'interacts_with', label: '交互' },
  { value: 'supports', label: '支撑' },
]

watch(() => props.shot?.blueprint?.id, resetBlueprint, { immediate: true })

function resetBlueprint() {
  blueprint.value = props.shot?.blueprint?.blueprint_json
    ? cloneValue(props.shot.blueprint.blueprint_json)
    : null
  original.value = blueprint.value ? JSON.stringify(blueprint.value) : ''
  mergeTargetByKey.value = {}
}

function nextKey(prefix) {
  const keys = new Set(blueprint.value.entities.map((entity) => entity.key))
  let index = 1
  while (keys.has(`${prefix}_${index}`)) index += 1
  return `${prefix}_${index}`
}

function addEntity() {
  const key = nextKey('prop')
  blueprint.value.entities.push({
    key, type: 'prop', name: '新道具', role: 'prop', independent_layer: true, reusable: false,
    identity_version_id: null, source_library_type: null, source_library_id: null,
    states: ['stable'], attributes: {},
  })
}

function splitEntity(entity) {
  const prefix = entity.type === 'character' ? 'actor' : entity.type === 'environment_anchor' ? 'support' : entity.type === 'effect' ? 'effect' : 'prop'
  const copy = cloneValue(entity)
  copy.key = nextKey(prefix)
  copy.name = `${entity.name}（拆分）`
  copy.source_library_id = null
  copy.identity_version_id = null
  blueprint.value.entities.push(copy)
}

function removeEntity(key) {
  blueprint.value.entities = blueprint.value.entities.filter((entity) => entity.key !== key)
  blueprint.value.relations = blueprint.value.relations.filter((relation) => relation.subject_key !== key && relation.object_key !== key)
  for (const field of ['actor_key', 'object_key', 'support_key']) {
    if (blueprint.value.action_contract[field] === key) blueprint.value.action_contract[field] = field === 'actor_key' ? blueprint.value.entities[0]?.key || null : null
  }
}

function mergeEntity(sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return
  const source = blueprint.value.entities.find((entity) => entity.key === sourceKey)
  const target = blueprint.value.entities.find((entity) => entity.key === targetKey)
  if (!source || !target) return
  target.states = [...new Set([...target.states, ...source.states])]
  target.independent_layer = target.independent_layer || source.independent_layer
  target.reusable = target.reusable || source.reusable
  for (const relation of blueprint.value.relations) {
    if (relation.subject_key === sourceKey) relation.subject_key = targetKey
    if (relation.object_key === sourceKey) relation.object_key = targetKey
  }
  for (const field of ['actor_key', 'object_key', 'support_key']) {
    if (blueprint.value.action_contract[field] === sourceKey) blueprint.value.action_contract[field] = targetKey
  }
  blueprint.value.entities = blueprint.value.entities.filter((entity) => entity.key !== sourceKey)
  delete mergeTargetByKey.value[sourceKey]
}

function setStates(entity, value) {
  entity.states = [...new Set(String(value || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean))]
}

function addWaypoint() {
  const index = blueprint.value.action_contract.waypoints.length + 1
  blueprint.value.action_contract.waypoints.push({ key: `waypoint_${index}`, label: `关键点 ${index}`, x: 0, y: 0 })
}
function removeWaypoint(index) { blueprint.value.action_contract.waypoints.splice(index, 1) }

function addPhase() {
  const index = blueprint.value.action_contract.phases.length + 1
  blueprint.value.action_contract.phases.push({ key: `phase_${index}`, label: `阶段 ${index}`, start_ratio: 0, end_ratio: 1, actor_state: null, object_state: null })
}
function removePhase(index) { blueprint.value.action_contract.phases.splice(index, 1) }

function addRelation() {
  const first = blueprint.value.entities[0]?.key || ''
  const second = blueprint.value.entities[1]?.key || first
  blueprint.value.relations.push({
    key: `relation_${Date.now().toString(36)}`, subject_key: first, predicate: 'interacts_with', object_key: second,
    start_phase: blueprint.value.action_contract.phases[0]?.key || 'start',
    end_phase: blueprint.value.action_contract.phases.at(-1)?.key || 'settle', attributes: {},
  })
}

const validationIssues = computed(() => {
  if (!blueprint.value) return []
  const issues = []
  const keys = blueprint.value.entities.map((entity) => entity.key)
  const keySet = new Set(keys)
  if (keys.length !== keySet.size) issues.push('实体 key 不能重复')
  if (blueprint.value.entities.some((entity) => !entity.name.trim())) issues.push('每个实体都需要名称')
  if (blueprint.value.entities.some((entity) => !entity.states.length)) issues.push('每个实体至少需要一个状态')
  if (!blueprint.value.action_contract.actor_key || !keySet.has(blueprint.value.action_contract.actor_key)) issues.push('请选择有效的动作主体')
  if (blueprint.value.action_contract.object_key && !keySet.has(blueprint.value.action_contract.object_key)) issues.push('作用对象已不存在')
  if (blueprint.value.action_contract.support_key && !keySet.has(blueprint.value.action_contract.support_key)) issues.push('支撑物已不存在')
  if (blueprint.value.relations.some((relation) => !keySet.has(relation.subject_key) || !keySet.has(relation.object_key))) issues.push('关系中存在已删除的实体')
  const byKey = new Map(blueprint.value.entities.map((entity) => [entity.key, entity]))
  if (blueprint.value.relations.some((relation) => relation.predicate === 'holds' && /ground_vehicle|vehicle/.test(String(byKey.get(relation.object_key)?.role || '')))) {
    issues.push('大型接地道具（车辆、推车、大型器物等）不能设置为手持关系')
  }
  if (blueprint.value.entities.some((entity) => bindingIssue(entity))) issues.push('实体库绑定与剧本证据不一致，请改为匿名角色或选择正确实体')
  if (blueprint.value.action_contract.waypoints.some((item) => !Number.isFinite(Number(item.x)) || !Number.isFinite(Number(item.y)))) issues.push('关键点坐标必须是数字')
  if (blueprint.value.action_contract.phases.some((item) => Number(item.start_ratio) > Number(item.end_ratio))) issues.push('动作阶段的开始时间不能晚于结束时间')
  if (blueprint.value.action_contract.primary_action === 'carry_move_sit') {
    if (!blueprint.value.action_contract.object_key) issues.push('“携带移动并坐下”必须选择独立道具')
    if (!blueprint.value.action_contract.support_key) issues.push('“携带移动并坐下”必须选择目标支撑物')
  }
  const sceneKeys = new Set(visualScenes.value.map((scene) => scene.key))
  if (visualScenes.value.length > 1 && transitionContracts.value.length !== visualScenes.value.length - 1) issues.push('每两个相邻视觉场景之间必须有且只有一个转场合同')
  if (transitionContracts.value.some((item) => !sceneKeys.has(item.from_scene_key) || !sceneKeys.has(item.to_scene_key))) issues.push('转场合同引用了不存在的视觉场景')
  if (transitionContracts.value.some((item) => item.relation === 'location_change' && !item.requires_new_plate)) issues.push('地点变化必须使用独立新背景，不能按零调用机位变化处理')
  return [...new Set(issues)]
})

function bindingIssue(entity) {
  if (!entity?.source_library_id) return false
  const evidence = String(entity.attributes?.source_evidence || '').trim()
  const name = String(entity.name || '').trim()
  // Legacy blueprints did not record source evidence. Keep them editable while
  // still highlighting that the binding needs review.
  if (!evidence || !name) return false
  if (evidence.includes(name)) return false
  const shortName = name.replace(/^(?:一辆|一队|一箱|一捆|一名|一位)/, '')
  return !shortName || !evidence.includes(shortName)
}

function bindingWarning(entity) {
  if (!entity?.source_library_id) return false
  return !String(entity.attributes?.source_evidence || '').trim() || bindingIssue(entity)
}

function save() {
  if (!dirty.value || validationIssues.value.length) return
  emit('save', cloneValue(blueprint.value))
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function slotLabel(slot) {
  if (slot.slot_key === 'clean_plate') return '干净背景'
  if (slot.slot_key === 'support_front_mask') return '支撑物前景遮挡'
  return slot.slot_key.replaceAll('_', ' ')
}
function sourceLabel(source) {
  return { image_api: '图片 API', local_derivation: '本地生成', existing_asset: '复用素材', procedural: '程序效果' }[source] || source
}
function transitionAfter(index) { return transitionContracts.value[index] || null }
function defaultTransitionAnchor(index) { return (index + 1) / Math.max(2, visualScenes.value.length) }
function beatsForScene(key) { return visualBeats.value.filter((beat) => beat.scene_key === key) }
function confidenceLabel(value) {
  const score = Number(value ?? 1)
  return score >= 0.9 ? '高置信' : score >= 0.75 ? '可确认' : '需核对'
}
function sceneSubjectLabel(scene) {
  const names = (scene.subject_keys || []).map((key) => blueprint.value?.entities?.find((entity) => entity.key === key)?.name || key)
  return names.length ? names.join('、') : '环境主体'
}
function transitionKindLabel(kind) {
  return { dust_whip_pan: '尘土甩镜', soft_crossfade: '柔和叠化', soft_dissolve: '溶解', color_dip: '色彩压暗', hard_cut: '显式硬切' }[kind] || kind || '场景转场'
}
function transitionDuration(transition) {
  const fps = Number(props.shot?.motion_plan?.plan_json?.fps || 30)
  if (Number.isFinite(Number(transition.end_frame)) && Number.isFinite(Number(transition.start_frame))) return `${((Number(transition.end_frame) - Number(transition.start_frame)) / fps).toFixed(2)} 秒`
  return `${Number(transition.duration_seconds || 0).toFixed(2)} 秒`
}
</script>

<style scoped>
.blueprint-editor { margin: 0 0 30px; border: 1px solid var(--paper-line); background: #191a18; color: var(--paper-text); }
.blueprint-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 22px 24px 18px; border-bottom: 1px solid var(--paper-line); }
.blueprint-header span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .13em; }
.blueprint-header h3 { margin: 7px 0 5px; font: 500 21px/1.25 Georgia, 'Songti SC', serif; }
.blueprint-header p, .panel-help { margin: 0; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.65; }
.blueprint-state { flex: 0 0 auto; padding: 7px 9px; border: 1px solid #695a38; color: #d9b975; font-size: var(--paper-fs-sm); }
.blueprint-state.confirmed { border-color: #476246; color: #8fbb8d; }
.blueprint-state.legacy { border-color: #6b6250; color: #bdb09a; }
.blueprint-impact { display: flex; gap: 12px; padding: 11px 24px; border-bottom: 1px solid #4a3d25; background: #252116; color: #b9a67a; font-size: var(--paper-fs-sm); line-height: 1.55; }
.blueprint-impact strong { color: #dbc183; white-space: nowrap; }
.blueprint-grid { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(420px, 1.2fr); }
.blueprint-panel { min-width: 0; padding: 20px 24px; border-bottom: 1px solid var(--paper-line); }
.entity-panel { border-right: 1px solid var(--paper-line); }
.panel-heading, .entity-card-title, .subsection-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.panel-heading > div { display: flex; align-items: center; gap: 9px; }
.panel-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; }
.panel-heading strong, .subsection-heading strong { font-size: var(--paper-fs-base); }
.panel-heading b { color: var(--paper-accent); font-size: var(--paper-fs-sm); }
.panel-heading button, .subsection-heading button, .entity-card button, .relation-row button, .waypoint-row > button, .phase-list button, .merge-row button { border: 0; background: transparent; color: var(--paper-accent); font-size: var(--paper-fs-xs); cursor: pointer; }
button:disabled { opacity: .35; cursor: not-allowed; }
.panel-help { margin: 8px 0 14px; font-size: var(--paper-fs-sm); }
.entity-card { margin-top: 9px; padding: 12px; border: 1px solid var(--paper-line-soft); background: #1e1f1c; }
.entity-card-title code { color: #9a9284; font-size: var(--paper-fs-xs); }
.entity-card-title > div { display: flex; gap: 7px; }
.entity-card .danger-text { color: #ce7d6d; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-top: 10px; }
label { min-width: 0; display: flex; flex-direction: column; gap: 5px; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
input, select { min-width: 0; box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--paper-line); outline: 0; background: #141512; color: var(--paper-text); font: var(--paper-fs-sm) inherit; }
input:focus, select:focus { border-color: var(--paper-accent); }
input:disabled, select:disabled { opacity: .65; }
.entity-switches { display: flex; gap: 14px; margin-top: 10px; }
.entity-switches label { flex-direction: row; align-items: center; }
.entity-switches input { width: auto; }
.merge-row { display: grid; grid-template-columns: 1fr auto; gap: 7px; margin-top: 9px; }
.merge-row button { padding: 0 5px; border: 1px solid var(--paper-line); }
.entity-card > small { display: block; margin-top: 8px; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.entity-binding, .entity-placement { display: flex; justify-content: space-between; gap: 8px; margin-top: 9px; padding: 7px 8px; border: 1px solid var(--paper-line-soft); color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.entity-binding.warning { border-color: #9f5c51; background: #2b1e1b; color: #dba99f; }
.entity-binding strong { color: inherit; }
.subsection-heading { margin-top: 19px; padding-top: 14px; border-top: 1px solid var(--paper-line-soft); }
.waypoint-list, .phase-list { display: grid; gap: 7px; margin-top: 9px; }
.waypoint-row { display: grid; grid-template-columns: minmax(120px, 1fr) 76px 76px auto; gap: 7px; align-items: end; }
.waypoint-row label { display: grid; grid-template-columns: 14px 1fr; align-items: center; }
.phase-list article { display: grid; grid-template-columns: minmax(90px, 1fr) 72px 72px minmax(90px, 1fr) minmax(90px, 1fr) auto; gap: 6px; align-items: end; }
.phase-list label { display: grid; grid-template-columns: 22px 1fr; align-items: center; }
.relation-list { display: grid; gap: 7px; }
.relation-row { display: grid; grid-template-columns: 1fr 1fr 1fr .8fr .8fr auto; gap: 7px; align-items: center; }
.empty-row { margin: 0; padding: 13px; border: 1px dashed var(--paper-line); color: var(--paper-dim); font-size: var(--paper-fs-sm); text-align: center; }
.slot-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin: 12px 0 9px; }
.slot-list article { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 10px; border: 1px solid var(--paper-line-soft); }
.slot-list article > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.slot-list strong { overflow: hidden; font-size: var(--paper-fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.slot-list small, .slot-panel > small { color: var(--paper-dim); font-size: var(--paper-fs-xs); line-height: 1.5; }
.slot-list article > span { flex: 0 0 auto; color: #b49a62; font-size: var(--paper-fs-xs); }
.slot-list .local_derivation, .slot-list .procedural { color: #7fa0ab; }
.slot-list .existing_asset { color: #83a982; }
.scene-timeline { display: flex; align-items: stretch; gap: 10px; overflow-x: auto; padding: 4px 0 10px; }
.scene-card { flex: 1 0 280px; padding: 14px; border: 1px solid var(--paper-line); background: #151613; }
.scene-card header { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 9px; }
.scene-card header span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; }
.scene-card header strong { color: var(--paper-text); font-size: var(--paper-fs-base); }
.scene-card header i { color: #83a982; font-size: var(--paper-fs-xs); font-style: normal; }
.scene-card p { min-height: 42px; margin: 10px 0; color: var(--paper-muted); font-size: var(--paper-fs-xs); line-height: 1.6; }
.scene-card dl { margin: 0; }
.scene-card dl div { display: grid; grid-template-columns: 64px 1fr; gap: 8px; padding: 5px 0; border-top: 1px solid var(--paper-line-soft); font-size: var(--paper-fs-xs); }
.scene-card dt { color: var(--paper-dim); }
.scene-card dd { min-width: 0; margin: 0; color: var(--paper-muted); overflow-wrap: anywhere; }
.scene-card code { color: #b9a67a; }
.transition-card { flex: 0 0 178px; align-self: center; position: relative; display: flex; flex-direction: column; gap: 5px; padding: 12px; border-top: 1px solid #6f5d35; border-bottom: 1px solid #6f5d35; color: var(--paper-muted); text-align: center; }
.transition-card::before, .transition-card::after { content: ''; position: absolute; top: 50%; width: 10px; border-top: 1px solid #6f5d35; }
.transition-card::before { left: -10px; }.transition-card::after { right: -10px; }
.transition-card span { color: var(--paper-accent); font-size: var(--paper-fs-xs); }
.transition-card strong { color: var(--paper-text); font: 600 var(--paper-fs-sm) ui-monospace, monospace; }
.transition-card small, .transition-card em { color: var(--paper-dim); font-size: var(--paper-fs-xs); font-style: normal; line-height: 1.45; }
.transition-card a { color: #83a982; font-size: var(--paper-fs-xs); }
.transition-anchor, .transition-duration-input { display: grid; gap: 4px; margin-top: 4px; text-align: left; }
.transition-anchor input { width: 100%; accent-color: var(--paper-accent); }
.transition-duration-input input { width: 100%; box-sizing: border-box; border: 1px solid var(--paper-line); background: #111310; color: var(--paper-text); padding: 5px 7px; }
.scene-warning { margin-top: 8px; padding: 9px 11px; border-left: 2px solid #b98252; background: #292117; color: #d7b889; font-size: var(--paper-fs-xs); }
.blueprint-errors { margin: 16px 24px; padding: 12px 14px; border-left: 2px solid #bb695b; background: #2b1e1b; color: #dba99f; font-size: var(--paper-fs-sm); }
.blueprint-errors ul { margin: 7px 0 0; padding-left: 18px; line-height: 1.7; }
.blueprint-actions { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding: 13px 24px; border-top: 1px solid var(--paper-line); background: rgb(25 26 24 / 96%); backdrop-filter: blur(12px); }
.blueprint-actions > span { margin-right: auto; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.blueprint-actions button { padding: 9px 12px; font-size: var(--paper-fs-sm); font-weight: 700; cursor: pointer; }
.blueprint-actions .secondary { border: 1px solid var(--paper-line); background: transparent; color: var(--paper-text); }
.blueprint-actions .primary { border: 0; background: var(--paper-accent); color: #211c13; }
@media (max-width: 1180px) {
  .blueprint-editor { margin-right: 0; margin-left: 0; }
  .blueprint-grid { grid-template-columns: 1fr; }
  .entity-panel { border-right: 0; }
  .slot-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .blueprint-editor { margin: 0 12px 22px; }
  .blueprint-header, .blueprint-panel { padding: 16px; }
  .blueprint-header { flex-direction: column; }
  .field-grid, .slot-list { grid-template-columns: 1fr; }
  .waypoint-row, .phase-list article, .relation-row { grid-template-columns: 1fr 1fr; }
  .blueprint-actions { flex-wrap: wrap; padding: 12px 16px; }
  .blueprint-actions > span { width: 100%; }
}
</style>
