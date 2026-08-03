const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const storageLayout = require('../storageLayout');
const { canonicalJson, nowIso, parseJson, sha256 } = require('./paperStudioUtils');
const { sanitizeForReport } = require('./paperRunReportService');

const ARCHIVE_SCHEMA_VERSION = 2;
const SUPPORTED_ARCHIVE_SCHEMA_VERSIONS = new Set([1, ARCHIVE_SCHEMA_VERSION]);

function storageRoot(cfg) {
  const raw = cfg?.storage?.local_path || './data/storage';
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw));
}

function safeArtifact(root, localPath) {
  if (!localPath) return null;
  const absolute = path.resolve(root, String(localPath));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute;
}

function archiveBuilder(cfg, zip) {
  const root = storageRoot(cfg);
  const artifacts = [];
  const byHash = new Map();
  function add(localPath, kind) {
    const absolute = safeArtifact(root, localPath);
    if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
    const bytes = fs.readFileSync(absolute);
    const hash = sha256(bytes);
    let descriptor = byHash.get(hash);
    if (!descriptor) {
      const extension = path.extname(localPath) || '.bin';
      const archivePath = `paper-studio/artifacts/${hash.replace('sha256:', '')}${extension}`;
      descriptor = { archive_path: archivePath, hash, size: bytes.length, kind };
      byHash.set(hash, descriptor);
      artifacts.push(descriptor);
      zip.addFile(archivePath, bytes);
    }
    return descriptor;
  }
  return { add, artifacts };
}

function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(String(tableName)));
}

function columnExists(db, tableName, columnName) {
  return rows(db, `PRAGMA table_info(${tableName})`).some((column) => column.name === columnName);
}

function importedProvenance(raw, schemaVersion, importedReviewDecisionCount) {
  return JSON.stringify({
    ...parseJson(raw, {}),
    archive_import: {
      schema_version: Number(schemaVersion),
      import_trust_state: 'review_required',
      imported_review_decision_count: Number(importedReviewDecisionCount || 0),
    },
  });
}

function exportShot(db, shot, includeDiagnostics, addArtifact) {
  const families = rows(db, 'SELECT * FROM paper_source_families WHERE shot_id = ? ORDER BY id', [shot.id]).map((family) => ({
    ...family,
    slots: rows(db, 'SELECT * FROM paper_asset_slots WHERE family_id = ? ORDER BY id', [family.id]).map((slot) => ({
      ...slot,
      versions: rows(db, 'SELECT * FROM paper_asset_versions WHERE slot_id = ? ORDER BY id', [slot.id]).map((version) => ({
        ...version,
        source_file: addArtifact(version.source_local_path, 'asset_source'),
        alpha_file: addArtifact(version.alpha_local_path, 'asset_alpha'),
        mask_file: addArtifact(version.mask_local_path, 'asset_mask'),
      })),
    })),
  }));
  const snapshots = rows(db, 'SELECT * FROM paper_render_snapshots WHERE shot_id = ? ORDER BY id', [shot.id]).map((snapshot) => ({
    ...snapshot,
    snapshot_file: addArtifact(snapshot.local_path, 'snapshot'),
  }));
  const snapshotIds = snapshots.map((snapshot) => Number(snapshot.id));
  const proofRuns = snapshotIds.length ? rows(db, `SELECT * FROM paper_proof_runs WHERE shot_id = ? AND snapshot_id IN (${snapshotIds.map(() => '?').join(',')}) ORDER BY id`, [shot.id, ...snapshotIds]).map((proof) => ({
    ...proof,
    preview_file: addArtifact(proof.preview_local_path, proof.run_kind === 'preview' ? 'preview_video' : 'proof_bundle'),
    evidence: rows(db, 'SELECT * FROM paper_proof_evidence WHERE proof_run_id = ? ORDER BY id', [proof.id]).map((evidence) => ({
      ...evidence,
      full_file: addArtifact(evidence.full_local_path, 'proof_frame'),
      crop_file: addArtifact(evidence.crop_local_path, 'proof_crop'),
      debug_file: includeDiagnostics ? addArtifact(evidence.debug_local_path, 'proof_debug') : null,
    })),
  })) : [];
  const videos = rows(db, `SELECT * FROM video_generations
    WHERE paper_studio_shot_id = ? AND deleted_at IS NULL
      AND status = 'completed' AND generation_kind LIKE 'paper_studio%'
    ORDER BY id`, [shot.id]).map((video) => ({
    ...video,
    video_file: addArtifact(video.local_path, 'published_video'),
  }));
  return {
    ...shot,
    plan_revisions: rows(db, 'SELECT * FROM paper_plan_revisions WHERE shot_id = ? ORDER BY revision_number, id', [shot.id]),
    families,
    composition_nodes: rows(db, 'SELECT * FROM paper_composition_nodes WHERE shot_id = ? ORDER BY id', [shot.id]),
    motion_plans: rows(db, 'SELECT * FROM paper_motion_plans WHERE shot_id = ? ORDER BY id', [shot.id]),
    motion_plan: db.prepare('SELECT * FROM paper_motion_plans WHERE shot_id = ? AND plan_revision_id = ?').get(Number(shot.id), Number(shot.current_plan_revision_id)) || null,
    motion_revisions: rows(db, 'SELECT * FROM paper_motion_revisions WHERE shot_id = ? ORDER BY id', [shot.id]),
    snapshots,
    proof_runs: proofRuns,
    job_steps: rows(db, 'SELECT * FROM paper_job_steps WHERE shot_id = ? ORDER BY id', [shot.id]),
    asset_review_decisions: rows(db, 'SELECT * FROM paper_asset_review_decisions WHERE shot_id = ? ORDER BY id', [shot.id]),
    asset_reuse_links: rows(db, 'SELECT * FROM paper_asset_reuse_links WHERE target_shot_id = ? ORDER BY id', [shot.id]),
    asset_reuse_review_decisions: tableExists(db, 'paper_asset_reuse_review_decisions')
      ? rows(db, 'SELECT * FROM paper_asset_reuse_review_decisions WHERE shot_id = ? ORDER BY id', [shot.id])
      : [],
    continuity_repair_audits: rows(db, 'SELECT * FROM paper_continuity_repair_audits WHERE shot_id = ? ORDER BY id', [shot.id]),
    videos,
  };
}

