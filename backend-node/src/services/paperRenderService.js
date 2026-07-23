const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const taskService = require('./taskService');
const videoService = require('./videoService');
const storageLayout = require('./storageLayout');
const specCompiler = require('./paperSpecCompiler');
const {
  PaperError,
  PAPER_PROOF_KINDS,
  PAPER_RENDERER_VERSION,
  resolveStorageRoot,
  resolveStorageFile,
  normalizeRelativePath,
  sha256File,
  nowIso,
  isPathInsideReal,
} = require('./paperUtils');

const backendRoot = path.resolve(__dirname, '..', '..');
const renderScript = path.join(backendRoot, 'scripts', 'render-paper-storyboard.mjs');
const rendererPublic = path.join(backendRoot, 'src', 'paper-renderer', 'public');
let renderBusy = false;
const renderQueue = [];

function pumpRenderQueue() {
  if (renderBusy || !renderQueue.length) return;
  const item = renderQueue.shift();
  renderBusy = true;
  renderComposition(item.args)
    .then(item.resolve, item.reject)
    .finally(() => { renderBusy = false; pumpRenderQueue(); });
}

function enqueueRender(args) {
  return new Promise((resolve, reject) => {
    renderQueue.push({ args, resolve, reject });
    pumpRenderQueue();
  });
}

function updateTask(db, taskId, status, progress, message, result) {
  if (!taskId) return;
  if (status === 'completed') taskService.updateTaskResult(db, taskId, result || { status: 'completed' });
  else if (status === 'failed') taskService.updateTaskError(db, taskId, message || '纸片渲染失败');
  else taskService.updateTaskStatus(db, taskId, status, progress, message);
}

function compileOptionsForRender({ proofOnly = false, preview = false } = {}) {
  return { allowProvisional: Boolean(proofOnly || preview) };
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function collectMediaPaths(snapshot) {
  const paths = new Set();
  const add = (src) => { const rel = normalizeRelativePath(src); if (rel) paths.add(rel); };
  for (const layer of snapshot.layers || []) {
    add(layer.src);
    for (const part of layer.rig?.parts || []) add(part.src);
    add(layer.occlusion?.mask_src);
  }
  for (const source of snapshot.audio?.sources || []) add(source.src);
  return [...paths];
}

function stagePublicDir(cfg, snapshot, tempRoot) {
  const publicDir = path.join(tempRoot, 'public');
  fs.cpSync(rendererPublic, publicDir, { recursive: true });
  const storageRoot = resolveStorageRoot(cfg);
  for (const rel of collectMediaPaths(snapshot)) {
    const source = resolveStorageFile(cfg, rel);
    if (!source || !fs.existsSync(source) || !isPathInsideReal(storageRoot, source)) throw new PaperError('PAPER_ASSET_PATH_INVALID', '渲染素材文件不存在或越过 storage 根目录', { path: rel }, 422);
    const destination = path.join(publicDir, rel);
    ensureDir(path.dirname(destination));
    fs.copyFileSync(source, destination);
  }
  return publicDir;
}

function runRenderer({ snapshotPath, outputRoot, publicDir, scale = 1, proofOnly = false, env = {}, log }) {
  return new Promise((resolve, reject) => {
    const args = [renderScript, '--snapshot', snapshotPath, '--output', outputRoot, '--public-dir', publicDir, '--scale', String(scale)];
    if (proofOnly) args.push('--proof-only');
    const workerEnv = { ...process.env, REMOTION_GL: 'swiftshader', ...env };
    // In Electron the executable is Electron itself. Only the renderer child
    // should opt into Node mode; setting ELECTRON_RUN_AS_NODE globally would
    // also affect BrowserWindow/Chromium subprocesses.
    if (process.versions?.electron) workerEnv.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(process.execPath, args, {
      cwd: backendRoot,
      env: workerEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); if (log) log.info('paper-render stdout', { line: chunk.toString().trim().slice(-1000) }); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const error = new PaperError('PAPER_RENDER_FAILED', `Remotion 渲染失败（exit ${code}）`, { exit_code: code, stderr: stderr.slice(-4000), stdout: stdout.slice(-4000) }, 500);
        reject(error);
        return;
      }
      const manifestPath = path.join(outputRoot, 'manifest.json');
      if (!fs.existsSync(manifestPath)) { reject(new PaperError('PAPER_RENDER_FAILED', '渲染未生成 manifest', { output_root: outputRoot }, 500)); return; }
      try { resolve({ manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), stdout, stderr }); }
      catch (err) { reject(new PaperError('PAPER_RENDER_FAILED', '渲染 manifest 无法解析', { error: err.message }, 500)); }
    });
  });
}

