const schemaService = require('./paperStudioSchemaService');
const shotService = require('./paperStudioShotService');
const motionGateService = require('./paperMotionGateService');
const runAggregateService = require('./paperRunAggregateService');
const actionCatalogService = require('./paperActionCatalogService');
const templateCatalog = require('./paperStudioTemplateCatalog');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

const ALLOWED_STATES = new Set([
  'analyzed', 'plan_confirmed', 'asset_failed', 'asset_ready', 'motion_failed',
  'motion_ready', 'proof_failed', 'proof_ready', 'preview_ready', 'approved',
  'render_failed', 'rendered',
]);

const DOWNSTREAM_STEPS = new Set([
  'plan_motion', 'compile_snapshot', 'render_proof', 'dynamic_gate',
  'render_preview', 'wait_preview_approval', 'render_formal', 'publish_video',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function primaryTarget(plan, instruction = '') {
  const tracks = plan.subject_tracks || [];
  const explicit = tracks.find((track) => instruction.includes(track.target));
  if (explicit) return explicit.target;
  if (/(前景|遮挡|掩住|盖住)/.test(instruction)) {
    return tracks.find((track) => track.property === 'procedural_amount')?.target || null;
  }
  if (/(道具|手持|拿着|物件)/.test(instruction)) {
    return tracks.find((track) => /prop/i.test(track.target))?.target || null;
  }
  if (/(角色|人物|演员|士兵|状态)/.test(instruction)) {
    return tracks.find((track) => track.property === 'state')?.target
      || tracks.find((track) => /actor|character|subject/i.test(track.target))?.target
      || null;
  }
  const preferred = ['supported_group', 'primary_subject', 'held_action_group', 'actor', 'actors'];
  return preferred.find((target) => tracks.some((track) => track.target === target))
    || tracks.find((track) => !['procedural_amount', 'state'].includes(track.property))?.target
    || tracks[0]?.target
    || null;
}

function interpretInstruction(instruction, plan) {
  const text = String(instruction || '').trim();
  const action = actionCatalogService.get(plan.primary_action);
  if (!action) throw new PaperStudioError('PAPER_STUDIO_ACTION_NOT_CATALOGUED', '当前动作不在受限动作目录中，不能进行自然语言修订', { primary_action: plan.primary_action }, 422);
  const target = primaryTarget(plan, text);
  const operations = [];
  if (plan.primary_action === 'object_sequence_transition' && /(顺序|依次|转场|甩镜|切到|镜头转移|不要同屏|悬空|退场)/.test(text)) {
    operations.push({ kind: 'sequence_focus_transfer' });
  }
  if (/(补齐|恢复|加入).{0,8}(?:角色|人物|道具|主体)?.{0,5}状态|(?:角色|人物|道具|主体)状态.{0,8}(?:补齐|完整|三个阶段)/.test(text)) {
    operations.push({ kind: 'state_progression', target });
  }
  if (/(放下道具事件|释放时刻|释放事件|加入明确的释放|补上释放)/.test(text)) {
    operations.push({ kind: 'release_cue', target: target || tracks.find((track) => /prop/i.test(track.target))?.target || null });
  }
  if (/(后面|后方|被.+挡住|behind)/i.test(text)) {
    operations.push({ kind: 'relation_order', relation: 'behind', target_role: 'subject' });
  } else if (/(前面|前方|不要被.+挡住|in front)/i.test(text)) {
    operations.push({ kind: 'relation_order', relation: 'in-front-of', target_role: 'subject' });
  }
  if (/(遮挡|掩住|盖住|露出|前景)/.test(text)) {
    const increase = /(更多|再多|加强|更深|挡住|盖住)/.test(text) && !/(减少|少一点|弱一点|露出更多)/.test(text);
    const decrease = /(减少|少一点|弱一点|露出更多|别挡)/.test(text);
    if (increase || decrease) operations.push({ kind: 'occlusion', direction: increase ? 'increase' : 'decrease', target });
  }
  if (/(更快|快一点|提前|早一点|加速)/.test(text)) operations.push({ kind: 'timing', direction: 'earlier', factor: 0.85, target: /状态/.test(text) ? target : null });
  if (/(更慢|慢一点|延后|晚一点|拖长)/.test(text)) operations.push({ kind: 'timing', direction: 'later', factor: 1.15, target: /状态/.test(text) ? target : null });
  if (/(旋转|倾斜|歪|翻转)/.test(text)) {
    const decrease = /(少一点|减小|别太|弱一点)/.test(text);
    operations.push({ kind: 'amplitude', property: 'rotation', factor: decrease ? 0.8 : 1.25, target });
  }
  if (/(下沉|沉得|更深|往下|下降|坠落)/.test(text)) {
    const decrease = /(少一点|浅一点|别太|减小)/.test(text);
    operations.push({ kind: 'amplitude', property: 'y', factor: decrease ? 0.8 : 1.25, target });
  } else if (/(抬高|往上|上移|升高)/.test(text)) {
    operations.push({ kind: 'direction', property: 'y', delta: -0.05, target });
  }
  if (/(往左|左移|向左)/.test(text)) operations.push({ kind: 'direction', property: 'x', delta: -0.05, target });
  if (/(往右|右移|向右)/.test(text)) operations.push({ kind: 'direction', property: 'x', delta: 0.05, target });
  if (/(动作|幅度|反应).*(更大|大一点|明显|加强)|再明显一点/.test(text)) operations.push({ kind: 'amplitude', property: null, factor: 1.25, target });
  if (/(动作|幅度|反应).*(更小|小一点|减弱|轻一点)/.test(text)) operations.push({ kind: 'amplitude', property: null, factor: 0.8, target });
  if (!operations.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_REVISION_INTENT_UNSUPPORTED',
      '暂时无法把这句话映射到安全动作原语；可以描述动作更大/更小、更快/更慢、左右上下、旋转、遮挡或前后关系',
      { instruction: text, supported_axes: action.revision_axes },
      422,
    );
  }
  const allowed = new Set(action.revision_axes);
  const axisFor = (operation) => ({ amplitude: 'intensity', timing: 'timing', direction: 'direction', occlusion: 'occlusion', relation_order: 'relation', sequence_focus_transfer: 'staging', state_progression: 'state', release_cue: 'timing' })[operation.kind];
  const rejected = operations.filter((operation) => !allowed.has(operation.property === 'rotation' ? 'rotation' : axisFor(operation)));
  if (rejected.length) {
    throw new PaperStudioError('PAPER_STUDIO_REVISION_AXIS_NOT_ALLOWED', '当前动作类型不允许这类修订', { primary_action: plan.primary_action, rejected, supported_axes: action.revision_axes }, 422);
  }
  return { schema_version: 1, source: 'deterministic-rule', instruction: text, primary_action: plan.primary_action, operations };
}

function ensureNumericTrack(plan, target, property) {
  let track = (plan.subject_tracks || []).find((item) => item.target === target && item.property === property);
  if (!track && target) {
    const initial = property === 'scale' ? 1 : 0;
    track = { target, property, keyframes: [{ frame: 0, value: initial }, { frame: plan.duration_frames - 1, value: initial }] };
    plan.subject_tracks.push(track);
  }
  return track;
}

function scaleTrack(track, factor) {
  const limits = actionCatalogService.NUMERIC_LIMITS[track.property];
  if (!limits) return false;
  const numeric = track.keyframes.filter((keyframe) => typeof keyframe.value === 'number');
  if (numeric.length < 2) return false;
  const base = numeric[0].value;
  for (const keyframe of numeric.slice(1)) keyframe.value = Number(clamp(base + ((keyframe.value - base) * factor), limits[0], limits[1]).toFixed(6));
  return true;
}

function offsetTrack(track, delta) {
  const limits = actionCatalogService.NUMERIC_LIMITS[track.property];
  if (!limits) return false;
  for (const keyframe of track.keyframes.slice(1)) {
    if (typeof keyframe.value === 'number') keyframe.value = Number(clamp(keyframe.value + delta, limits[0], limits[1]).toFixed(6));
  }
  return true;
}

function retimeFrames(items, durationFrames, factor) {
  const finalFrame = durationFrames - 1;
  const sorted = [...items].sort((left, right) => left.frame - right.frame);
  let previous = -1;
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    if (index === 0 && item.frame === 0) item.frame = 0;
    else if (index === sorted.length - 1 && item.frame === finalFrame) item.frame = finalFrame;
    else item.frame = clamp(Math.round(item.frame * factor), previous + 1, finalFrame - (sorted.length - index - 1));
    previous = item.frame;
  }
  return sorted;
}

