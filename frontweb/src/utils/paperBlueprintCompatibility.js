function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function paperBlueprintCompatibility(blueprint) {
  if (!isRecord(blueprint)) {
    return { editable: false, recovered: false, missing: ['blueprint'] }
  }

  const missing = []
  if (!Array.isArray(blueprint.entities)) missing.push('entities')
  if (!Array.isArray(blueprint.relations)) missing.push('relations')
  if (!Array.isArray(blueprint.generation_slots)) missing.push('generation_slots')

  if (!isRecord(blueprint.action_contract)) {
    missing.push('action_contract')
  } else {
    if (!Array.isArray(blueprint.action_contract.waypoints)) missing.push('action_contract.waypoints')
    if (!Array.isArray(blueprint.action_contract.phases)) missing.push('action_contract.phases')
  }

  if (Array.isArray(blueprint.entities) && blueprint.entities.some((entity) => (
    !isRecord(entity)
    || typeof entity.key !== 'string'
    || typeof entity.name !== 'string'
    || !Array.isArray(entity.states)
  ))) missing.push('entities[]')

  if (Array.isArray(blueprint.relations) && blueprint.relations.some((relation) => !isRecord(relation))) {
    missing.push('relations[]')
  }
  if (Array.isArray(blueprint.generation_slots) && blueprint.generation_slots.some((slot) => (
    !isRecord(slot) || typeof slot.slot_key !== 'string'
  ))) missing.push('generation_slots[]')

  return {
    editable: missing.length === 0,
    recovered: blueprint.recovered === true,
    missing: [...new Set(missing)],
  }
}

export function isEditablePaperBlueprint(blueprint) {
  return paperBlueprintCompatibility(blueprint).editable
}