function proofHash(proofs) {
  return `sha256:${crypto.createHash('sha256').update(PAPER_PROOF_KINDS.map((kind) => proofs[kind]?.sha256 || '').join('|')).digest('hex')}`;
}

function assertManifestProofFrames(snapshot, manifest) {
  const expected = snapshot?.proof_frames || {};
  // Older slice manifests did not carry the nested snapshot object. Keep
  // accepting those files when their per-proof frame numbers still match;
  // newly generated manifests always include snapshot.proof_frames.
  const declared = manifest?.snapshot?.proof_frames || expected;
  for (const kind of PAPER_PROOF_KINDS) {
    const expectedFrame = Number(expected[kind]);
    const declaredFrame = Number(declared[kind]);
    const renderedFrame = Number(manifest?.proofs?.[kind]?.frame);
    if (!Number.isInteger(expectedFrame)
      || declaredFrame !== expectedFrame
      || renderedFrame !== expectedFrame) {
      throw new PaperError('PAPER_PROOF_FRAME_MISMATCH', `proof frame 与渲染快照不一致: ${kind}`, {
        kind,
        expected: expected[kind],
        manifest: declared[kind],
        rendered: manifest?.proofs?.[kind]?.frame,
      }, 500);
    }
  }
}

function publishProofs(db, compositionId, renderHash, manifest, cfg) {
  const composition = db.prepare('SELECT storyboard_id FROM paper_compositions WHERE id = ?').get(Number(compositionId));
  const storyboardId = composition?.storyboard_id || compositionId;
  const dramaId = db.prepare('SELECT drama_id FROM paper_compositions WHERE id = ?').get(Number(compositionId))?.drama_id;
  const targetRelBase = `${storageLayout.getProjectStorageSubdir(db, dramaId)}/paper/compositions/storyboard-${storyboardId}/previews/${renderHash.replace(/^sha256:/, '')}`;
  const targetBase = resolveStorageFile(cfg, targetRelBase);
  ensureDir(targetBase);
  const proofRows = [];
  const rowsToPersist = [];
  for (const kind of PAPER_PROOF_KINDS) {
    const source = manifest.proofs?.[kind]?.path;
    if (!source || !fs.existsSync(source)) throw new PaperError('PAPER_RENDER_FAILED', `缺少 proof frame: ${kind}`, { kind }, 500);
    const rel = `${targetRelBase}/${kind}.png`;
    const dest = resolveStorageFile(cfg, rel);
    const sourceHash = sha256File(source);
    const existing = db.prepare(
      'SELECT frame, local_path, image_hash, status FROM paper_render_proofs WHERE composition_id = ? AND render_hash = ? AND proof_kind = ?'
    ).get(Number(compositionId), renderHash, kind);
    // Proof publication is idempotent. A retry must not copy the same six
    // files a second time (or change their timestamps) when the prior publish
    // completed successfully.
    const existingFile = existing ? resolveStorageFile(cfg, existing.local_path) : null;
    const reusable = Boolean(existing && existing.image_hash === sourceHash && existingFile && fs.existsSync(existingFile) && existing.status === 'pass');
    if (!reusable) {
      fs.copyFileSync(source, dest);
    }
    const publishedAbs = reusable ? existingFile : dest;
    const publishedRel = reusable ? existing.local_path : rel;
    const hash = publishedAbs && fs.existsSync(publishedAbs) ? sha256File(publishedAbs) : sourceHash;
    const row = { kind, frame: manifest.proofs[kind].frame, local_path: publishedRel, image_hash: hash };
    proofRows.push(row);
    if (!reusable) rowsToPersist.push(row);
  }
  const now = nowIso();
  const insert = db.prepare(
    `INSERT INTO paper_render_proofs (composition_id, render_hash, proof_kind, frame, local_path, image_hash, diagnostics_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pass', ?, ?)
     ON CONFLICT(composition_id, render_hash, proof_kind) DO UPDATE SET frame = excluded.frame, local_path = excluded.local_path, image_hash = excluded.image_hash, diagnostics_json = excluded.diagnostics_json, status = 'pass', updated_at = excluded.updated_at`
  );
  for (const row of rowsToPersist) insert.run(compositionId, renderHash, row.kind, row.frame, row.local_path, row.image_hash, JSON.stringify({ deterministic: manifest.deterministic_proofs }), now, now);
  return { proofRows, proof_hash: proofHash(manifest.proofs || {}) };
}