function applyRelation(db, shot, operation) {
  const nodes = shot.composition_nodes || [];
  const subject = nodes.find((node) => node.relation_json?.role === 'subject')
    || nodes.find((node) => /actor|subject/i.test(node.node_key));
  const reference = operation.relation === 'behind'
    ? (nodes.find((node) => node.relation_json?.role === 'front-occluder') || nodes.find((node) => node.relation_json?.role === 'rear-support'))
    : (nodes.find((node) => node.relation_json?.role === 'front-occluder') || nodes.find((node) => node.relation_json?.role === 'rear-support'));
  if (!subject || !reference || subject.parent_node_id !== reference.parent_node_id) {
    throw new PaperStudioError('PAPER_STUDIO_RELATION_REVISION_UNAVAILABLE', '当前组合树没有可安全调整的主体/参照层关系', { shot_id: shot.id }, 422);
  }
  const localZ = operation.relation === 'behind' ? Number(reference.local_z) - 1 : Number(reference.local_z) + 1;
  const relation = { ...subject.relation_json, predicate: operation.relation, object_key: reference.node_key };
  db.prepare('UPDATE paper_composition_nodes SET local_z = ?, relation_json = ?, version = version + 1, updated_at = ? WHERE id = ?').run(localZ, JSON.stringify(relation), nowIso(), Number(subject.id));
  return { node_key: subject.node_key, relation: operation.relation, object_key: reference.node_key, local_z: localZ };
}

