const { resolveTrackValue } = require('../../paper-studio-renderer/motion/trackResolver.cjs');
const { PaperStudioError, parseJson } = require('./paperStudioUtils');

const SPATIAL_PLANNER_VERSION = 8;
const GROUND_TOLERANCE = 0.012;

function flattenNodes(root) {
  if (!root) return [];
  return [root, ...(root.children || []).flatMap(flattenNodes)];
}

function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  const epsilon = 1e-9;
  const onSegment = (start, end) => {
    const [x1, y1] = start.map(Number);
    const [x2, y2] = end.map(Number);
    const cross = (Number(point.x) - x1) * (y2 - y1) - (Number(point.y) - y1) * (x2 - x1);
    if (Math.abs(cross) > epsilon) return false;
    return Number(point.x) >= Math.min(x1, x2) - epsilon
      && Number(point.x) <= Math.max(x1, x2) + epsilon
      && Number(point.y) >= Math.min(y1, y2) - epsilon
      && Number(point.y) <= Math.max(y1, y2) + epsilon;
  };
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    if (onSegment(polygon[previous], polygon[index])) return true;
    const [xi, yi] = polygon[index].map(Number);
    const [xj, yj] = polygon[previous].map(Number);
    const crosses = ((yi > point.y) !== (yj > point.y))
      && point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function trackFor(plan, target, property) {
  return (plan.subject_tracks || []).find((track) => track.target === target && track.property === property) || null;
}

function sampleFrames(plan, node) {
  const durationFrames = Math.max(1, Math.round(Number(plan.duration_frames || 1)));
  // Spatial motion is resolved at integer render frames. Validate every frame so
  // a path cannot cross a narrow forbidden region between otherwise-valid keys.
  const frames = new Set(Array.from({ length: durationFrames }, (_, frame) => frame));
  for (const property of ['x', 'y', 'state']) {
    for (const keyframe of trackFor(plan, node.key, property)?.keyframes || []) frames.add(Number(keyframe.frame));
  }
  return [...frames].sort((a, b) => a - b);
}

function stateIsGrounded(placement, state) {
  const groundedStates = placement?.grounded_states;
  if (!Array.isArray(groundedStates) || !groundedStates.length) return true;
  return groundedStates.includes(state);
}

function spatialNodesFromRoot(root) {
  return flattenNodes(root)
    .filter((node) => node.kind === 'asset' && node.relation?.placement?.support_kind === 'ground')
    .map((node) => ({
      key: node.key,
      scene_key: node.relation?.scene_key || null,
      base_x: Number(node.transform?.x == null ? 0.5 : node.transform.x),
      base_y: Number(node.transform?.y == null ? 0.5 : node.transform.y),
      placement: node.relation.placement,
    }));
}

function evaluatePlan(plan, summary = {}) {
  const contract = summary?.spatial_contract || {};
  const defaultRegions = contract.placement_regions || summary?.placement_regions || [];
  const sceneContracts = new Map((contract.scenes || []).map((scene) => [scene.scene_key, scene]));
  const nodes = contract.nodes || [];
  if (Number(summary?.planner_version || 0) < SPATIAL_PLANNER_VERSION || !nodes.length) {
    return { pass: true, skipped: true, assertions: [] };
  }
  const assertions = [];
  for (const node of nodes) {
    const regions = sceneContracts.get(node.scene_key)?.placement_regions || defaultRegions;
    const regionsByKey = new Map(regions.map((region) => [region.key, region]));
    const forbidden = regions.filter((region) => region.kind === 'forbidden');
    const placement = node.placement || {};
    const region = regionsByKey.get(placement.region_key);
    assertions.push({
      key: `spatial:${node.key}:region_exists`,
      pass: Boolean(region && region.kind !== 'forbidden'),
      actual: placement.region_key || null,
      expected: 'walkable/support region',
    });
    if (!region || region.kind === 'forbidden') continue;
    const xTrack = trackFor(plan, node.key, 'x');
    const yTrack = trackFor(plan, node.key, 'y');
    const stateTrack = trackFor(plan, node.key, 'state');
    for (const frame of sampleFrames(plan, node)) {
      const state = stateTrack ? resolveTrackValue(stateTrack, frame) : null;
      if (!stateIsGrounded(placement, state)) continue;
      const point = {
        x: Number(node.base_x) + Number(xTrack ? resolveTrackValue(xTrack, frame) || 0 : 0),
        y: Number(node.base_y) + Number(yTrack ? resolveTrackValue(yTrack, frame) || 0 : 0),
      };
      const insideAllowed = pointInPolygon(point, region.polygon);
      const forbiddenRegion = forbidden.find((item) => pointInPolygon(point, item.polygon));
      const groundY = Number(region.ground_y == null ? node.base_y : region.ground_y);
      assertions.push({
        key: `spatial:${node.key}:frame:${frame}:inside_region`,
        pass: insideAllowed && !forbiddenRegion,
        actual: { ...point, forbidden_region: forbiddenRegion?.key || null },
        expected: placement.region_key,
      });
      assertions.push({
        key: `spatial:${node.key}:frame:${frame}:ground_lock`,
        pass: Math.abs(point.y - groundY) <= GROUND_TOLERANCE,
        actual: Number(point.y.toFixed(6)),
        expected: groundY,
        tolerance: GROUND_TOLERANCE,
      });
    }
  }
  return { pass: assertions.every((assertion) => assertion.pass), skipped: false, assertions };
}

