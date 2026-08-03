function walk(node, visit) {
  if (!node) return;
  visit(node);
  (node.children || []).forEach((child) => walk(child, visit));
}

function derive(plan) {
  const primitives = new Set(['independent_asset_versions']);
  const families = plan.families || [];
  if (families.some((family) => family.pattern === 'supported-subject')) primitives.add('supported_subject');
  if (families.some((family) => family.pattern === 'registered-environment')) primitives.add('registered_environment');
  if ((plan.semanticContract?.environment?.registered_boundaries || []).length) primitives.add('registered_boundary');
  if ((plan.semanticContract?.subjects || []).length > 1) primitives.add('multi_subject_interaction');
  if ((plan.motionPlan?.subject_tracks || []).some((track) => track.property === 'state')) primitives.add('state_transition');
  if ((plan.motionPlan?.cues || []).some((cue) => cue.kind === 'contact')) primitives.add('contact_cue');
  walk(plan.root, (node) => {
    const relation = node.relation || {};
    if (relation.predicate === 'held-by') primitives.add('attached_prop');
    if (relation.role === 'front-occluder' || (relation.occludes || []).length) primitives.add('front_occlusion');
    if (relation.boundary || node.clip?.boundary) primitives.add('boundary_registration');
    if (relation.predicate === 'crosses' || relation.crosses_boundary) primitives.add('boundary_crossing');
    if (relation.contact_zone || relation.contactZone) primitives.add('contact_zone');
    if (relation.state_slots) primitives.add('state_atlas');
    if (['atmosphere-drift', 'ambient-flow'].includes(relation.procedural_kind)) primitives.add('environmental_motion');
    if (['path-reveal', 'label-card', 'route-reveal', 'map-title-card'].includes(relation.procedural_kind)) primitives.add('information_reveal');
    if (['ember-drift', 'ember-field', 'transition-effect'].includes(relation.procedural_kind)) primitives.add('procedural_effect');
  });
  return [...primitives];
}

module.exports = { walk, derive };