function applyIntent(db, shot, plan, summary, intent) {
  const changedTracks = new Set();
  const relationChanges = [];
  for (const operation of intent.operations) {
    if (operation.kind === 'state_progression') {
      const target = operation.target || primaryTarget(plan, intent.instruction);
      let track = (plan.subject_tracks || []).find((item) => item.target === target && item.property === 'state');
      if (!track) {
        track = { target, property: 'state', keyframes: [] };
        plan.subject_tracks.push(track);
      }
      const required = summary?.required_states && !Array.isArray(summary.required_states)
        ? summary.required_states[target]
        : null;
      const propTarget = /prop/i.test(String(target || ''));
      const defaults = propTarget
        ? ['held', 'carried', 'released']
        : plan.primary_action === 'state_transition'
          ? ['standing', 'transitioning', 'seated']
          : ['start', 'moving', 'arrived'];
      const states = Array.isArray(required) && required.length >= 3 ? required.slice(0, 3) : defaults;
      const middle = Math.max(1, Math.round((plan.duration_frames - 1) * 0.58));
      track.keyframes = [
        { frame: 0, value: states[0] },
        { frame: middle, value: states[1] },
        { frame: plan.duration_frames - 1, value: states[2] },
      ];
      changedTracks.add(`${target}:state`);
      continue;
    }
    if (operation.kind === 'release_cue') {
      const target = operation.target || (plan.subject_tracks || []).find((track) => /prop/i.test(track.target))?.target;
      if (!target) throw new PaperStudioError('PAPER_STUDIO_REVISION_TARGET_MISSING', '当前动作没有可释放的道具轨道', { operation }, 422);
      const frame = Math.max(1, Math.min(plan.duration_frames - 2, Math.round((plan.duration_frames - 1) * 0.86)));
      const existing = (plan.cues || []).find((cue) => cue.key === 'release_prop');
      if (existing) existing.frame = frame;
      else plan.cues.push({ key: 'release_prop', frame, kind: 'contact' });
      plan.cues.sort((left, right) => left.frame - right.frame);
      let stateTrack = (plan.subject_tracks || []).find((track) => track.target === target && track.property === 'state');
      if (!stateTrack) {
        stateTrack = { target, property: 'state', keyframes: [{ frame: 0, value: 'held' }] };
        plan.subject_tracks.push(stateTrack);
      }
      const before = stateTrack.keyframes.filter((keyframe) => keyframe.frame < frame);
      stateTrack.keyframes = [
        ...(before.length ? before : [{ frame: 0, value: 'held' }, { frame: Math.max(1, Math.round(frame * 0.55)), value: 'carried' }]),
        { frame, value: 'released' },
        { frame: plan.duration_frames - 1, value: 'released' },
      ].filter((keyframe, index, items) => items.findIndex((item) => item.frame === keyframe.frame) === index)
        .sort((left, right) => left.frame - right.frame);
      changedTracks.add(`${target}:state`);
      changedTracks.add('cue:release_prop');
      continue;
    }
    if (operation.kind === 'sequence_focus_transfer') {
      const cues = Object.fromEntries((plan.cues || []).map((cue) => [cue.key, Number(cue.frame)]));
      const result = templateCatalog.applyObjectSequenceStaging(plan, {
        impactFrame: cues.impact,
        revealFrame: cues.secondary_reveal,
        hasSecondary: (plan.subject_tracks || []).some((track) => track.target === 'secondary_prop'),
      });
      result.changed_tracks.forEach((trackKey) => changedTracks.add(trackKey));
      summary.proof_targets = (summary.proof_targets || []).map((target) => {
        if (target.key === 'object_start') return {
          ...target,
          assertions: [
            ...(target.assertions || []).filter((assertion) => assertion.type !== 'track_value_at_frame' || assertion.target !== 'impact_tool' || assertion.property !== 'opacity'),
            { type: 'track_value_at_frame', target: 'impact_tool', property: 'opacity', max: 0.05 },
          ],
        };
        if (target.key === 'object_impact') return {
          ...target,
          assertions: [
            ...(target.assertions || []).filter((assertion) => assertion.type !== 'track_value_at_frame' || assertion.target !== 'impact_tool' || assertion.property !== 'opacity'),
            { type: 'track_value_at_frame', target: 'impact_tool', property: 'opacity', min: 0.95 },
          ],
        };
        if (target.key !== 'object_sequence_final') return target;
        return {
          ...target,
          assertions: [
            ...(target.assertions || []).filter((assertion) => !(
              assertion.type === 'final_track_value'
              && ['impact_tool', 'impact_subject'].includes(assertion.target)
              && assertion.property === 'opacity'
            )),
            { type: 'final_track_value', target: 'impact_tool', property: 'opacity', max: 0.05 },
            { type: 'final_track_value', target: 'impact_subject', property: 'opacity', max: 0.1 },
          ],
        };
      });
      continue;
    }
    if (operation.kind === 'relation_order') {
      relationChanges.push(applyRelation(db, shot, operation));
      continue;
    }
    if (operation.kind === 'timing') {
      const tracks = (plan.subject_tracks || []).filter((track) => !operation.target || track.target === operation.target);
      for (const track of tracks) {
        track.keyframes = retimeFrames(track.keyframes, plan.duration_frames, operation.factor);
        changedTracks.add(`${track.target}:${track.property}`);
      }
      plan.cues = retimeFrames(plan.cues || [], plan.duration_frames, operation.factor);
      summary.proof_targets = (summary.proof_targets || []).map((target) => ({ ...target, frame: retimeFrames([{ frame: target.frame }], plan.duration_frames, operation.factor)[0].frame }));
      continue;
    }
    if (operation.kind === 'occlusion') {
      const track = (plan.subject_tracks || []).find((item) => item.property === 'procedural_amount' && (!operation.target || item.target === operation.target));
      if (!track) throw new PaperStudioError('PAPER_STUDIO_REVISION_TARGET_MISSING', '当前动作没有可修订的前景遮挡轨道', { operation }, 422);
      offsetTrack(track, operation.direction === 'increase' ? 0.12 : -0.12);
      changedTracks.add(`${track.target}:${track.property}`);
      continue;
    }
    if (operation.kind === 'amplitude') {
      const tracks = (plan.subject_tracks || []).filter((track) => (
        (!operation.target || track.target === operation.target)
        && track.property !== 'state'
        && (!operation.property || track.property === operation.property)
      ));
      if (!tracks.length && operation.property && operation.target) tracks.push(ensureNumericTrack(plan, operation.target, operation.property));
      for (const track of tracks.filter(Boolean)) {
        if (scaleTrack(track, operation.factor)) changedTracks.add(`${track.target}:${track.property}`);
      }
      continue;
    }
    if (operation.kind === 'direction') {
      const track = ensureNumericTrack(plan, operation.target, operation.property);
      if (!track) throw new PaperStudioError('PAPER_STUDIO_REVISION_TARGET_MISSING', '没有找到可修订的主体轨道', { operation }, 422);
      offsetTrack(track, operation.delta);
      changedTracks.add(`${track.target}:${track.property}`);
    }
  }
  return { changed_tracks: [...changedTracks], relation_changes: relationChanges };
}

