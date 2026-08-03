const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

const { runMigrationsAndEnsure, ensurePaperHistoryForkSchema } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const archiveService = require('../src/services/paper-studio/paperStudioArchiveService');
const reuseService = require('../src/services/paper-studio/paperAssetReuseService');
const exportService = require('../src/services/dramaExportService');
const importService = require('../src/services/dramaImportService');
const dramaService = require('../src/services/dramaService');
const { canonicalJson, sha256 } = require('../src/services/paper-studio/paperStudioUtils');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-studio-archive-'));
  const cfg = { storage: { local_path: storage }, paper_studio: { fps: 30, renderer_version: 'paper-studio-v3' } };
  const now = '2026-07-25T01:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'纸片归档测试',?,?)").run(now, now);
  db.prepare("INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (10,1,1,'第一集',?,?)").run(now, now);
  db.prepare("INSERT INTO characters (id,drama_id,name,appearance,created_at,updated_at) VALUES (1,1,'测试主体','通用纸片角色',?,?)").run(now, now);
  db.prepare("INSERT INTO storyboards (id,episode_id,storyboard_number,title,description,action,characters,duration,created_at,updated_at) VALUES (101,10,1,'通用动作','主体完成动作','主体移动并停下','[1]',4,?,?)").run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const run = runService.create(db, log, { request_id: randomUUID(), project_id: project.id, episode_id: 10, storyboard_ids: [101] }).run;
  const analyzed = analyzerService.analyzeRun(db, log, run.id, { request_id: randomUUID(), expected_version: run.version }, { fps: 30 }).run;
  const shot = analyzed.shots[0];
  const slot = db.prepare(`SELECT pas.* FROM paper_asset_slots pas
    JOIN paper_source_families psf ON psf.id = pas.family_id
    WHERE psf.shot_id = ? ORDER BY pas.id LIMIT 1`).get(shot.id);
  const relative = 'archive-fixture/accepted.bin';
  const absolute = path.join(storage, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, Buffer.from('verified accepted paper asset'));
  const hash = sha256(fs.readFileSync(absolute));
  const versionId = Number(db.prepare(`INSERT INTO paper_asset_versions
    (slot_id,source_family_id,attempt_index,derivation_kind,source_local_path,source_hash,provenance_json,status,created_at,accepted_at)
    VALUES (?,?,1,'source_import',?,?,'{"api_key":"must-not-export"}','accepted',?,?)`)
    .run(slot.id, slot.family_id, relative, hash, now, now).lastInsertRowid);
  db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready' WHERE id = ?").run(versionId, slot.id);
  const writeArtifact = (relativePath, content) => {
    const file = path.join(storage, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(content));
    return sha256(fs.readFileSync(file));
  };
  const snapshotPath = 'archive-fixture/snapshot.json';
  const snapshotHash = writeArtifact(snapshotPath, '{"schema_version":3}');
  const renderHash = `sha256:${'d'.repeat(64)}`;
  const snapshotId = Number(db.prepare(`INSERT INTO paper_render_snapshots
    (shot_id,schema_version,renderer_version,source_revision_hash,snapshot_json,snapshot_hash,render_hash,local_path,status,approved_at,created_at)
    VALUES (?,3,'paper-studio-v3',?,'{"schema_version":3}',?,?,?,'approved',?,?)`)
    .run(shot.id, shot.source_revision_hash, snapshotHash, renderHash, snapshotPath, now, now).lastInsertRowid);
  const previewPath = 'archive-fixture/preview.mp4';
  const previewHash = writeArtifact(previewPath, 'preview-video');
  const proofId = Number(db.prepare(`INSERT INTO paper_proof_runs
    (shot_id,snapshot_id,run_kind,scale,status,preview_local_path,report_json,proof_hash,created_at,completed_at)
    VALUES (?,?,'preview',0.5,'completed',?,'{"pass":true}',?,?,?)`)
    .run(shot.id, snapshotId, previewPath, previewHash, now, now).lastInsertRowid);
  const evidencePath = 'archive-fixture/evidence.png';
  writeArtifact(evidencePath, 'evidence-frame');
  db.prepare(`INSERT INTO paper_proof_evidence
    (proof_run_id,target_key,frame,full_local_path,metrics_json,assertion_json,status,created_at)
    VALUES (?,'primary_subject',30,?,'{"delta":0.3}','[{"pass":true}]','passed',?)`).run(proofId, evidencePath, now);
  const videoPath = 'archive-fixture/final.mp4';
  writeArtifact(videoPath, 'formal-video');
  const videoId = Number(db.prepare(`INSERT INTO video_generations
    (drama_id,storyboard_id,provider,prompt,model,duration,aspect_ratio,video_url,local_path,status,generation_kind,render_hash,renderer_version,paper_studio_shot_id,paper_snapshot_id,created_at,updated_at,completed_at)
    VALUES (1,101,'local-remotion','snapshot','paper-studio-v3',4,'16:9',?,?, 'completed','paper_studio',?,'paper-studio-v3',?,?,?, ?,?)`)
    .run(`/static/${videoPath}`, videoPath, renderHash, shot.id, snapshotId, now, now, now).lastInsertRowid);
  db.prepare("UPDATE paper_studio_shots SET current_snapshot_id = ?, approved_snapshot_id = ?, published_video_generation_id = ?, status = 'published' WHERE id = ?")
    .run(snapshotId, snapshotId, videoId, shot.id);
  return { db, cfg, storage, run, shot, slot, versionId, hash };
}