function assertPlan(plan) {
  const report = evaluatePlan(plan.motionPlan, plan.summary);
  if (!report.pass) {
    throw new PaperStudioError(
      'PAPER_STUDIO_SPATIAL_PLAN_INVALID',
      '人物或道具没有保持在允许的地面区域内',
      report,
      422,
    );
  }
  return report;
}

function rawRegistration(version) {
  const explicit = parseJson(version?.registration_json, version?.registration_json || {});
  if (explicit?.contact_anchor && Number.isFinite(Number(explicit.contact_anchor.x)) && Number.isFinite(Number(explicit.contact_anchor.y))) {
    return explicit;
  }
  const quality = parseJson(version?.quality_report_json, version?.quality_report_json || {});
  const constraints = parseJson(version?.constraints_json, version?.constraints_json || {});
  const bbox = quality?.alpha_bbox || null;
  if (!bbox) return null;
  return {
    ...explicit,
    contact_anchor: {
      x: Math.max(0, Math.min(1, Number(bbox.x || 0) + Number(bbox.width || 1) / 2)),
      y: Math.max(0, Math.min(1, Number(bbox.y || 0) + Number(bbox.height || 1))),
    },
    contact_kind: constraints?.contact_kind || (/character|subject/.test(String(version?.asset_type || '')) ? 'feet' : 'base'),
    confidence: 0.75,
    derived_from: 'alpha_bbox_bottom',
    width: Number(quality.width || 0),
    height: Number(quality.height || 0),
  };
}

function fittedContactAnchor(node, version) {
  const registration = rawRegistration(version);
  if (!registration) return null;
  const raw = registration.contact_anchor;
  const assetWidth = Number(registration.width || parseJson(version.quality_report_json, {}).width || 0);
  const assetHeight = Number(registration.height || parseJson(version.quality_report_json, {}).height || 0);
  const boxWidth = Number(node.transform?.width || 1) * 1920;
  const boxHeight = Number(node.transform?.height || 1) * 1080;
  if (!(assetWidth > 0 && assetHeight > 0 && boxWidth > 0 && boxHeight > 0)) return raw;
  const assetAspect = assetWidth / assetHeight;
  const boxAspect = boxWidth / boxHeight;
  if (assetAspect > boxAspect) {
    const renderedHeight = boxWidth / assetAspect;
    const top = (boxHeight - renderedHeight) / 2;
    return { x: Number(raw.x), y: (top + Number(raw.y) * renderedHeight) / boxHeight };
  }
  const renderedWidth = boxHeight * assetAspect;
  const left = (boxWidth - renderedWidth) / 2;
  return { x: (left + Number(raw.x) * renderedWidth) / boxWidth, y: Number(raw.y) };
}

function enrichComposition(root, versions) {
  const byId = new Map(versions.map((version) => [Number(version.id), version]));
  const visit = (node) => {
    if (node.kind === 'asset' && node.relation?.placement?.support_kind === 'ground') {
      const direct = byId.get(Number(node.asset_version_id));
      const contact = direct ? fittedContactAnchor(node, direct) : null;
      if (contact) {
        node.relation.contact_anchor = contact;
        node.relation.contact_registration = rawRegistration(direct);
        node.transform.anchor_x = contact.x;
        node.transform.anchor_y = contact.y;
      }
      if (node.relation.state_asset_version_ids) {
        node.relation.state_contact_anchors = Object.fromEntries(
          Object.entries(node.relation.state_asset_version_ids).map(([state, versionId]) => {
            const version = byId.get(Number(versionId));
            return [state, version ? fittedContactAnchor(node, version) : contact];
          }).filter(([, value]) => Boolean(value)),
        );
      }
    }
    (node.children || []).forEach(visit);
  };
  visit(root);
  return root;
}

function assertSnapshot(snapshot) {
  const plannerVersion = Number(snapshot?.provenance?.planner_version || 0);
  if (plannerVersion < SPATIAL_PLANNER_VERSION) return { pass: true, skipped: true, assertions: [] };
  const nodes = flattenNodes(snapshot.root).filter((node) => node.relation?.placement?.support_kind === 'ground');
  const anchors = nodes.map((node) => ({
    key: `snapshot:${node.key}:contact_anchor`,
    pass: Boolean(node.relation?.contact_anchor),
    actual: node.relation?.contact_anchor || null,
    expected: node.relation?.placement?.contact_kind || 'ground contact',
  }));
  const planReport = evaluatePlan(snapshot.motion_plan, {
    planner_version: plannerVersion,
    spatial_contract: snapshot.spatial_contract || {},
  });
  const report = { pass: anchors.every((item) => item.pass) && planReport.pass, assertions: [...anchors, ...planReport.assertions] };
  if (!report.pass) {
    throw new PaperStudioError(
      'PAPER_STUDIO_SNAPSHOT_SPATIAL_GATE_FAILED',
      '冻结快照中的人物脚底或道具接地点没有落在允许地面内',
      report,
      422,
    );
  }
  return report;
}

module.exports = {
  SPATIAL_PLANNER_VERSION,
  GROUND_TOLERANCE,
  flattenNodes,
  pointInPolygon,
  spatialNodesFromRoot,
  evaluatePlan,
  assertPlan,
  rawRegistration,
  fittedContactAnchor,
  enrichComposition,
  assertSnapshot,
};