function nextShotStatus(current) {
  if (current === 'analyzed' || current === 'plan_confirmed' || current === 'asset_failed') return current;
  return 'asset_ready';
}

function trackChangeSummary(beforePlan, afterPlan, changedTrackKeys = []) {
  function summarize(plan, target, property) {
    if (target === 'cue') {
      const cue = (plan.cues || []).find((item) => item.key === property);
      return cue ? { exists: true, frame: Number(cue.frame) } : { exists: false, frame: null };
    }
    const track = (plan.subject_tracks || []).find((item) => item.target === target && item.property === property);
    if (!track) return null;
    const keyframes = [...(track.keyframes || [])].sort((left, right) => left.frame - right.frame);
    if (property === 'state') {
      return {
        distinct_states: new Set(keyframes.map((item) => item.value)).size,
        initial: keyframes[0]?.value ?? null,
        final: keyframes.at(-1)?.value ?? null,
      };
    }
    const values = keyframes.map((item) => item.value).filter((value) => typeof value === 'number');
    return {
      range: values.length ? Number((Math.max(...values) - Math.min(...values)).toFixed(6)) : 0,
      initial: keyframes[0]?.value ?? null,
      final: keyframes.at(-1)?.value ?? null,
    };
  }
  return [...new Set(changedTrackKeys)].map((key) => {
    const split = key.indexOf(':');
    const target = split >= 0 ? key.slice(0, split) : key;
    const property = split >= 0 ? key.slice(split + 1) : '';
    return {
      target,
      property,
      before: summarize(beforePlan, target, property),
      after: summarize(afterPlan, target, property),
    };
  });
}