function exportToZip(db, cfg, log, dramaId, zip, options = {}) {
  const project = db.prepare('SELECT * FROM paper_studio_projects WHERE drama_id = ? ORDER BY deleted_at IS NULL DESC, id DESC LIMIT 1').get(Number(dramaId));
  if (!project) return null;
  const includeDiagnostics = Boolean(options.include_diagnostics);
  const builder = archiveBuilder(cfg, zip);
  const hasForkAudits = tableExists(db, 'paper_history_fork_audits');
  const paperEpisodes = rows(db, 'SELECT * FROM paper_studio_episodes WHERE project_id = ? ORDER BY episode_number, id', [project.id]).map((episode) => ({
    ...episode,
    storyboards: rows(db, 'SELECT * FROM paper_storyboards WHERE paper_episode_id = ? ORDER BY shot_number, id', [episode.id]).map((storyboard) => ({
      ...storyboard,
      reference_file: builder.add(storyboard.reference_local_path, 'paper_storyboard_reference'),
      revisions: rows(db, 'SELECT * FROM paper_storyboard_revisions WHERE paper_storyboard_id = ? ORDER BY revision_number, id', [storyboard.id]),
      history_fork_audits: hasForkAudits
        ? rows(db, 'SELECT * FROM paper_history_fork_audits WHERE paper_storyboard_id = ? ORDER BY id', [storyboard.id])
        : [],
    })),
  }));
  const runs = rows(db, 'SELECT * FROM paper_studio_runs WHERE project_id = ? ORDER BY episode_id, run_number, id', [project.id]).map((run) => ({
    ...run,
    shots: rows(db, 'SELECT * FROM paper_studio_shots WHERE run_id = ? ORDER BY shot_index, id', [run.id])
      .map((shot) => exportShot(db, shot, includeDiagnostics, builder.add)),
    continuity: rows(db, 'SELECT * FROM paper_continuity_contracts WHERE run_id = ? ORDER BY id', [run.id]),
  }));
  const core = sanitizeForReport({
    schema_version: ARCHIVE_SCHEMA_VERSION,
    kind: 'local_mini_drama_paper_studio_archive',
    exported_at: nowIso(),
    source_drama_id: Number(dramaId),
    include_diagnostics: includeDiagnostics,
    project,
    paper_episodes: paperEpisodes,
    runs,
    artifacts: builder.artifacts,
  });
  const manifest = { ...core, manifest_hash: sha256(canonicalJson(core)) };
  zip.addFile('paper_studio_manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  if (log) log.info('Paper studio archive exported', { drama_id: Number(dramaId), runs: runs.length, artifacts: builder.artifacts.length, include_diagnostics: includeDiagnostics });
  return manifest;
}

function validateManifest(manifest) {
  if (!manifest || manifest.kind !== 'local_mini_drama_paper_studio_archive'
      || !SUPPORTED_ARCHIVE_SCHEMA_VERSIONS.has(Number(manifest.schema_version))) {
    throw new Error('纸片工作室 manifest 格式或版本不受支持');
  }
  const { manifest_hash: expected, ...core } = manifest;
  const actual = sha256(canonicalJson(core));
  if (!expected || actual !== expected) throw new Error('纸片工作室 manifest hash 校验失败');
}

function importArtifacts(cfg, files, manifest, dramaRow) {
  const root = storageRoot(cfg);
  const projectDir = storageLayout.buildProjectRelativeDir(dramaRow);
  const imported = new Map();
  for (const artifact of manifest.artifacts || []) {
    const bytes = files.get(artifact.archive_path);
    if (!bytes || Number(bytes.length) !== Number(artifact.size) || sha256(bytes) !== artifact.hash) {
      throw new Error(`纸片工作室 artifact 校验失败: ${artifact.archive_path}`);
    }
    const extension = path.extname(artifact.archive_path) || '.bin';
    const relative = `${projectDir}/paper-studio/imported/${artifact.hash.replace('sha256:', '')}${extension}`.replace(/\\/g, '/');
    const absolute = safeArtifact(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, bytes);
    imported.set(artifact.archive_path, relative);
  }
  return imported;
}

function artifactPath(imported, descriptor) {
  return descriptor?.archive_path ? imported.get(descriptor.archive_path) || null : null;
}

function paperCompatibilityId(id) {
  return -Math.abs(Number(id));
}

function importShot(db, runId, dramaId, episodeId, storyboardId, archived, imported, now, paperSource = null, context = {}) {
  const archiveVersion = Number(context.archiveVersion || 1);
  const error = JSON.stringify({ code: 'PAPER_STUDIO_IMPORTED_REVIEW_REQUIRED', message: '导入历史已保留，但源 ID 和审批信任域发生变化；请新建生产版本继续制作', at: now });
  const shotResult = db.prepare(`INSERT INTO paper_studio_shots
    (run_id,drama_id,episode_id,storyboard_id,paper_storyboard_id,paper_storyboard_revision_id,
     legacy_storyboard_id,source_kind,shot_index,source_revision_hash,semantic_contract_json,
     plan_summary_json,status,last_error_json,version,created_at,updated_at,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'stale',?,?,?,?,?)`)
    .run(
      runId, dramaId, episodeId, storyboardId,
      paperSource?.storyboardId || null, paperSource?.revisionId || null,
      paperSource ? null : storyboardId, paperSource ? 'paper' : 'legacy',
      Number(archived.shot_index || 0), archived.source_revision_hash,
      archived.semantic_contract_json || '{}', archived.plan_summary_json || '{}',
      error, Number(archived.version || 1),
      archiveVersion >= 2 ? (archived.created_at || now) : now,
      archiveVersion >= 2 ? (archived.updated_at || archived.created_at || now) : now,
      archiveVersion >= 2 ? (archived.deleted_at || null) : null,
    );
  const shotId = Number(shotResult.lastInsertRowid);
  const archivedPlans = archived.plan_revisions?.length ? archived.plan_revisions : [{
    id: Number(archived.current_plan_revision_id || 1),
    revision_number: 1,
    blueprint_revision_id: null,
    plan_hash: parseJson(archived.plan_summary_json, {}).plan_hash || sha256(canonicalJson({ imported_shot_id: archived.id })),
    status: 'superseded',
    transition_report_json: '{}',
    created_from: 'archive_import_legacy',
    created_at: now,
  }];
  const planMap = new Map();
  for (const plan of archivedPlans) {
    const planStatus = archiveVersion >= 2 ? (plan.status || 'superseded') : 'superseded';
    const planId = Number(db.prepare(`INSERT INTO paper_plan_revisions
      (shot_id,revision_number,blueprint_revision_id,plan_hash,status,transition_report_json,created_from,created_at,confirmed_at,superseded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      shotId, Number(plan.revision_number || planMap.size + 1), null,
      plan.plan_hash || sha256(canonicalJson({ archived_plan_id: plan.id, shot_id: shotId })),
      planStatus, plan.transition_report_json || '{}',
      archiveVersion >= 2 ? (plan.created_from || 'archive_import') : 'archive_import',
      archiveVersion >= 2 ? (plan.created_at || now) : now,
      archiveVersion >= 2 ? (plan.confirmed_at || null) : (plan.confirmed_at ? now : null),
      archiveVersion >= 2 ? (plan.superseded_at || null) : (plan.superseded_at ? now : null),
    ).lastInsertRowid);
    planMap.set(Number(plan.id), planId);
    context.planMap?.set(Number(plan.id), planId);
  }
  const fallbackPlanId = planMap.get(Number(archived.current_plan_revision_id)) || [...planMap.values()].at(-1);
  const familyMap = new Map();
  const slotMap = new Map();
  const versionMap = new Map();
  const importedDecisionCounts = new Map();
  for (const decision of archived.asset_review_decisions || []) {
    const key = Number(decision.asset_version_id);
    importedDecisionCounts.set(key, Number(importedDecisionCounts.get(key) || 0) + 1);
  }
  for (const family of archived.families || []) {
    const familyId = Number(db.prepare(`INSERT INTO paper_source_families
      (shot_id,plan_revision_id,family_key,pattern,registration_canvas_json,contract_json,context_snapshot_id,provider_signature,status,version,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      shotId, planMap.get(Number(family.plan_revision_id)) || fallbackPlanId,
      family.family_key, family.pattern, family.registration_canvas_json || '{}',
      family.contract_json || '{}', family.context_snapshot_id || null, family.provider_signature || null,
      archiveVersion >= 2 ? (family.status || 'superseded') : 'superseded', Number(family.version || 1),
      archiveVersion >= 2 ? (family.created_at || now) : now,
      archiveVersion >= 2 ? (family.updated_at || family.created_at || now) : now,
      archiveVersion >= 2 ? (family.deleted_at || null) : null,
    ).lastInsertRowid);
    familyMap.set(Number(family.id), familyId);
    context.familyMap?.set(Number(family.id), familyId);
    for (const slot of family.slots || []) {
      const slotId = Number(db.prepare(`INSERT INTO paper_asset_slots
        (family_id,slot_key,asset_type,generation_purpose,constraints_json,required_for_gate,reuse_fingerprint,status,version,created_at,updated_at,deleted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        familyId, slot.slot_key, slot.asset_type, slot.generation_purpose,
        slot.constraints_json || '{}', Number(slot.required_for_gate ?? 1), slot.reuse_fingerprint || null,
        archiveVersion >= 2 ? (slot.status || 'superseded') : 'superseded', Number(slot.version || 1),
        archiveVersion >= 2 ? (slot.created_at || now) : now,
        archiveVersion >= 2 ? (slot.updated_at || slot.created_at || now) : now,
        archiveVersion >= 2 ? (slot.deleted_at || null) : null,
      ).lastInsertRowid);
      slotMap.set(Number(slot.id), slotId);
      context.slotMap?.set(Number(slot.id), slotId);
      for (const version of slot.versions || []) {
        const sourcePath = artifactPath(imported, version.source_file);
        const alphaPath = artifactPath(imported, version.alpha_file);
        const maskPath = artifactPath(imported, version.mask_file);
        const versionId = Number(db.prepare(`INSERT INTO paper_asset_versions
          (slot_id,source_family_id,attempt_index,derivation_kind,source_local_path,alpha_local_path,mask_local_path,source_hash,alpha_hash,mask_hash,reuse_fingerprint,processing_json,registration_json,provenance_json,quality_report_json,status,created_at,accepted_at,rejected_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            slotId, familyId, Number(version.attempt_index || 1), version.derivation_kind || 'imported',
            sourcePath, alphaPath, maskPath, version.source_hash, version.alpha_hash, version.mask_hash,
            version.reuse_fingerprint || slot.reuse_fingerprint || null,
            version.processing_json || '{}', version.registration_json || '{}',
            importedProvenance(version.provenance_json, archiveVersion, importedDecisionCounts.get(Number(version.id)) || 0),
            version.quality_report_json || '{}', version.status || (archiveVersion >= 2 ? 'candidate' : 'accepted'),
            archiveVersion >= 2 ? (version.created_at || now) : (version.created_at || now),
            version.accepted_at || null, version.rejected_at || null,
          ).lastInsertRowid);
        versionMap.set(Number(version.id), versionId);
        context.versionMap?.set(Number(version.id), versionId);
        if (version.parent_version_id != null) {
          context.pendingVersionParents?.push({ versionId, sourceParentId: Number(version.parent_version_id) });
        }
      }
      const currentVersion = versionMap.get(Number(slot.current_version_id));
      if (currentVersion) db.prepare('UPDATE paper_asset_slots SET current_version_id = ? WHERE id = ?').run(currentVersion, slotId);
    }
    const layoutMaster = versionMap.get(Number(family.layout_master_version_id));
    if (layoutMaster) db.prepare('UPDATE paper_source_families SET layout_master_version_id = ? WHERE id = ?').run(layoutMaster, familyId);
  }
  for (const decision of archived.asset_review_decisions || []) {
    const assetVersionId = versionMap.get(Number(decision.asset_version_id));
    const slotId = slotMap.get(Number(decision.slot_id));
    if (!assetVersionId || !slotId) continue;
    db.prepare(`INSERT INTO paper_asset_review_decisions
      (shot_id,slot_id,asset_version_id,decision,reason,reviewer,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      shotId, slotId, assetVersionId, decision.decision, decision.reason || null,
      decision.reviewer || 'archive_unknown', decision.request_id || `archive:${randomUUID()}`,
      archiveVersion >= 2 ? (decision.created_at || now) : now,
    );
  }
  const nodeMap = new Map();
  const pendingNodes = [...(archived.composition_nodes || [])];
  while (pendingNodes.length) {
    const index = pendingNodes.findIndex((node) => node.parent_node_id == null || nodeMap.has(Number(node.parent_node_id)));
    if (index < 0) throw new Error('纸片工作室导入组合树存在循环或缺失父节点');
    const node = pendingNodes.splice(index, 1)[0];
    const nodeId = Number(db.prepare(`INSERT INTO paper_composition_nodes
      (shot_id,plan_revision_id,node_key,parent_node_id,node_kind,pattern,slot,asset_version_id,transform_json,relation_json,clip_json,local_z,status,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'superseded',1,?,?)`).run(shotId, planMap.get(Number(node.plan_revision_id)) || fallbackPlanId, node.node_key, node.parent_node_id == null ? null : nodeMap.get(Number(node.parent_node_id)), node.node_kind, node.pattern, node.slot, versionMap.get(Number(node.asset_version_id)) || null, node.transform_json || '{}', node.relation_json || '{}', node.clip_json || '{}', Number(node.local_z || 0), now, now).lastInsertRowid);
    nodeMap.set(Number(node.id), nodeId);
  }
  let motionPlanId = null;
  const archivedMotionPlans = archived.motion_plans?.length ? archived.motion_plans : (archived.motion_plan ? [archived.motion_plan] : []);
  for (const motionPlan of archivedMotionPlans) {
    const importedMotionPlanId = Number(db.prepare(`INSERT INTO paper_motion_plans
      (shot_id,plan_revision_id,schema_version,semantic_contract_hash,timing_hash,plan_json,compiled_tracks_json,status,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'superseded',1,?,?)`).run(shotId, planMap.get(Number(motionPlan.plan_revision_id)) || fallbackPlanId, Number(motionPlan.schema_version || 1), motionPlan.semantic_contract_hash, motionPlan.timing_hash, motionPlan.plan_json || '{}', motionPlan.compiled_tracks_json || '{}', now, now).lastInsertRowid);
    if ((planMap.get(Number(motionPlan.plan_revision_id)) || fallbackPlanId) === fallbackPlanId) motionPlanId = importedMotionPlanId;
  }
  const snapshotMap = new Map();
  for (const snapshot of archived.snapshots || []) {
    const localPath = artifactPath(imported, snapshot.snapshot_file);
    const snapshotId = Number(db.prepare(`INSERT INTO paper_render_snapshots
      (shot_id,schema_version,renderer_version,source_revision_hash,timing_hash,snapshot_json,snapshot_hash,render_hash,local_path,status,approved_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'stale',NULL,?)`).run(shotId, Number(snapshot.schema_version || 3), snapshot.renderer_version, snapshot.source_revision_hash, snapshot.timing_hash, snapshot.snapshot_json || '{}', snapshot.snapshot_hash, snapshot.render_hash, localPath, now).lastInsertRowid);
    snapshotMap.set(Number(snapshot.id), snapshotId);
  }
  const proofMap = new Map();
  for (const proof of archived.proof_runs || []) {
    const snapshotId = snapshotMap.get(Number(proof.snapshot_id));
    if (!snapshotId) continue;
    const proofId = Number(db.prepare(`INSERT INTO paper_proof_runs
      (shot_id,snapshot_id,run_kind,scale,status,preview_local_path,report_json,proof_hash,created_at,completed_at)
      VALUES (?,?,?,?,'imported',?,?,?,?,?)`).run(shotId, snapshotId, proof.run_kind, Number(proof.scale || 1), artifactPath(imported, proof.preview_file), proof.report_json || '{}', proof.proof_hash, now, now).lastInsertRowid);
    proofMap.set(Number(proof.id), proofId);
    for (const evidence of proof.evidence || []) {
      db.prepare(`INSERT INTO paper_proof_evidence
        (proof_run_id,target_key,frame,full_local_path,crop_local_path,debug_local_path,metrics_json,assertion_json,status,created_at)
        VALUES (?,?,?,?,?,?,?,?, 'imported',?)`).run(proofId, evidence.target_key, Number(evidence.frame || 0), artifactPath(imported, evidence.full_file), artifactPath(imported, evidence.crop_file), artifactPath(imported, evidence.debug_file), evidence.metrics_json || '{}', evidence.assertion_json || '{}', now);
    }
  }
  if (motionPlanId) {
    for (const revision of archived.motion_revisions || []) {
      db.prepare(`INSERT INTO paper_motion_revisions
        (shot_id,motion_plan_id,request_id,instruction,intent_json,before_hash,after_hash,patch_json,gate_report_json,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'imported',?)`).run(shotId, motionPlanId, `import:${randomUUID()}`, revision.instruction, revision.intent_json || '{}', revision.before_hash, revision.after_hash, revision.patch_json || '{}', revision.gate_report_json || '{}', now);
    }
  }
  for (const step of archived.job_steps || []) {
    db.prepare(`INSERT INTO paper_job_steps
      (run_id,shot_id,plan_revision_id,step_key,input_hash,depends_on_json,status,attempt,max_attempts,result_json,error_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'superseded',?,?,?, ?,?,?)`).run(runId, shotId, planMap.get(Number(step.plan_revision_id)) || fallbackPlanId, step.step_key, step.input_hash, step.depends_on_json || '[]', Number(step.attempt || 1), Number(step.max_attempts || 2), step.result_json || '{}', error, now, now);
  }
  db.prepare('UPDATE paper_studio_shots SET current_plan_revision_id = ? WHERE id = ?').run(fallbackPlanId, shotId);
  for (const link of archived.asset_reuse_links || []) context.pendingReuseLinks?.push({ link, shotId });
  for (const decision of archived.asset_reuse_review_decisions || []) {
    context.pendingReuseReviewDecisions?.push({ decision, runId, shotId });
  }
  for (const audit of archived.continuity_repair_audits || []) {
    const sourcePlanId = planMap.get(Number(audit.source_plan_revision_id));
    const targetPlanId = planMap.get(Number(audit.target_plan_revision_id));
    if (!sourcePlanId || !targetPlanId) continue;
    db.prepare(`INSERT INTO paper_continuity_repair_audits
      (shot_id,source_plan_revision_id,target_plan_revision_id,preview_fingerprint,
       asset_diff_json,gate_report_json,provider_call_count_before,provider_call_count_after,
       request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      shotId, sourcePlanId, targetPlanId, audit.preview_fingerprint,
      audit.asset_diff_json || '{}', audit.gate_report_json || '{}',
      Number(audit.provider_call_count_before || 0), Number(audit.provider_call_count_after || 0),
      audit.request_id || `archive:${randomUUID()}`,
      archiveVersion >= 2 ? (audit.created_at || now) : now,
    );
  }
  const videoMap = new Map();
  for (const video of archived.videos || []) {
    const videoPath = artifactPath(imported, video.video_file);
    if (!videoPath) continue;
    const videoId = Number(db.prepare(`INSERT INTO video_generations
      (drama_id,storyboard_id,paper_storyboard_id,provider,prompt,model,duration,aspect_ratio,
       video_url,local_path,status,generation_kind,render_hash,renderer_version,
       paper_studio_shot_id,paper_snapshot_id,created_at,updated_at,completed_at)
      VALUES (?,?,?,'imported-paper-studio',?,?,?,?,?,?,'completed','paper_studio_imported',?,?,?,?,?,?,?)`).run(
        dramaId, paperSource ? null : storyboardId, paperSource?.storyboardId || null,
        video.prompt, video.model, video.duration, video.aspect_ratio, `/static/${videoPath}`,
        videoPath, video.render_hash, video.renderer_version, shotId,
        snapshotMap.get(Number(video.paper_snapshot_id)) || null,
        archiveVersion >= 2 ? (video.created_at || now) : now,
        archiveVersion >= 2 ? (video.updated_at || video.created_at || now) : now,
        archiveVersion >= 2 ? (video.completed_at || null) : now,
      ).lastInsertRowid);
    videoMap.set(Number(video.id), videoId);
    context.videoMap?.set(Number(video.id), videoId);
  }
  if (archiveVersion >= 2) {
    const currentSnapshotId = snapshotMap.get(Number(archived.current_snapshot_id)) || null;
    const approvedSnapshotId = snapshotMap.get(Number(archived.approved_snapshot_id)) || null;
    const publishedVideoId = videoMap.get(Number(archived.published_video_generation_id)) || null;
    db.prepare(`UPDATE paper_studio_shots
      SET current_snapshot_id = ?, approved_snapshot_id = ?, published_video_generation_id = ?
      WHERE id = ?`).run(currentSnapshotId, approvedSnapshotId, publishedVideoId, shotId);
  }
  return { shotId, snapshotMap, videoMap };
}

function importFromManifest(db, cfg, log, { manifest, files, drama_id, episode_id_map, storyboard_id_map, drama_row }) {
  if (!manifest) return null;
  validateManifest(manifest);
  const imported = importArtifacts(cfg, files, manifest, drama_row);
  const now = nowIso();
  const archiveVersion = Number(manifest.schema_version || 1);
  const projectResult = db.prepare(`INSERT INTO paper_studio_projects
    (drama_id,schema_version,default_tier,config_json,status,version,created_at,updated_at)
    VALUES (?,3,?,?,'active',1,?,?)`).run(
    Number(drama_id), manifest.project?.default_tier || 'balanced',
    JSON.stringify({
      imported_manifest_hash: manifest.manifest_hash,
      imported_archive_schema_version: archiveVersion,
      import_trust_state: 'review_required',
    }),
    now, now,
  );
  const projectId = Number(projectResult.lastInsertRowid);
  const paperEpisodeMap = new Map();
  const paperStoryboardMap = new Map();
  const paperRevisionMap = new Map();
  const context = {
    archiveVersion,
    planMap: new Map(),
    familyMap: new Map(),
    slotMap: new Map(),
    versionMap: new Map(),
    videoMap: new Map(),
    pendingVersionParents: [],
    pendingReuseLinks: [],
    pendingReuseReviewDecisions: [],
    pendingForkAudits: [],
  };
  for (const archivedEpisode of manifest.paper_episodes || []) {
    const episodeId = Number(db.prepare(`INSERT INTO paper_studio_episodes
      (project_id,request_id,episode_number,title,description,aspect_ratio,fps,default_duration,status,version,created_at,updated_at,deleted_at)
      VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?)`).run(
        projectId, Number(archivedEpisode.episode_number || paperEpisodeMap.size + 1),
        archivedEpisode.title || `纸片分集 ${paperEpisodeMap.size + 1}`, archivedEpisode.description || '',
        archivedEpisode.aspect_ratio || '16:9', Number(archivedEpisode.fps || 30),
        Number(archivedEpisode.default_duration || 6),
        archiveVersion >= 2 ? (archivedEpisode.status || 'archived') : 'archived',
        Number(archivedEpisode.version || 1),
        archiveVersion >= 2 ? (archivedEpisode.created_at || now) : now,
        archiveVersion >= 2 ? (archivedEpisode.updated_at || archivedEpisode.created_at || now) : now,
        archiveVersion >= 2 ? (archivedEpisode.deleted_at || null) : null,
      ).lastInsertRowid);
    paperEpisodeMap.set(Number(archivedEpisode.id), episodeId);
    for (const archivedStoryboard of archivedEpisode.storyboards || []) {
      const referencePath = artifactPath(imported, archivedStoryboard.reference_file);
      const storyboardId = Number(db.prepare(`INSERT INTO paper_storyboards
        (paper_episode_id,request_id,shot_number,title,description,action,dialogue,narration,
         duration,shot_type,camera_motion,visual_prompt,negative_prompt,status,
         reference_image_url,reference_local_path,legacy_storyboard_id,source_kind,
         version,created_at,updated_at,deleted_at)
        VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          episodeId, Number(archivedStoryboard.shot_number || 1), archivedStoryboard.title || '导入分镜',
          archivedStoryboard.description || '', archivedStoryboard.action || '', archivedStoryboard.dialogue || '',
          archivedStoryboard.narration || '', Number(archivedStoryboard.duration || 6),
          archivedStoryboard.shot_type || null, archivedStoryboard.camera_motion || null,
          archivedStoryboard.visual_prompt || '', archivedStoryboard.negative_prompt || '',
          archiveVersion >= 2 ? (archivedStoryboard.status || 'archived') : 'archived',
          archivedStoryboard.reference_image_url || null, referencePath,
          null, 'paper', Number(archivedStoryboard.version || 1),
          archiveVersion >= 2 ? (archivedStoryboard.created_at || now) : now,
          archiveVersion >= 2 ? (archivedStoryboard.updated_at || archivedStoryboard.created_at || now) : now,
          archiveVersion >= 2 ? (archivedStoryboard.deleted_at || null) : null,
        ).lastInsertRowid);
      paperStoryboardMap.set(Number(archivedStoryboard.id), storyboardId);
      let currentRevisionId = null;
      for (const archivedRevision of archivedStoryboard.revisions || []) {
        const content = parseJson(archivedRevision.content_json, {});
        content.paper_storyboard_id = storyboardId;
        content.paper_episode_id = episodeId;
        if (referencePath) content.reference_local_path = referencePath;
        const contentJson = canonicalJson(content);
        const revisionId = Number(db.prepare(`INSERT INTO paper_storyboard_revisions
          (paper_storyboard_id,revision_number,content_json,content_hash,created_from,created_at)
          VALUES (?,?,?,?,?,?)`).run(
            storyboardId, Number(archivedRevision.revision_number || 1), contentJson,
            sha256(contentJson),
            archiveVersion >= 2 ? (archivedRevision.created_from || 'archive_import') : 'archive_import_legacy',
            archiveVersion >= 2 ? (archivedRevision.created_at || now) : now,
          ).lastInsertRowid);
        paperRevisionMap.set(Number(archivedRevision.id), revisionId);
        if (Number(archivedStoryboard.current_revision_id) === Number(archivedRevision.id)) currentRevisionId = revisionId;
      }
      if (currentRevisionId) db.prepare('UPDATE paper_storyboards SET current_revision_id = ? WHERE id = ?').run(currentRevisionId, storyboardId);
      for (const audit of archivedStoryboard.history_fork_audits || []) {
        context.pendingForkAudits.push({ audit, storyboardId });
      }
    }
  }
  const runMap = new Map();
  const shotMap = new Map();
  context.runMap = runMap;
  context.shotMap = shotMap;
  for (const archivedRun of manifest.runs || []) {
    const paperEpisodeId = archivedRun.paper_episode_id == null ? null : paperEpisodeMap.get(Number(archivedRun.paper_episode_id));
    const episodeId = paperEpisodeId || episode_id_map.get(Number(archivedRun.legacy_episode_id || archivedRun.episode_id));
    if (!episodeId) continue;
    const compatibilityEpisodeId = paperEpisodeId ? paperCompatibilityId(paperEpisodeId) : episodeId;
    const selected = (archivedRun.shots || []).map((shot) => (
      paperEpisodeId
        ? paperStoryboardMap.get(Number(shot.paper_storyboard_id))
        : storyboard_id_map.get(Number(shot.legacy_storyboard_id || shot.storyboard_id))
    )).filter(Boolean);
    const runId = Number(db.prepare(`INSERT INTO paper_studio_runs
      (project_id,drama_id,episode_id,paper_episode_id,legacy_episode_id,run_number,
       request_id,selection_json,quality_tier,style_signature,source_revision_hash,
       budget_json,status,progress,last_error_json,version,created_at,updated_at,completed_at,deleted_at)
      VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,'stale',?,?,?,?,?,?,?)`).run(
        projectId, Number(drama_id), compatibilityEpisodeId, paperEpisodeId,
        paperEpisodeId ? null : episodeId, Number(archivedRun.run_number || 1),
        JSON.stringify(paperEpisodeId
          ? { paper_storyboard_ids: selected, source_kind: 'paper', image_provider_config_id: null }
          : { storyboard_ids: selected, image_provider_config_id: null }),
        archivedRun.quality_tier || 'balanced', archivedRun.style_signature,
        archivedRun.source_revision_hash, archivedRun.budget_json || '{}',
        Number(archivedRun.progress || 0),
        JSON.stringify({ code: 'PAPER_STUDIO_IMPORTED_REVIEW_REQUIRED', message: '导入生产历史不可直接继续执行' }),
        Number(archivedRun.version || 1),
        archiveVersion >= 2 ? (archivedRun.created_at || now) : now,
        archiveVersion >= 2 ? (archivedRun.updated_at || archivedRun.created_at || now) : now,
        archiveVersion >= 2 ? (archivedRun.completed_at || null) : null,
        archiveVersion >= 2 ? (archivedRun.deleted_at || null) : null,
      ).lastInsertRowid);
    runMap.set(Number(archivedRun.id), runId);
    for (const archivedShot of archivedRun.shots || []) {
      const storyboardId = paperEpisodeId
        ? paperStoryboardMap.get(Number(archivedShot.paper_storyboard_id))
        : storyboard_id_map.get(Number(archivedShot.legacy_storyboard_id || archivedShot.storyboard_id));
      if (!storyboardId) continue;
      const paperSource = paperEpisodeId ? {
        storyboardId,
        revisionId: paperRevisionMap.get(Number(archivedShot.paper_storyboard_revision_id)) || null,
      } : null;
      const compatibilityStoryboardId = paperSource ? paperCompatibilityId(storyboardId) : storyboardId;
      const importedShot = importShot(
        db, runId, Number(drama_id), compatibilityEpisodeId, compatibilityStoryboardId,
        archivedShot, imported, now, paperSource, context,
      );
      shotMap.set(Number(archivedShot.id), importedShot.shotId);
    }
  }
  for (const pending of context.pendingVersionParents) {
    const parentVersionId = context.versionMap.get(Number(pending.sourceParentId));
    if (parentVersionId) {
      db.prepare('UPDATE paper_asset_versions SET parent_version_id = ? WHERE id = ?')
        .run(parentVersionId, Number(pending.versionId));
    }
  }
  for (const pending of context.pendingReuseLinks) {
    const { link } = pending;
    const sourceVersionId = context.versionMap.get(Number(link.source_asset_version_id));
    const targetVersionId = context.versionMap.get(Number(link.target_asset_version_id));
    const targetSlotId = context.slotMap.get(Number(link.target_slot_id));
    if (!sourceVersionId || !targetVersionId || !targetSlotId) continue;
    db.prepare(`INSERT INTO paper_asset_reuse_links
      (source_asset_version_id,target_asset_version_id,target_shot_id,target_slot_id,
       match_kind,compatibility_report_json,source_file_hash,preview_fingerprint,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      sourceVersionId, targetVersionId, Number(pending.shotId), targetSlotId,
      link.match_kind || 'exact', link.compatibility_report_json || '{}', link.source_file_hash,
      link.preview_fingerprint || null, link.request_id || null,
      archiveVersion >= 2 ? (link.created_at || now) : now,
    );
  }
  if (context.pendingReuseReviewDecisions.length) {
    if (!tableExists(db, 'paper_asset_reuse_review_decisions')) {
      throw new Error('纸片工作室 archive v2 包含历史复用选择，请先执行 migration 45');
    }
    for (const pending of context.pendingReuseReviewDecisions) {
      const { decision } = pending;
      const targetSlotId = context.slotMap.get(Number(decision.target_slot_id));
      const sourceVersionId = context.versionMap.get(Number(decision.source_asset_version_id));
      if (!targetSlotId || !sourceVersionId) continue;
      db.prepare(`INSERT INTO paper_asset_reuse_review_decisions
        (run_id,shot_id,target_slot_id,source_asset_version_id,decision,reason,actor,
         preview_fingerprint,request_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        Number(pending.runId), Number(pending.shotId), targetSlotId, sourceVersionId,
        decision.decision, decision.reason, decision.actor,
        decision.preview_fingerprint, decision.request_id,
        archiveVersion >= 2 ? (decision.created_at || now) : now,
      );
    }
  }
  for (const archivedRun of manifest.runs || []) {
    const runId = runMap.get(Number(archivedRun.id));
    if (!runId) continue;
    for (const contract of archivedRun.continuity || []) {
      const sourceShotId = shotMap.get(Number(contract.source_shot_id));
      const targetShotId = shotMap.get(Number(contract.target_shot_id));
      if (!sourceShotId || !targetShotId) continue;
      db.prepare(`INSERT INTO paper_continuity_contracts
        (run_id,source_shot_id,target_shot_id,continuity_key,subject_signature,contract_json,report_json,status,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        runId, sourceShotId, targetShotId, contract.continuity_key, contract.subject_signature,
        contract.contract_json || '{}', contract.report_json || '{}',
        archiveVersion >= 2 ? (contract.status || 'imported') : 'imported', Number(contract.version || 1),
        archiveVersion >= 2 ? (contract.created_at || now) : now,
        archiveVersion >= 2 ? (contract.updated_at || contract.created_at || now) : now,
      );
    }
  }
  if (context.pendingForkAudits.length) {
    if (!tableExists(db, 'paper_history_fork_audits')) {
      throw new Error('纸片工作室 archive v2 包含分镜派生审计，请先执行 migration 45');
    }
    const forkAuditMap = new Map();
    for (const pending of context.pendingForkAudits) {
      const { audit } = pending;
      const sourceRevisionId = paperRevisionMap.get(Number(audit.source_storyboard_revision_id));
      if (!sourceRevisionId) continue;
      const result = db.prepare(`INSERT INTO paper_history_fork_audits
        (paper_storyboard_id,source_kind,source_storyboard_revision_id,source_run_id,
         source_shot_id,source_plan_revision_id,target_mode,target_storyboard_revision_id,
         target_run_id,target_shot_id,target_plan_revision_id,status,impact_json,
         preview_fingerprint,provider_call_count_before,provider_call_count_after,
         request_id,created_at,completed_at,failed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        Number(pending.storyboardId), audit.source_kind, sourceRevisionId,
        audit.source_run_id == null ? null : (runMap.get(Number(audit.source_run_id)) || null),
        audit.source_shot_id == null ? null : (shotMap.get(Number(audit.source_shot_id)) || null),
        audit.source_plan_revision_id == null ? null : (context.planMap.get(Number(audit.source_plan_revision_id)) || null),
        audit.target_mode,
        audit.target_storyboard_revision_id == null ? null : (paperRevisionMap.get(Number(audit.target_storyboard_revision_id)) || null),
        audit.target_run_id == null ? null : (runMap.get(Number(audit.target_run_id)) || null),
        audit.target_shot_id == null ? null : (shotMap.get(Number(audit.target_shot_id)) || null),
        audit.target_plan_revision_id == null ? null : (context.planMap.get(Number(audit.target_plan_revision_id)) || null),
        audit.status || 'previewed', audit.impact_json || '{}', audit.preview_fingerprint,
        Number(audit.provider_call_count_before || 0), Number(audit.provider_call_count_after || 0),
        audit.request_id, audit.created_at || now, audit.completed_at || null, audit.failed_at || null,
      );
      forkAuditMap.set(Number(audit.id), Number(result.lastInsertRowid));
    }
    if (columnExists(db, 'paper_storyboards', 'working_copy_base_revision_id')) {
      for (const archivedEpisode of manifest.paper_episodes || []) {
        for (const archivedStoryboard of archivedEpisode.storyboards || []) {
          const storyboardId = paperStoryboardMap.get(Number(archivedStoryboard.id));
          if (!storyboardId) continue;
          const baseRevisionId = paperRevisionMap.get(Number(archivedStoryboard.working_copy_base_revision_id)) || null;
          const forkAuditId = forkAuditMap.get(Number(archivedStoryboard.working_copy_fork_audit_id)) || null;
          db.prepare(`UPDATE paper_storyboards
            SET working_copy_base_revision_id = ?, working_copy_fork_audit_id = ? WHERE id = ?`)
            .run(baseRevisionId, forkAuditId, storyboardId);
        }
      }
    }
  }
  if (archiveVersion >= 2) {
    for (const archivedEpisode of manifest.paper_episodes || []) {
      for (const archivedStoryboard of archivedEpisode.storyboards || []) {
        const storyboardId = paperStoryboardMap.get(Number(archivedStoryboard.id));
        const publishedVideoId = context.videoMap.get(Number(archivedStoryboard.published_video_generation_id)) || null;
        if (storyboardId && publishedVideoId) {
          db.prepare('UPDATE paper_storyboards SET published_video_generation_id = ? WHERE id = ?')
            .run(publishedVideoId, storyboardId);
        }
      }
    }
  }
  if (log) log.info('Paper studio archive imported', { drama_id: Number(drama_id), runs: runMap.size, shots: shotMap.size, artifacts: imported.size });
  return { project_id: projectId, paper_episodes: paperEpisodeMap.size, paper_storyboards: paperStoryboardMap.size, runs: runMap.size, shots: shotMap.size, artifacts: imported.size, manifest_hash: manifest.manifest_hash };
}

function softDeleteForDrama(db, dramaId, now = nowIso()) {
  const hasProjectTable = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'paper_studio_projects'").get();
  if (!hasProjectTable) return { projects: 0, paper_episodes: 0, paper_storyboards: 0, runs: 0, shots: 0, families: 0, slots: 0, nodes: 0, steps: 0 };
  const project = db.prepare('SELECT id FROM paper_studio_projects WHERE drama_id = ? AND deleted_at IS NULL').get(Number(dramaId));
  if (!project) return { projects: 0, paper_episodes: 0, paper_storyboards: 0, runs: 0, shots: 0, families: 0, slots: 0, nodes: 0, steps: 0 };
  const runIds = rows(db, 'SELECT id FROM paper_studio_runs WHERE project_id = ? AND deleted_at IS NULL', [project.id]).map((row) => Number(row.id));
  const shotIds = runIds.length ? rows(db, `SELECT id FROM paper_studio_shots WHERE run_id IN (${runIds.map(() => '?').join(',')}) AND deleted_at IS NULL`, runIds).map((row) => Number(row.id)) : [];
  const familyIds = shotIds.length ? rows(db, `SELECT id FROM paper_source_families WHERE shot_id IN (${shotIds.map(() => '?').join(',')}) AND deleted_at IS NULL`, shotIds).map((row) => Number(row.id)) : [];
  const counts = { projects: 0, paper_episodes: 0, paper_storyboards: 0, runs: 0, shots: 0, families: 0, slots: 0, nodes: 0, steps: 0 };
  if (familyIds.length) counts.slots = db.prepare(`UPDATE paper_asset_slots SET deleted_at = ?, status = 'cancelled' WHERE family_id IN (${familyIds.map(() => '?').join(',')}) AND deleted_at IS NULL`).run(now, ...familyIds).changes;
  if (shotIds.length) {
    counts.nodes = db.prepare(`UPDATE paper_composition_nodes SET deleted_at = ?, status = 'cancelled' WHERE shot_id IN (${shotIds.map(() => '?').join(',')}) AND deleted_at IS NULL`).run(now, ...shotIds).changes;
    counts.families = db.prepare(`UPDATE paper_source_families SET deleted_at = ?, status = 'cancelled' WHERE shot_id IN (${shotIds.map(() => '?').join(',')}) AND deleted_at IS NULL`).run(now, ...shotIds).changes;
    counts.steps = db.prepare(`UPDATE paper_job_steps SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE shot_id IN (${shotIds.map(() => '?').join(',')}) AND status != 'cancelled'`).run(now, ...shotIds).changes;
    db.prepare(`UPDATE paper_render_snapshots SET status = 'archived' WHERE shot_id IN (${shotIds.map(() => '?').join(',')})`).run(...shotIds);
    db.prepare(`UPDATE paper_proof_runs SET status = 'archived' WHERE shot_id IN (${shotIds.map(() => '?').join(',')})`).run(...shotIds);
    counts.shots = db.prepare(`UPDATE paper_studio_shots SET deleted_at = ?, status = 'cancelled', updated_at = ? WHERE id IN (${shotIds.map(() => '?').join(',')}) AND deleted_at IS NULL`).run(now, now, ...shotIds).changes;
  }
  if (runIds.length) {
    db.prepare(`UPDATE paper_continuity_contracts SET status = 'archived', updated_at = ? WHERE run_id IN (${runIds.map(() => '?').join(',')})`).run(now, ...runIds);
    counts.runs = db.prepare(`UPDATE paper_studio_runs SET deleted_at = ?, status = 'cancelled', updated_at = ? WHERE id IN (${runIds.map(() => '?').join(',')}) AND deleted_at IS NULL`).run(now, now, ...runIds).changes;
  }
  counts.paper_storyboards = db.prepare(`UPDATE paper_storyboards SET deleted_at = ?, updated_at = ?
    WHERE paper_episode_id IN (SELECT id FROM paper_studio_episodes WHERE project_id = ? AND deleted_at IS NULL)
      AND deleted_at IS NULL`).run(now, now, Number(project.id)).changes;
  counts.paper_episodes = db.prepare("UPDATE paper_studio_episodes SET deleted_at = ?, status = 'archived', updated_at = ? WHERE project_id = ? AND deleted_at IS NULL")
    .run(now, now, Number(project.id)).changes;
  counts.projects = db.prepare("UPDATE paper_studio_projects SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, Number(project.id)).changes;
  return counts;
}

module.exports = {
  ARCHIVE_SCHEMA_VERSION,
  exportToZip,
  validateManifest,
  importFromManifest,
  softDeleteForDrama,
};
