#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const rendererRoot = path.join(backendRoot, 'src', 'paper-renderer');

const parseArgs = (argv) => {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue != null) parsed[rawKey] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) parsed[rawKey] = argv[++index];
    else parsed[rawKey] = true;
  }
  return parsed;
};

const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const sha256Json = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const resolveBrowserExecutable = () => {
  if (process.env.REMOTION_BROWSER_EXECUTABLE) return process.env.REMOTION_BROWSER_EXECUTABLE;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
};

const resolveCompositorDir = () => {
  const packageName = process.platform === 'darwin'
    ? `@remotion/compositor-darwin-${process.arch}`
    : process.platform === 'win32'
      ? `@remotion/compositor-win32-${process.arch}-msvc`
      : `@remotion/compositor-linux-${process.arch}-gnu`;
  try {
    return path.dirname(require.resolve(packageName));
  } catch (_) {
    return null;
  }
};

const probeVideo = (videoPath, binariesDirectory) => {
  const candidates = [
    process.env.FFPROBE_PATH || 'ffprobe',
    binariesDirectory ? path.join(binariesDirectory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : null,
    resolveCompositorDir() ? path.join(resolveCompositorDir(), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : null,
  ].filter(Boolean);
  for (const ffprobe of candidates) {
    if (ffprobe !== 'ffprobe' && !fs.existsSync(ffprobe)) continue;
    const binaryDir = path.dirname(ffprobe);
    const env = { ...process.env };
    if (process.platform === 'darwin' && ffprobe !== 'ffprobe') {
      env.DYLD_LIBRARY_PATH = [binaryDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    }
    if (process.platform === 'linux' && ffprobe !== 'ffprobe') {
      env.LD_LIBRARY_PATH = [binaryDir, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    }
    const result = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    if (result.status === 0) return { ok: true, ffprobe, data: JSON.parse(result.stdout) };
  }
  return { ok: false, error: 'ffprobe could not inspect the output', candidates };
};

const renderProofSet = async ({ proofMap, outputDir, composition, serveUrl, inputProps, browserExecutable, binariesDirectory, puppeteerInstance, chromiumOptions, scale = 1 }) => {
  fs.mkdirSync(outputDir, { recursive: true });
  const hashes = {};
  for (const [kind, frame] of Object.entries(proofMap)) {
    const output = path.join(outputDir, `${kind}.png`);
    const started = Date.now();
    await renderStill({
      composition,
      serveUrl,
      inputProps,
      output,
      frame,
      imageFormat: 'png',
      overwrite: true,
      logLevel: 'warn',
      timeoutInMilliseconds: 120000,
      binariesDirectory,
      puppeteerInstance,
      chromiumOptions,
      scale,
      ...(browserExecutable ? { browserExecutable } : {}),
    });
    hashes[kind] = { frame, path: output, sha256: sha256File(output), duration_ms: Date.now() - started };
  }
  return hashes;
};

const args = parseArgs(process.argv.slice(2));
const snapshotPath = path.resolve(backendRoot, args.snapshot || 'src/paper-renderer/fixtures/slice0-snapshot.json');
const outputRoot = path.resolve(backendRoot, args.output || 'data/paper-slice0');
const proofOnly = Boolean(args['proof-only']);
const skipDeterminism = Boolean(args['skip-determinism-check']);
const previewScale = Number(args.scale || 1);
const browserExecutable = resolveBrowserExecutable();
const binariesDirectory = process.env.REMOTION_BINARIES_DIRECTORY || null;
const publicDir = path.resolve(backendRoot, args['public-dir'] || path.join(rendererRoot, 'public'));
const compositionId = String(args.composition || 'PaperLayerSlice0');

if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${snapshotPath}`);
fs.mkdirSync(outputRoot, { recursive: true });

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const inputProps = { snapshot };
const proofMap = snapshot.proof_frames;
const startedAt = new Date().toISOString();
const started = Date.now();
const initialMemory = process.memoryUsage().rss;

console.log('[paper-slice0] bundling renderer');
const bundleStarted = Date.now();
const serveUrl = await bundle({
  entryPoint: path.join(rendererRoot, 'entry.jsx'),
  publicDir,
  enableCaching: true,
  onProgress: (progress) => {
    const percent = Math.floor(progress > 1 ? progress : progress * 100);
    if (percent % 20 === 0) process.stdout.write(`\r[paper-slice0] bundle ${percent}%`);
  },
});
process.stdout.write('\n');
const bundleDurationMs = Date.now() - bundleStarted;

const composition = await selectComposition({
  serveUrl,
  id: compositionId,
  inputProps,
  logLevel: 'warn',
  timeoutInMilliseconds: 120000,
  binariesDirectory,
  ...(browserExecutable ? { browserExecutable } : {}),
});

// Reuse one browser for all proof frames and the final render. This avoids
// per-render GPU/Skia initialization differences that can produce different
// anti-aliasing pixels on an otherwise identical frame.
const chromiumOptions = { gl: process.env.REMOTION_GL || 'swiftshader' };
const puppeteerInstance = await openBrowser('chrome', {
  browserExecutable,
  chromiumOptions,
  forceDeviceScaleFactor: 1,
  logLevel: 'warn',
});

const proofs = await renderProofSet({
  proofMap,
  outputDir: path.join(outputRoot, 'proofs'),
  composition,
  serveUrl,
  inputProps,
  browserExecutable,
  binariesDirectory,
  puppeteerInstance,
  chromiumOptions,
  scale: previewScale,
});

let repeatProofs = null;
let deterministicProofs = null;
if (!skipDeterminism) {
  repeatProofs = await renderProofSet({
    proofMap,
    outputDir: path.join(outputRoot, 'proofs-repeat'),
    composition,
    serveUrl,
    inputProps,
    browserExecutable,
    binariesDirectory,
    puppeteerInstance,
    chromiumOptions,
    scale: previewScale,
  });
  deterministicProofs = Object.keys(proofs).every((kind) => proofs[kind].sha256 === repeatProofs[kind].sha256);
  if (!deterministicProofs) {
    const mismatches = Object.keys(proofs).filter((kind) => proofs[kind].sha256 !== repeatProofs[kind].sha256);
    throw new Error(`Proof frame determinism check failed: ${mismatches.join(', ')}`);
  }
}

let video = null;
let probe = null;
if (!proofOnly) {
  const outputLocation = path.join(outputRoot, 'slice0.mp4');
  const videoStarted = Date.now();
  let lastPrinted = -1;
  await renderMedia({
    composition,
    serveUrl,
    inputProps,
    outputLocation,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    audioCodec: 'aac',
    audioBitrate: '192k',
    sampleRate: 48000,
    enforceAudioTrack: true,
    crf: 20,
    x264Preset: 'medium',
    colorSpace: 'bt709',
    overwrite: true,
    concurrency: 1,
    logLevel: 'warn',
    timeoutInMilliseconds: 120000,
    binariesDirectory,
    puppeteerInstance,
    chromiumOptions,
    scale: previewScale,
    ...(browserExecutable ? { browserExecutable } : {}),
    onProgress: ({ progress }) => {
      const percent = Math.floor(progress * 100);
      if (percent >= lastPrinted + 10 || percent === 100) {
        lastPrinted = percent;
        console.log(`[paper-slice0] render ${percent}%`);
      }
    },
  });
  video = {
    path: outputLocation,
    sha256: sha256File(outputLocation),
    bytes: fs.statSync(outputLocation).size,
    duration_ms: Date.now() - videoStarted,
  };
  probe = probeVideo(outputLocation, binariesDirectory);
}

const manifest = {
  version: 1,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  snapshot_path: snapshotPath,
  snapshot_sha256: sha256Json(snapshot),
  // Keep the sampled frame contract in the manifest alongside the rendered
  // artifacts. Consumers can verify that proof files came from the exact
  // snapshot without reopening the temporary snapshot JSON.
  snapshot: {
    proof_frames: snapshot.proof_frames || proofMap,
  },
  composition: {
    id: composition.id,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    duration_in_frames: composition.durationInFrames,
  },
  toolchain: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    remotion: require('remotion/package.json').version,
    bundler: require('@remotion/bundler/package.json').version,
    renderer: require('@remotion/renderer/package.json').version,
    browser_executable: browserExecutable,
    binaries_directory: binariesDirectory,
    compositor_directory: resolveCompositorDir(),
    public_dir: publicDir,
    scale: previewScale,
  },
  timings: {
    bundle_ms: bundleDurationMs,
    total_ms: Date.now() - started,
  },
  memory: {
    rss_before_bytes: initialMemory,
    rss_after_bytes: process.memoryUsage().rss,
  },
  proofs,
  repeat_proofs: repeatProofs,
  deterministic_proofs: deterministicProofs,
  video,
  ffprobe: probe,
};

const manifestPath = path.join(outputRoot, 'manifest.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[paper-slice0] manifest: ${manifestPath}`);
if (video) console.log(`[paper-slice0] video: ${video.path}`);

await puppeteerInstance.close({ silent: true });
