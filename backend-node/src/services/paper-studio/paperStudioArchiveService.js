const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const storageLayout = require('../storageLayout');
const { canonicalJson, nowIso, parseJson, sha256 } = require('./paperStudioUtils');
const { sanitizeForReport } = require('./paperRunReportService');

const ARCHIVE_SCHEMA_VERSION = 1;

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

function exportShot(db, shot, includeDiagnostics, addArtifact) {
  const families = rows(db, 'SELECT * FROM paper_source_families WHERE shot_id = ? AND deleted_at IS NULL ORDER BY id', [shot.id]).map((family) => ({
    ...family,
    slots: rows(db, 'SELECT * FROM paper_asset_slots WHERE family_id = ? AND deleted_at IS NULL ORDER BY id', [family.id]).map((slot) => ({
      ...slot,
      versions: rows(db, `SELECT * FROM paper_asset_versions WHERE slot_id = ? ${includeDiagnostics ? '' : "AND status = 'accepted'"} ORDER BY id`, [slot.id]).map((version) => ({
        ...version,
        source_file: addArtifact(version.source_local_path, 'asset_source'),
        alpha_file: addArtifact(version.alpha_local_path, 'asset_alpha'),
        mask_file: addArtifact(version.mask_local_path, 'asset_mask'),
      })),
    })),
  }));
  const snapshots = rows(db, `SELECT * FROM paper_render_snapshots WHERE shot_id = ? ${includeDiagnostics ? '' : "AND status IN ('approved','rendered','published')"} ORDER BY id`, [shot.id]).map((snapshot) => ({
    ...snapshot,
    snapshot_file: addArtifact(snapshot.local_path, 'snapshot'),
  }));
  const snapshotIds = snapshots.map((snapshot) => Number(snapshot.id));
  const proofRuns = snapshotIds.length ? rows(db, `SELECT * FROM paper_proof_runs WHERE shot_id = ? AND snapshot_id IN (${snapshotIds.map(() => '?').join(',')}) ${includeDiagnostics ? '' : "AND status IN ('passed','completed')"} ORDER BY id`, [shot.id, ...snapshotIds]).map((proof) => ({
    ...proof,
    preview_file: addArtifact(proof.preview_local_path, proof.run_kind === 'preview' ? 'preview_video' : 'proof_bundle'),
    evidence: rows(db, 'SELECT * FROM paper_proof_evidence WHERE proof_run_id = ? ORDER BY id', [proof.id]).map((evidence) => ({
      ...evidence,
      full_file: addArtifact(evidence.full_local_path, 'proof_frame'),
      crop_file: addArtifact(evidence.crop_local_path, 'proof_crop'),
      debug_file: addArtifact(evidence.debug_local_path, 'proof_debug'),
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
    families,
    composition_nodes: rows(db, 'SELECT * FROM paper_composition_nodes WHERE shot_id = ? AND deleted_at IS NULL ORDER BY id', [shot.id]),
    motion_plan: db.prepare('SELECT * FROM paper_motion_plans WHERE shot_id = ?').get(Number(shot.id)) || null,
    motion_revisions: rows(db, 'SELECT * FROM paper_motion_revisions WHERE shot_id = ? ORDER BY id', [shot.id]),
    snapshots,
    proof_runs: proofRuns,
    job_steps: rows(db, 'SELECT * FROM paper_job_steps WHERE shot_id = ? ORDER BY id', [shot.id]),
    videos,
  };
}

function exportToZip(db, cfg, log, dramaId, zip, options = {}) {
  const project = db.prepare('SELECT * FROM paper_studio_projects WHERE drama_id = ? AND deleted_at IS NULL').get(Number(dramaId));
  if (!project) return null;
  const includeDiagnostics = Boolean(options.include_diagnostics);
  const builder = archiveBuilder(cfg, zip);
  const paperEpisodes = rows(db, 'SELECT * FROM paper_studio_episodes WHERE project_id = ? AND deleted_at IS NULL ORDER BY episode_number, id', [project.id]).map((episode) => ({
    ...episode,
    storyboards: rows(db, 'SELECT * FROM paper_storyboards WHERE paper_episode_id = ? AND deleted_at IS NULL ORDER BY shot_number, id', [episode.id]).map((storyboard) => ({
      ...storyboard,
      reference_file: builder.add(storyboard.reference_local_path, 'paper_storyboard_reference'),
      revisions: rows(db, 'SELECT * FROM paper_storyboard_revisions WHERE paper_storyboard_id = ? ORDER BY revision_number, id', [storyboard.id]),
    })),
  }));
  const runs = rows(db, 'SELECT * FROM paper_studio_runs WHERE project_id = ? AND deleted_at IS NULL ORDER BY episode_id, run_number', [project.id]).map((run) => ({
    ...run,
    shots: rows(db, 'SELECT * FROM paper_studio_shots WHERE run_id = ? AND deleted_at IS NULL ORDER BY shot_index, id', [run.id])
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
  if (!manifest || manifest.kind !== 'local_mini_drama_paper_studio_archive' || Number(manifest.schema_version) !== ARCHIVE_SCHEMA_VERSION) {
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

function importShot(db, runId, dramaId, episodeId, storyboardId, archived, imported, now, paperSource = null) {
  const error = JSON.stringify({ code: 'PAPER_STUDIO_IMPORTED_REVIEW_REQUIRED', message: '导入历史已保留，但源 ID 和审批信任域发生变化；请新建生产版本继续制作', at: now });
  const shotResult = db.prepare(`INSERT INTO paper_studio_shots
    (run_id,drama_id,episode_id,storyboard_id,paper_storyboard_id,paper_storyboard_revision_id,
     legacy_storyboard_id,source_kind,shot_index,source_revision_hash,semantic_contract_json,
     plan_summary_json,status,last_error_json,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'stale',?,1,?,?)`)
    .run(
      runId, dramaId, episodeId, storyboardId,
      paperSource?.storyboardId || null, paperSource?.revisionId || null,
      paperSource ? null : storyboardId, paperSource ? 'paper' : 'legacy',
      Number(archived.shot_index || 0), archived.source_revision_hash,
      archived.semantic_contract_json || '{}', archived.plan_summary_json || '{}',
      error, now, now,
    );
  const shotId = Number(shotResult.lastInsertRowid);
  const familyMap = new Map();
  const slotMap = new Map();
  const versionMap = new Map();
  for (const family of archived.families || []) {
    const familyId = Number(db.prepare(`INSERT INTO paper_source_families
      (shot_id,family_key,pattern,registration_canvas_json,contract_json,context_snapshot_id,provider_signature,status,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'ready',1,?,?)`).run(shotId, family.family_key, family.pattern, family.registration_canvas_json || '{}', family.contract_json || '{}', family.context_snapshot_id || null, family.provider_signature || null, now, now).lastInsertRowid);
    familyMap.set(Number(family.id), familyId);
    for (const slot of family.slots || []) {
      const slotId = Number(db.prepare(`INSERT INTO paper_asset_slots
        (family_id,slot_key,asset_type,generation_purpose,constraints_json,required_for_gate,status,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?, 'ready',1,?,?)`).run(familyId, slot.slot_key, slot.asset_type, slot.generation_purpose, slot.constraints_json || '{}', Number(slot.required_for_gate ?? 1), now, now).lastInsertRowid);
      slotMap.set(Number(slot.id), slotId);
      for (const version of slot.versions || []) {
        const sourcePath = artifactPath(imported, version.source_file);
        const alphaPath = artifactPath(imported, version.alpha_file);
        const maskPath = artifactPath(imported, version.mask_file);
        const versionId = Number(db.prepare(`INSERT INTO paper_asset_versions
          (slot_id,source_family_id,attempt_index,derivation_kind,source_local_path,alpha_local_path,mask_local_path,source_hash,alpha_hash,mask_hash,processing_json,registration_json,provenance_json,quality_report_json,status,created_at,accepted_at,rejected_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?,NULL)`)
          .run(slotId, familyId, Number(version.attempt_index || 1), version.derivation_kind || 'imported', sourcePath, alphaPath, maskPath, version.source_hash, version.alpha_hash, version.mask_hash, version.processing_json || '{}', version.registration_json || '{}', version.provenance_json || '{}', version.quality_report_json || '{}', now, now).lastInsertRowid);
        versionMap.set(Number(version.id), versionId);
      }
      const currentVersion = versionMap.get(Number(slot.current_version_id));
      if (currentVersion) db.prepare('UPDATE paper_asset_slots SET current_version_id = ? WHERE id = ?').run(currentVersion, slotId);
    }
    const layoutMaster = versionMap.get(Number(family.layout_master_version_id));
    if (layoutMaster) db.prepare('UPDATE paper_source_families SET layout_master_version_id = ? WHERE id = ?').run(layoutMaster, familyId);
  }
  const nodeMap = new Map();
  const pendingNodes = [...(archived.composition_nodes || [])];
  while (pendingNodes.length) {
    const index = pendingNodes.findIndex((node) => node.parent_node_id == null || nodeMap.has(Number(node.parent_node_id)));
    if (index < 0) throw new Error('纸片工作室导入组合树存在循环或缺失父节点');
    const node = pendingNodes.splice(index, 1)[0];
    const nodeId = Number(db.prepare(`INSERT INTO paper_composition_nodes
      (shot_id,node_key,parent_node_id,node_kind,pattern,slot,asset_version_id,transform_json,relation_json,clip_json,local_z,status,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'stale',1,?,?)`).run(shotId, node.node_key, node.parent_node_id == null ? null : nodeMap.get(Number(node.parent_node_id)), node.node_kind, node.pattern, node.slot, versionMap.get(Number(node.asset_version_id)) || null, node.transform_json || '{}', node.relation_json || '{}', node.clip_json || '{}', Number(node.local_z || 0), now, now).lastInsertRowid);
    nodeMap.set(Number(node.id), nodeId);
  }
  let motionPlanId = null;
  if (archived.motion_plan) {
    motionPlanId = Number(db.prepare(`INSERT INTO paper_motion_plans
      (shot_id,schema_version,semantic_contract_hash,timing_hash,plan_json,compiled_tracks_json,status,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'draft',1,?,?)`).run(shotId, Number(archived.motion_plan.schema_version || 1), archived.motion_plan.semantic_contract_hash, archived.motion_plan.timing_hash, archived.motion_plan.plan_json || '{}', archived.motion_plan.compiled_tracks_json || '{}', now, now).lastInsertRowid);
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
      (run_id,shot_id,step_key,input_hash,depends_on_json,status,attempt,max_attempts,result_json,error_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'cancelled',?,?,?, ?,?,?)`).run(runId, shotId, step.step_key, step.input_hash, step.depends_on_json || '[]', Number(step.attempt || 1), Number(step.max_attempts || 2), step.result_json || '{}', error, now, now);
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
        snapshotMap.get(Number(video.paper_snapshot_id)) || null, now, now, now,
      ).lastInsertRowid);
    videoMap.set(Number(video.id), videoId);
  }
  return { shotId, snapshotMap, videoMap };
}

function importFromManifest(db, cfg, log, { manifest, files, drama_id, episode_id_map, storyboard_id_map, drama_row }) {
  if (!manifest) return null;
  validateManifest(manifest);
  const imported = importArtifacts(cfg, files, manifest, drama_row);
  const now = nowIso();
  const projectResult = db.prepare(`INSERT INTO paper_studio_projects
    (drama_id,schema_version,default_tier,config_json,status,version,created_at,updated_at)
    VALUES (?,3,?,?,'active',1,?,?)`).run(Number(drama_id), manifest.project?.default_tier || 'balanced', JSON.stringify({ imported_manifest_hash: manifest.manifest_hash }), now, now);
  const projectId = Number(projectResult.lastInsertRowid);
  const paperEpisodeMap = new Map();
  const paperStoryboardMap = new Map();
  const paperRevisionMap = new Map();
  for (const archivedEpisode of manifest.paper_episodes || []) {
    const episodeId = Number(db.prepare(`INSERT INTO paper_studio_episodes
      (project_id,request_id,episode_number,title,description,aspect_ratio,fps,default_duration,status,version,created_at,updated_at)
      VALUES (?,NULL,?,?,?,?,?,?,?,1,?,?)`).run(
        projectId, Number(archivedEpisode.episode_number || paperEpisodeMap.size + 1),
        archivedEpisode.title || `纸片分集 ${paperEpisodeMap.size + 1}`, archivedEpisode.description || '',
        archivedEpisode.aspect_ratio || '16:9', Number(archivedEpisode.fps || 30),
        Number(archivedEpisode.default_duration || 6), 'archived', now, now,
      ).lastInsertRowid);
    paperEpisodeMap.set(Number(archivedEpisode.id), episodeId);
    for (const archivedStoryboard of archivedEpisode.storyboards || []) {
      const referencePath = artifactPath(imported, archivedStoryboard.reference_file);
      const storyboardId = Number(db.prepare(`INSERT INTO paper_storyboards
        (paper_episode_id,request_id,shot_number,title,description,action,dialogue,narration,
         duration,shot_type,camera_motion,visual_prompt,negative_prompt,status,
         reference_image_url,reference_local_path,legacy_storyboard_id,source_kind,
         version,created_at,updated_at)
        VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
          episodeId, Number(archivedStoryboard.shot_number || 1), archivedStoryboard.title || '导入分镜',
          archivedStoryboard.description || '', archivedStoryboard.action || '', archivedStoryboard.dialogue || '',
          archivedStoryboard.narration || '', Number(archivedStoryboard.duration || 6),
          archivedStoryboard.shot_type || null, archivedStoryboard.camera_motion || null,
          archivedStoryboard.visual_prompt || '', archivedStoryboard.negative_prompt || '', 'archived',
          archivedStoryboard.reference_image_url || null, referencePath,
          null, 'paper', now, now,
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
            sha256(contentJson), 'archive_import', now,
          ).lastInsertRowid);
        paperRevisionMap.set(Number(archivedRevision.id), revisionId);
        if (Number(archivedStoryboard.current_revision_id) === Number(archivedRevision.id)) currentRevisionId = revisionId;
      }
      if (currentRevisionId) db.prepare('UPDATE paper_storyboards SET current_revision_id = ? WHERE id = ?').run(currentRevisionId, storyboardId);
    }
  }
  const runMap = new Map();
  const shotMap = new Map();
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
       budget_json,status,progress,last_error_json,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,'stale',0,?,1,?,?)`).run(
        projectId, Number(drama_id), compatibilityEpisodeId, paperEpisodeId,
        paperEpisodeId ? null : episodeId, Number(archivedRun.run_number || 1),
        JSON.stringify(paperEpisodeId
          ? { paper_storyboard_ids: selected, source_kind: 'paper', image_provider_config_id: null }
          : { storyboard_ids: selected, image_provider_config_id: null }),
        archivedRun.quality_tier || 'balanced', archivedRun.style_signature,
        archivedRun.source_revision_hash, archivedRun.budget_json || '{}',
        JSON.stringify({ code: 'PAPER_STUDIO_IMPORTED_REVIEW_REQUIRED', message: '导入生产历史不可直接继续执行' }),
        now, now,
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
      const importedShot = importShot(db, runId, Number(drama_id), compatibilityEpisodeId, compatibilityStoryboardId, archivedShot, imported, now, paperSource);
      shotMap.set(Number(archivedShot.id), importedShot.shotId);
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
        VALUES (?,?,?,?,?,?,?,'imported',1,?,?)`).run(runId, sourceShotId, targetShotId, contract.continuity_key, contract.subject_signature, contract.contract_json || '{}', contract.report_json || '{}', now, now);
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