function rewritePublishedManifestPaths(manifest, cfg, proofResult, videoRel = null) {
  for (const row of proofResult?.proofRows || []) {
    if (manifest?.proofs?.[row.kind]) manifest.proofs[row.kind].path = resolveStorageFile(cfg, row.local_path);
  }
  if (videoRel && manifest?.video) manifest.video.path = resolveStorageFile(cfg, videoRel);
  return manifest;
}

async function finalizePaperVideo({ db, cfg, log, compositionId, videoGenerationId, snapshot, manifest, proof }) {
  const video = manifest?.video;
  if (!video?.path || !fs.existsSync(video.path)) throw new PaperError('PAPER_RENDER_FAILED', '正式渲染未生成 MP4', { manifest }, 500);
  const renderHash = snapshot?.provenance?.render_hash;
  if (!renderHash) throw new PaperError('PAPER_RENDER_FAILED', '正式渲染快照缺少 render_hash', { composition_id: compositionId }, 500);
  const comp = db.prepare('SELECT * FROM paper_compositions WHERE id = ? AND deleted_at IS NULL').get(Number(compositionId));
  if (!comp) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: compositionId }, 404);
  if (!proof?.proof_hash) throw new PaperError('PAPER_RENDER_FAILED', '正式渲染缺少 proof 发布结果', { composition_id: compositionId }, 500);
  const generation = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenerationId));
  if (!generation) throw new PaperError('PAPER_RENDER_FAILED', '正式渲染记录不存在', { video_generation_id: videoGenerationId }, 500);
  if (generation.render_hash && generation.render_hash !== renderHash) {
    throw new PaperError('PAPER_RENDER_HASH_CONFLICT', '视频记录与渲染快照 hash 不一致', { video_generation_id: videoGenerationId }, 409);
  }

  // If a worker crashed after the DB transaction but before its caller
  // observed success, finalizeLocalVideoGeneration is deliberately safe to
  // call again. Reuse the already-published path and discard only this
  // invocation's temporary MP4.
  if (generation.status === 'completed' && generation.render_hash === renderHash && generation.local_path) {
    const publishedPath = resolveStorageFile(cfg, generation.local_path);
    if (!publishedPath) throw new PaperError('PAPER_ASSET_PATH_INVALID', '已完成视频的本地路径非法', { local_path: generation.local_path }, 422);
    ensureDir(path.dirname(publishedPath));
    if (!fs.existsSync(publishedPath)) fs.renameSync(video.path, publishedPath);
    else if (path.resolve(video.path) !== path.resolve(publishedPath)) {
      try { fs.unlinkSync(video.path); } catch (_) {}
    }
    const finalized = videoService.finalizeLocalVideoGeneration(db, log, {
      video_generation_id: Number(videoGenerationId),
      paper_composition_id: Number(compositionId),
      video_url: generation.video_url,
      local_path: generation.local_path,
      render_snapshot: generation.render_snapshot || snapshot,
      render_hash: generation.render_hash,
      renderer_version: generation.renderer_version || PAPER_RENDERER_VERSION,
      last_proof_hash: proof.proof_hash,
      task_result: {
        status: 'completed',
        video_generation_id: Number(videoGenerationId),
        composition_id: Number(compositionId),
        local_path: generation.local_path,
        video_url: generation.video_url,
        render_hash: renderHash,
        proof_hash: proof.proof_hash,
      },
    });
    return { video_rel: generation.local_path, proof, render_hash: renderHash, idempotent: true, video_generation: finalized };
  }

  const projectSubdir = storageLayout.getProjectStorageSubdir(db, comp.drama_id);
  // Keep the destination stable across worker retries. This is what makes a
  // filesystem publish and the DB finalizer converge on one artifact.
  const renderToken = String(renderHash).replace(/^sha256:/, '').slice(0, 16) || 'pending';
  const videoRel = `${projectSubdir}/videos/vg_${videoGenerationId}_${renderToken}.mp4`;
  const destination = resolveStorageFile(cfg, videoRel);
  ensureDir(path.dirname(destination));
  if (!fs.existsSync(destination)) fs.renameSync(video.path, destination);
  else if (path.resolve(video.path) !== path.resolve(destination)) {
    // A previous attempt atomically moved the file and then lost its process;
    // retain that complete destination and remove this retry's temp artifact.
    try { fs.unlinkSync(video.path); } catch (_) {}
  }
  const finalized = videoService.finalizeLocalVideoGeneration(db, log, {
    video_generation_id: Number(videoGenerationId),
    paper_composition_id: Number(compositionId),
    video_url: `/static/${videoRel}`,
    local_path: videoRel,
    render_snapshot: snapshot,
    render_hash: renderHash,
    renderer_version: PAPER_RENDERER_VERSION,
    last_proof_hash: proof.proof_hash,
    task_result: {
      status: 'completed',
      video_generation_id: Number(videoGenerationId),
      composition_id: Number(compositionId),
      local_path: videoRel,
      video_url: `/static/${videoRel}`,
      render_hash: renderHash,
      proof_hash: proof.proof_hash,
    },
  });
  if (log) log.info('Paper video published', { module: 'paper-render', composition_id: compositionId, video_generation_id: videoGenerationId, render_hash: renderHash, local_path: videoRel });
  return { video_rel: videoRel, proof, render_hash: renderHash, video_generation: finalized };
}