test('drama archive round-trip preserves verified paper assets as stale untrusted production history', () => {
  const { db, cfg, storage, hash } = setup();
  try {
    const exported = exportService.exportDrama(db, cfg, log, 1, { include_paper_studio: true });
    const zip = new AdmZip(exported.buffer);
    const manifestEntry = zip.getEntry('paper_studio_manifest.json');
    assert.ok(manifestEntry);
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    archiveService.validateManifest(manifest);
    assert.equal(JSON.stringify(manifest).includes('must-not-export'), false);
    assert.ok(manifest.artifacts.length >= 5);
    assert.ok(manifest.artifacts.some((artifact) => artifact.hash === hash));

    const imported = importService.importDrama(db, cfg, log, exported.buffer);
    assert.ok(imported.drama_id > 1);
    assert.equal(imported.paper_studio.runs, 1);
    assert.equal(imported.paper_studio.shots, 1);
    const project = db.prepare('SELECT * FROM paper_studio_projects WHERE drama_id = ? AND deleted_at IS NULL').get(imported.drama_id);
    const run = db.prepare('SELECT * FROM paper_studio_runs WHERE project_id = ? AND deleted_at IS NULL').get(project.id);
    const shot = db.prepare('SELECT * FROM paper_studio_shots WHERE run_id = ? AND deleted_at IS NULL').get(run.id);
    assert.equal(run.status, 'stale');
    assert.equal(shot.status, 'stale');
    assert.equal(shot.approved_snapshot_id > 0, true);
    const version = db.prepare(`SELECT pav.* FROM paper_asset_versions pav
      JOIN paper_asset_slots pas ON pas.id = pav.slot_id
      JOIN paper_source_families psf ON psf.id = pas.family_id
      WHERE psf.shot_id = ? AND pav.status = 'accepted'`).get(shot.id);
    assert.equal(version.source_hash, hash);
    assert.equal(sha256(fs.readFileSync(path.join(storage, version.source_local_path))), hash);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_render_snapshots WHERE shot_id = ? AND status = 'stale'").get(shot.id).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_proof_runs WHERE shot_id = ? AND status = 'imported'").get(shot.id).count, 1);
    const importedVideo = db.prepare("SELECT * FROM video_generations WHERE paper_studio_shot_id = ? AND generation_kind = 'paper_studio_imported'").get(shot.id);
    assert.equal(importedVideo.status, 'completed');
    assert.ok(fs.existsSync(path.join(storage, importedVideo.local_path)));
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('paper archive rejects tampering and drama deletion soft-deletes the v3 production graph', () => {
  const { db, cfg, storage } = setup();
  try {
    const exported = exportService.exportDrama(db, cfg, log, 1, { include_paper_studio: true });
    const zip = new AdmZip(exported.buffer);
    const manifest = JSON.parse(zip.getEntry('paper_studio_manifest.json').getData().toString('utf8'));
    manifest.project.default_tier = 'tampered';
    assert.throws(() => archiveService.validateManifest(manifest), /hash/);

    const result = dramaService.deleteDrama(db, log, cfg, 1, { delete_generated_media: false });
    assert.equal(result.paper_studio_cleanup.projects, 1);
    assert.equal(result.paper_studio_cleanup.runs, 1);
    assert.equal(result.paper_studio_cleanup.shots, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_studio_projects WHERE drama_id = 1 AND deleted_at IS NULL').get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_job_steps WHERE status = 'running'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('archive v2 preserves all asset states, parent/current pointers, review facts and fork audits', () => {
  const { db, cfg, storage, run, shot, slot, versionId, hash } = setup();
  try {
    ensurePaperHistoryForkSchema(db);
    const acceptedAt = '2026-07-25T01:05:00.000Z';
    const rejectedCreatedAt = '2026-07-25T01:06:00.000Z';
    const rejectedAt = '2026-07-25T01:07:00.000Z';
    db.prepare('UPDATE paper_asset_versions SET accepted_at = ? WHERE id = ?').run(acceptedAt, versionId);
    db.prepare(`INSERT INTO paper_asset_review_decisions
      (shot_id,slot_id,asset_version_id,decision,reason,reviewer,request_id,created_at)
      VALUES (?, ?, ?, 'approved', 'source approved', 'reviewer_a', 'archive-review-approved', ?)`)
      .run(shot.id, slot.id, versionId, acceptedAt);
    const rejectedId = Number(db.prepare(`INSERT INTO paper_asset_versions
      (slot_id,source_family_id,parent_version_id,attempt_index,derivation_kind,
       source_local_path,source_hash,reuse_fingerprint,provenance_json,status,created_at,rejected_at)
      VALUES (?,?,?,2,'manual_edit',?,?,?,'{}','rejected',?,?)`)
      .run(slot.id, slot.family_id, versionId, 'archive-fixture/accepted.bin', hash,
        slot.reuse_fingerprint || null, rejectedCreatedAt, rejectedAt).lastInsertRowid);
    db.prepare(`INSERT INTO paper_asset_review_decisions
      (shot_id,slot_id,asset_version_id,decision,reason,reviewer,request_id,created_at)
      VALUES (?, ?, ?, 'rejected', 'source rejected', 'reviewer_b', 'archive-review-rejected', ?)`)
      .run(shot.id, slot.id, rejectedId, rejectedAt);
    db.prepare(`INSERT INTO paper_asset_reuse_review_decisions
      (run_id,shot_id,target_slot_id,source_asset_version_id,decision,reason,actor,
       preview_fingerprint,request_id,created_at)
      VALUES (?, ?, ?, ?, 'declined', 'generate_difference_instead', 'local_owner',
              'sha256:archive-preview', 'archive-reuse-review', ?)`)
      .run(run.id, shot.id, slot.id, versionId, rejectedAt);

    const projectId = Number(db.prepare('SELECT id FROM paper_studio_projects WHERE drama_id = 1').get().id);
    const paperEpisodeId = Number(db.prepare(`INSERT INTO paper_studio_episodes
      (project_id,episode_number,title,status,created_at,updated_at)
      VALUES (?,99,'归档审计集','draft',?,?)`).run(projectId, acceptedAt, acceptedAt).lastInsertRowid);
    const paperStoryboardId = Number(db.prepare(`INSERT INTO paper_storyboards
      (paper_episode_id,shot_number,title,status,created_at,updated_at)
      VALUES (?,1,'归档审计分镜','draft',?,?)`).run(paperEpisodeId, acceptedAt, acceptedAt).lastInsertRowid);
    const revisionContent = JSON.stringify({ paper_storyboard_id: paperStoryboardId, paper_episode_id: paperEpisodeId, title: '归档审计分镜' });
    const revisionId = Number(db.prepare(`INSERT INTO paper_storyboard_revisions
      (paper_storyboard_id,revision_number,content_json,content_hash,created_from,created_at)
      VALUES (?,1,?,?,'manual',?)`).run(paperStoryboardId, revisionContent, sha256(revisionContent), acceptedAt).lastInsertRowid);
    db.prepare('UPDATE paper_storyboards SET current_revision_id = ?, working_copy_base_revision_id = ? WHERE id = ?')
      .run(revisionId, revisionId, paperStoryboardId);
    const forkAuditId = Number(db.prepare(`INSERT INTO paper_history_fork_audits
      (paper_storyboard_id,source_kind,source_storyboard_revision_id,target_mode,
       target_storyboard_revision_id,status,impact_json,preview_fingerprint,
       provider_call_count_before,provider_call_count_after,request_id,created_at,completed_at)
      VALUES (?,'storyboard',?,'working_copy',?,'completed','{}','sha256:fork-preview',0,0,
              'archive-fork-audit',?,?)`)
      .run(paperStoryboardId, revisionId, revisionId, acceptedAt, rejectedAt).lastInsertRowid);
    db.prepare('UPDATE paper_storyboards SET working_copy_fork_audit_id = ? WHERE id = ?')
      .run(forkAuditId, paperStoryboardId);

    const exported = exportService.exportDrama(db, cfg, log, 1, { include_paper_studio: true });
    const manifest = JSON.parse(new AdmZip(exported.buffer).getEntry('paper_studio_manifest.json').getData().toString('utf8'));
    assert.equal(manifest.schema_version, 2);
    const archivedShot = manifest.runs.find((item) => Number(item.id) === Number(run.id)).shots[0];
    const archivedVersions = archivedShot.families.flatMap((family) => family.slots.flatMap((item) => item.versions));
    assert.deepEqual(archivedVersions.map((version) => version.status).sort(), ['accepted', 'rejected']);
    assert.equal(archivedShot.asset_review_decisions.length, 2);
    assert.equal(archivedShot.asset_reuse_review_decisions.length, 1);
    assert.equal(manifest.paper_episodes.find((item) => Number(item.id) === paperEpisodeId)
      .storyboards[0].history_fork_audits.length, 1);

    const imported = importService.importDrama(db, cfg, log, exported.buffer);
    const importedProject = db.prepare('SELECT * FROM paper_studio_projects WHERE drama_id = ?').get(imported.drama_id);
    const importedRun = db.prepare('SELECT * FROM paper_studio_runs WHERE project_id = ? AND paper_episode_id IS NULL').get(importedProject.id);
    const importedShot = db.prepare('SELECT * FROM paper_studio_shots WHERE run_id = ?').get(importedRun.id);
    const importedVersions = db.prepare(`SELECT pav.* FROM paper_asset_versions pav
      JOIN paper_asset_slots pas ON pas.id = pav.slot_id
      JOIN paper_source_families psf ON psf.id = pas.family_id
      WHERE psf.shot_id = ? ORDER BY pav.id`).all(importedShot.id);
    assert.deepEqual(importedVersions.map((version) => version.status), ['accepted', 'rejected']);
    assert.equal(importedVersions[0].accepted_at, acceptedAt);
    assert.equal(importedVersions[1].created_at, rejectedCreatedAt);
    assert.equal(importedVersions[1].rejected_at, rejectedAt);
    assert.equal(importedVersions[1].parent_version_id, importedVersions[0].id);
    const importedSlot = db.prepare('SELECT * FROM paper_asset_slots WHERE id = ?').get(importedVersions[0].slot_id);
    assert.equal(importedSlot.current_version_id, importedVersions[0].id);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM paper_asset_review_decisions d
      JOIN paper_studio_shots s ON s.id = d.shot_id WHERE s.id = ?`).get(importedShot.id).count, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM paper_asset_reuse_review_decisions d
      WHERE d.shot_id = ?`).get(importedShot.id).count, 1);
    const importedProvenance = JSON.parse(importedVersions[0].provenance_json);
    assert.equal(importedProvenance.archive_import.import_trust_state, 'review_required');
    assert.equal(importedProvenance.archive_import.imported_review_decision_count, 1);
    assert.equal(reuseService.localTrustState(db, importedVersions[0]).trusted, false);
    db.prepare(`INSERT INTO paper_asset_review_decisions
      (shot_id,slot_id,asset_version_id,decision,reason,reviewer,request_id,created_at)
      VALUES (?, ?, ?, 'approved', 'local import trust confirmed', 'local_owner',
              'archive-local-trust', '2026-07-25T02:00:00.000Z')`)
      .run(importedShot.id, importedSlot.id, importedVersions[0].id);
    assert.equal(reuseService.localTrustState(db, importedVersions[0]).trusted, true);

    const importedAudit = db.prepare(`SELECT h.* FROM paper_history_fork_audits h
      JOIN paper_storyboards ps ON ps.id = h.paper_storyboard_id
      JOIN paper_studio_episodes pe ON pe.id = ps.paper_episode_id
      WHERE pe.project_id = ?`).get(importedProject.id);
    assert.equal(importedAudit.request_id, 'archive-fork-audit');
    const importedAuditStoryboard = db.prepare('SELECT * FROM paper_storyboards WHERE id = ?').get(importedAudit.paper_storyboard_id);
    assert.equal(importedAuditStoryboard.working_copy_fork_audit_id, importedAudit.id);
    assert.equal(importedAuditStoryboard.working_copy_base_revision_id, importedAudit.source_storyboard_revision_id);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('archive v1 remains readable without inventing review decisions', () => {
  const { db, cfg, storage } = setup();
  try {
    const exported = exportService.exportDrama(db, cfg, log, 1, { include_paper_studio: true });
    const zip = new AdmZip(exported.buffer);
    const manifest = JSON.parse(zip.getEntry('paper_studio_manifest.json').getData().toString('utf8'));
    manifest.schema_version = 1;
    for (const run of manifest.runs || []) {
      for (const shot of run.shots || []) {
        for (const family of shot.families || []) {
          for (const slot of family.slots || []) slot.versions = (slot.versions || []).filter((version) => version.status === 'accepted');
        }
        delete shot.asset_review_decisions;
        delete shot.asset_reuse_review_decisions;
      }
    }
    for (const episode of manifest.paper_episodes || []) {
      for (const storyboard of episode.storyboards || []) delete storyboard.history_fork_audits;
    }
    const { manifest_hash: ignored, ...core } = manifest;
    manifest.manifest_hash = sha256(canonicalJson(core));
    archiveService.validateManifest(manifest);
    zip.updateFile('paper_studio_manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const imported = importService.importDrama(db, cfg, log, zip.toBuffer());
    const project = db.prepare('SELECT * FROM paper_studio_projects WHERE drama_id = ?').get(imported.drama_id);
    const version = db.prepare(`SELECT pav.* FROM paper_asset_versions pav
      JOIN paper_asset_slots pas ON pas.id = pav.slot_id
      JOIN paper_source_families psf ON psf.id = pas.family_id
      JOIN paper_studio_shots pss ON pss.id = psf.shot_id
      JOIN paper_studio_runs psr ON psr.id = pss.run_id
      WHERE psr.project_id = ?`).get(project.id);
    assert.equal(version.status, 'accepted');
    assert.equal(JSON.parse(version.provenance_json).archive_import.import_trust_state, 'review_required');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_asset_review_decisions WHERE asset_version_id = ?').get(version.id).count, 0);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