function list(db, shotId) {
  return db.prepare('SELECT * FROM paper_motion_revisions WHERE shot_id = ? ORDER BY id DESC').all(Number(shotId)).map((row) => ({
    ...row,
    id: Number(row.id),
    shot_id: Number(row.shot_id),
    motion_plan_id: Number(row.motion_plan_id),
    intent_json: parseJson(row.intent_json, {}),
    patch_json: parseJson(row.patch_json, {}),
    gate_report_json: parseJson(row.gate_report_json, {}),
  }));
}

function revise(db, cfg, log, shotId, body = {}) {
  schemaService.assertValid('apiMotionRevise', body, '自然语言动作修订参数无效');
  const shot = shotService.get(db, shotId);
  const existing = db.prepare('SELECT id FROM paper_motion_revisions WHERE shot_id = ? AND request_id = ?').get(Number(shot.id), body.request_id);
  if (existing) return { shot: shotService.get(db, shot.id), revision: list(db, shot.id).find((item) => item.id === Number(existing.id)), deduplicated: true };
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!ALLOWED_STATES.has(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头状态不允许修订动作', { shot_id: shot.id, status: shot.status }, 409);
  }
  if (!shot.motion_plan) throw new PaperStudioError('PAPER_STUDIO_MOTION_PLAN_NOT_FOUND', '当前镜头尚无动作计划', { shot_id: shot.id }, 409);
  const plan = clone(shot.motion_plan.plan_json);
  const beforePlan = clone(plan);
  const summary = clone(shot.plan_summary_json || {});
  const beforeRelations = (shot.composition_nodes || []).map((node) => ({ key: node.node_key, local_z: node.local_z, relation: node.relation_json }));
  const beforeHash = sha256(canonicalJson({ plan, relations: beforeRelations }));
  const intent = interpretInstruction(body.instruction, plan);
  let patch;
  let gate;
  let afterHash;
  const transaction = db.transaction(() => {
    patch = applyIntent(db, shot, plan, summary, intent);
    patch.changes = trackChangeSummary(beforePlan, plan, patch.changed_tracks);
    schemaService.assertValid('motionPlan', plan, '修订后的动作计划不符合受限 Motion DSL');
    gate = motionGateService.evaluate(plan, summary);
    const afterRelations = db.prepare('SELECT node_key, local_z, relation_json FROM paper_composition_nodes WHERE shot_id = ? AND deleted_at IS NULL ORDER BY id').all(Number(shot.id)).map((node) => ({ key: node.node_key, local_z: Number(node.local_z), relation: parseJson(node.relation_json, {}) }));
    afterHash = sha256(canonicalJson({ plan, relations: afterRelations }));
    if (afterHash === beforeHash) throw new PaperStudioError('PAPER_STUDIO_REVISION_NO_EFFECT', '这条修订没有产生可见动作或关系变化', { intent }, 422);
    const now = nowIso();
    db.prepare("UPDATE paper_motion_plans SET plan_json = ?, compiled_tracks_json = '{}', status = 'confirmed', version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(plan), now, Number(shot.motion_plan.id));
    const revisionCount = Number(summary.motion_revision_count || 0) + 1;
    const updatedSummary = { ...summary, motion_revision_count: revisionCount, last_motion_revision: { instruction: body.instruction, intent, after_hash: afterHash, at: now } };
    db.prepare(
      `UPDATE paper_studio_shots
       SET plan_summary_json = ?, status = ?, current_snapshot_id = NULL,
           approved_snapshot_id = NULL, last_error_json = '{}', version = version + 1,
           updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(updatedSummary), nextShotStatus(shot.status), now, Number(shot.id));
    db.prepare("UPDATE paper_render_snapshots SET status = 'superseded' WHERE shot_id = ? AND status IN ('compiled','approved')").run(Number(shot.id));
    db.prepare("UPDATE paper_proof_runs SET status = 'superseded' WHERE shot_id = ? AND status IN ('pending','running','passed','completed')").run(Number(shot.id));
    const steps = db.prepare('SELECT id, step_key FROM paper_job_steps WHERE shot_id = ?').all(Number(shot.id));
    for (const step of steps) {
      if (!DOWNSTREAM_STEPS.has(step.step_key)) continue;
      db.prepare("UPDATE paper_job_steps SET input_hash = ?, status = 'queued', attempt = 1, result_json = '{}', error_json = '{}', started_at = NULL, completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(sha256(canonicalJson({ revision_hash: afterHash, step_key: step.step_key })), now, Number(step.id));
    }
    db.prepare(
      `INSERT INTO paper_motion_revisions
        (shot_id, motion_plan_id, request_id, instruction, intent_json, before_hash,
         after_hash, patch_json, gate_report_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(Number(shot.id), Number(shot.motion_plan.id), body.request_id, body.instruction.trim(), JSON.stringify(intent), beforeHash, afterHash, JSON.stringify(patch), JSON.stringify(gate), gate.pass ? 'applied' : 'applied_gate_failed', now);
  });
  transaction();
  runAggregateService.sync(db, shot.run_id);
  const revision = list(db, shot.id)[0];
  if (log) log.info('Paper studio semantic motion revision applied', { shot_id: Number(shot.id), run_id: Number(shot.run_id), revision_id: revision.id, instruction: body.instruction, changed_tracks: patch.changed_tracks, relation_changes: patch.relation_changes.length, gate_pass: gate.pass });
  return { shot: shotService.get(db, shot.id), revision, gate, deduplicated: false };
}

module.exports = { ALLOWED_STATES, interpretInstruction, applyIntent, trackChangeSummary, list, revise };