async function renderComposition({ db, cfg, log, compositionId, taskId, videoGenerationId, proofOnly = false, preview = false, scale = 1 }) {
  let tempRoot = null;
  try {
    if (cfg?.paper_render?.enabled === false) throw new PaperError('PAPER_RENDER_DISABLED', '纸片分层渲染已在本地配置中禁用', null, 409);
    if (taskId) {
      const task = db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(taskId);
      if (task?.status === 'failed') throw new PaperError('PAPER_CANCELLED', '纸片渲染任务已取消', { task_id: taskId }, 409);
    }
    updateTask(db, taskId, 'processing', 5, '正在校验纸片合成');
    const compiled = specCompiler.compile(db, cfg, compositionId, compileOptionsForRender({ proofOnly, preview }));
    updateTask(db, taskId, 'processing', 10, '正在准备渲染快照');
    tempRoot = path.join(resolveStorageRoot(cfg), 'paper', 'tmp', `render-${taskId || crypto.randomUUID()}`);
    ensureDir(tempRoot);
    const snapshotPath = path.join(tempRoot, 'snapshot.json');
    fs.writeFileSync(snapshotPath, `${JSON.stringify(compiled.snapshot, null, 2)}\n`);
    const publicDir = stagePublicDir(cfg, compiled.snapshot, tempRoot);
    const outputRoot = path.join(tempRoot, 'output');
    ensureDir(outputRoot);
    updateTask(db, taskId, 'processing', 20, '正在启动本地渲染器');
    const result = await runRenderer({ snapshotPath, outputRoot, publicDir, scale, proofOnly, log });
    const manifest = result.manifest;
    assertManifestProofFrames(compiled.snapshot, manifest);
    if (!manifest.deterministic_proofs) throw new PaperError('PAPER_RENDER_FAILED', 'proof frame 确定性检查失败', { manifest }, 500);
    updateTask(db, taskId, 'processing', proofOnly ? 70 : 55, 'proof frames 已生成');
    const proofResult = publishProofs(db, compositionId, compiled.render_hash, manifest, cfg);
    if (proofOnly) {
      rewritePublishedManifestPaths(manifest, cfg, proofResult);
      db.prepare("UPDATE paper_compositions SET status = 'ready', last_proof_hash = ?, renderer_version = ?, updated_at = ? WHERE id = ?")
        .run(proofResult.proof_hash, PAPER_RENDERER_VERSION, nowIso(), Number(compositionId));
      updateTask(db, taskId, 'completed', 100, '', { status: 'completed', composition_id: Number(compositionId), proof_hash: proofResult.proof_hash, render_hash: compiled.render_hash });
      return { manifest, proof: proofResult };
    }
    if (preview) {
      rewritePublishedManifestPaths(manifest, cfg, proofResult);
      updateTask(db, taskId, 'completed', 100, '', { status: 'completed', preview: true, composition_id: Number(compositionId), render_hash: compiled.render_hash, output: manifest.video?.path || null });
      return { manifest, proof: proofResult, preview: true };
    }
    updateTask(db, taskId, 'processing', 90, '正在发布正式视频');
    const finalized = await finalizePaperVideo({ db, cfg, log, compositionId, videoGenerationId, snapshot: compiled.snapshot, manifest, proof: proofResult });
    rewritePublishedManifestPaths(manifest, cfg, proofResult, finalized?.video_rel || null);
    return { manifest, proof: proofResult, finalized };
  } catch (err) {
    const paperErr = err.code ? err : new PaperError('PAPER_RENDER_FAILED', err.message || '纸片渲染失败', null, 500);
    try {
      if (videoGenerationId) db.prepare("UPDATE video_generations SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ? AND status <> 'completed'").run(paperErr.message.slice(0, 1000), nowIso(), Number(videoGenerationId));
      db.prepare("UPDATE paper_compositions SET status = 'failed', last_validation_json = ?, updated_at = ? WHERE id = ? AND status <> 'rendered'").run(JSON.stringify({ code: paperErr.code, message: paperErr.message, details: paperErr.details }), nowIso(), Number(compositionId));
      let taskCompleted = false;
      if (taskId) {
        const task = db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(taskId);
        taskCompleted = task?.status === 'completed';
      }
      if (!taskCompleted) updateTask(db, taskId, 'failed', 0, paperErr.message, { code: paperErr.code, message: paperErr.message, details: paperErr.details });
    } catch (_) {}
    throw paperErr;
  } finally {
    if (tempRoot) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function doctor(cfg = {}) {
  const browserCandidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:/Program Files/Google/Chrome/Application/chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const find = (candidates) => candidates.find((candidate) => fs.existsSync(candidate)) || null;
  const executableAvailable = (candidate) => {
    if (!candidate) return false;
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) return fs.existsSync(candidate);
    try { return spawnSync(candidate, ['-version'], { stdio: 'ignore' }).status === 0; } catch (_) { return false; }
  };
  const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();
  const storage = resolveStorageRoot(cfg);
  let writable = false;
  try { ensureDir(storage); fs.accessSync(storage, fs.constants.W_OK); writable = true; } catch (_) {}
  const browser = find(browserCandidates);
  const bundleAvailable = fs.existsSync(renderScript) && fs.existsSync(rendererPublic);
  return {
    ok: cfg?.paper_render?.enabled !== false && Boolean(bundleAvailable && browser && writable && executableAvailable(ffmpeg) && executableAvailable(ffprobe)),
    enabled: cfg?.paper_render?.enabled !== false,
    renderer_version: PAPER_RENDERER_VERSION,
    schema_version: 2,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    remotion_bundle: { available: bundleAvailable, path: renderScript },
    browser: { available: Boolean(browser), path: browser },
    ffmpeg: { available: executableAvailable(ffmpeg), path: ffmpeg },
    ffprobe: { available: executableAvailable(ffprobe), path: ffprobe },
    storage: { writable, path: storage },
    limits: { max_layers: 40, max_memory_mb: 4096 },
  };
}

module.exports = {
  renderComposition,
  enqueueRender,
  doctor,
  runRenderer,
  stagePublicDir,
  publishProofs,
  finalizePaperVideo,
  assertManifestProofFrames,
  compileOptionsForRender,
  rewritePublishedManifestPaths,
};
