const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const archiveService = require('../src/services/paper-studio/paperStudioArchiveService');
const exportService = require('../src/services/dramaExportService');
const importService = require('../src/services/dramaImportService');
const dramaService = require('../src/services/dramaService');
const { sha256 } = require('../src/services/paper-studio/paperStudioUtils');

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
  return { db, cfg, storage, run, shot, hash };
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
    assert.equal(shot.approved_snapshot_id, null);
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
