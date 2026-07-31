const STATE_LABELS = Object.freeze({
  start: '起始姿态',
  action: '动作姿态',
  settle: '结束姿态',
  standing_holding: '站立持物',
  walking_holding: '行走持物',
  seated: '坐下姿态',
  moving: '移动姿态',
  arrived: '到达姿态',
  map_marker: '地图人物剪影',
  stable: '静态素材',
})

const TYPE_LABELS = Object.freeze({
  environment: '环境底图',
  'character-cutout': '角色透明层',
  'subject-cutout': '主体透明层',
  'prop-cutout': '道具透明层',
  'effect-cutout': '效果透明层',
  'occlusion-mask': '遮挡蒙版',
  'occluder-cutout': '前景遮挡层',
})

const PURPOSE_LABELS = Object.freeze({
  clean_background: '生成无可动主体的干净背景',
  map_clean_background: '生成无箭头、人物和文字的干净战役地图',
  map_character_marker: '生成在战役地图上显现的人物剪影',
  independent_action_object: '生成需要独立运动的道具层',
  independent_secondary_entity: '生成独立次要主体层',
})

export function paperAssetStateLabel(value) {
  const key = String(value || '').trim()
  return STATE_LABELS[key] || key.replaceAll('_', ' ') || ''
}

export function paperAssetTypeLabel(slotOrType) {
  const type = typeof slotOrType === 'string' ? slotOrType : slotOrType?.asset_type
  return TYPE_LABELS[type] || String(type || '正式素材').replaceAll('_', ' ')
}

export function paperAssetSlotLabel(slot) {
  if (!slot) return '未选择素材'
  const constraints = slot.constraints_json || slot.constraints || {}
  if (constraints.label) return constraints.label
  const identity = String(constraints.identity || '').trim()
  const state = paperAssetStateLabel(constraints.state)
  if (identity && state) return `${identity} · ${state}`
  if (identity) return `${identity} · ${paperAssetTypeLabel(slot)}`
  if (slot.slot_key === 'clean_plate') return '干净背景底图'
  return state || String(slot.slot_key || '正式素材').replaceAll('_', ' ')
}

export function paperAssetPurposeLabel(slot) {
  if (!slot) return ''
  return PURPOSE_LABELS[slot.generation_purpose]
    || slot.constraints_json?.reason
    || String(slot.generation_purpose || '').replaceAll('_', ' ')
}
