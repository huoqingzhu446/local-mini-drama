#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import sharp from 'sharp';
import { ensureBundleCache } from '../src/services/paper-studio/paperStudioBundleCache.mjs';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const rendererRoot = path.join(backendRoot, 'src', 'paper-studio-renderer');

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const [key, inline] = argv[index].slice(2).split('=', 2);
    if (inline != null) parsed[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) parsed[key] = argv[++index];
    else parsed[key] = true;
  }
  return parsed;
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function sourceDigest(root) {
  const hash = crypto.createHash('sha256');
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      hash.update(relative);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) hash.update(fs.readFileSync(absolute));
    }
  };
  visit(root);
  return hash.digest('hex');
}

const PROOF_REPEAT_PIXEL_DELTA = 12;
const PROOF_REPEAT_MAX_CHANGED_RATIO = 0.0005;
const PROOF_REPEAT_MAX_MEAN_DELTA = 0.05;
const PROOF_REPEAT_MAX_CHANNEL_DELTA = 32;
const PROOF_REPEAT_SPARSE_OUTLIER_RATIO = 0.0002;
const PROOF_REPEAT_SPARSE_OUTLIER_MEAN_DELTA = 0.01;
const PROOF_REPEAT_SPARSE_OUTLIER_MAX_CHANNEL_DELTA = 64;

async function compareProofFrames(firstPath, repeatPath) {
  const first = await sharp(firstPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const repeat = await sharp(repeatPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sameGeometry = first.info.width === repeat.info.width
    && first.info.height === repeat.info.height
    && first.info.channels === repeat.info.channels;
  if (!sameGeometry || first.data.length !== repeat.data.length) {
    return {
      pass: false,
      same_geometry: false,
      first: { width: first.info.width, height: first.info.height, channels: first.info.channels },
      repeat: { width: repeat.info.width, height: repeat.info.height, channels: repeat.info.channels },
    };
  }

  let changedPixels = 0;
  let absoluteDelta = 0;
  let maxChannelDelta = 0;
  const pixels = first.info.width * first.info.height;
  for (let offset = 0; offset < first.data.length; offset += first.info.channels) {
    let pixelChanged = false;
    for (let channel = 0; channel < first.info.channels; channel += 1) {
      const delta = Math.abs(first.data[offset + channel] - repeat.data[offset + channel]);
      absoluteDelta += delta;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
      if (delta >= PROOF_REPEAT_PIXEL_DELTA) pixelChanged = true;
    }
    if (pixelChanged) changedPixels += 1;
  }
  const changedPixelRatio = changedPixels / pixels;
  const meanChannelDelta = absoluteDelta / first.data.length;
  // Chrome/SwiftShader can occasionally move a tiny anti-aliased edge by one
  // sub-pixel between two still captures. Keep the global ratio/mean limits,
  // but allow a very sparse group of edge outliers to exceed the normal
  // per-channel ceiling. A broad change or a fully flipped pixel still fails.
  const sparseOutlierToleranceApplied = maxChannelDelta > PROOF_REPEAT_MAX_CHANNEL_DELTA
    && changedPixelRatio <= PROOF_REPEAT_SPARSE_OUTLIER_RATIO
    && meanChannelDelta <= PROOF_REPEAT_SPARSE_OUTLIER_MEAN_DELTA
    && maxChannelDelta <= PROOF_REPEAT_SPARSE_OUTLIER_MAX_CHANNEL_DELTA;
  return {
    pass: changedPixelRatio <= PROOF_REPEAT_MAX_CHANGED_RATIO
      && meanChannelDelta <= PROOF_REPEAT_MAX_MEAN_DELTA
      && (maxChannelDelta <= PROOF_REPEAT_MAX_CHANNEL_DELTA || sparseOutlierToleranceApplied),
    same_geometry: true,
    changed_pixels: changedPixels,
    changed_pixel_ratio: Number(changedPixelRatio.toFixed(8)),
    mean_channel_delta: Number(meanChannelDelta.toFixed(6)),
    max_channel_delta: maxChannelDelta,
    sparse_outlier_tolerance_applied: sparseOutlierToleranceApplied,
    thresholds: {
      pixel_delta: PROOF_REPEAT_PIXEL_DELTA,
      max_changed_pixel_ratio: PROOF_REPEAT_MAX_CHANGED_RATIO,
      max_mean_channel_delta: PROOF_REPEAT_MAX_MEAN_DELTA,
      max_channel_delta: PROOF_REPEAT_MAX_CHANNEL_DELTA,
      sparse_outlier_ratio: PROOF_REPEAT_SPARSE_OUTLIER_RATIO,
      sparse_outlier_mean_delta: PROOF_REPEAT_SPARSE_OUTLIER_MEAN_DELTA,
      sparse_outlier_max_channel_delta: PROOF_REPEAT_SPARSE_OUTLIER_MAX_CHANNEL_DELTA,
    },
  };
}

function browserExecutable() {
  if (process.env.REMOTION_BROWSER_EXECUTABLE && fs.existsSync(process.env.REMOTION_BROWSER_EXECUTABLE)) return process.env.REMOTION_BROWSER_EXECUTABLE;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function compositorDirectory() {
  const packageName = process.platform === 'darwin'
    ? `@remotion/compositor-darwin-${process.arch}`
    : process.platform === 'win32'
      ? `@remotion/compositor-win32-${process.arch}-msvc`
      : `@remotion/compositor-linux-${process.arch}-gnu`;
  try { return path.dirname(require.resolve(`${packageName}/package.json`)); } catch (_) { return null; }
}

async function cropProof(input, output, crop, width, height) {
  const region = crop || { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.max(0, Math.min(width - 1, Math.round(Number(region.x || 0) * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(Number(region.y || 0) * height)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(Number(region.width || 1) * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(Number(region.height || 1) * height)));
  await sharp(input).extract({ left, top, width: cropWidth, height: cropHeight }).png().toFile(output);
}

const args = parseArgs(process.argv.slice(2));
const snapshotPath = path.resolve(args.snapshot || '');
const outputDir = path.resolve(args.output || '');
const publicDir = path.resolve(args['public-dir'] || '');
const mode = String(args.mode || 'proof');
const scale = Number(args.scale || (mode === 'preview' ? 0.5 : 1));
const renderTimeoutMs = Math.max(30_000, Number(args['timeout-ms'] || (mode === 'preview' ? 120_000 : 180_000)));
if (!['proof', 'preview', 'formal'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot does not exist: ${snapshotPath}`);
if (!fs.existsSync(publicDir)) throw new Error(`Public directory does not exist: ${publicDir}`);
fs.mkdirSync(outputDir, { recursive: true });
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const browser = browserExecutable();
const binariesDirectory = process.env.REMOTION_BINARIES_DIRECTORY || compositorDirectory();
const started = Date.now();

const bundleKey = crypto.createHash('sha256').update(JSON.stringify({
  renderer: sourceDigest(rendererRoot),
  assets: (snapshot.assets || []).map((asset) => asset.hash).sort(),
})).digest('hex');
const bundleRoot = path.join(backendRoot, 'data', 'paper-studio-render-bundle');
const bundleDirectory = path.join(bundleRoot, bundleKey);
const bundleResult = await ensureBundleCache({
  cacheDirectory: bundleDirectory,
  build: async (temporaryDirectory) => {
    console.log(`[paper-studio-v3] bundle ${mode}`);
    await bundle({
        entryPoint: path.join(rendererRoot, 'entry.jsx'),
        publicDir,
        outDir: temporaryDirectory,
        enableCaching: true,
        onProgress: (progress) => {
          const percent = Math.floor(progress > 1 ? progress : progress * 100);
          if (percent % 25 === 0) process.stdout.write(`\r[paper-studio-v3] bundle ${percent}%`);
        },
    });
    process.stdout.write('\n');
  },
});
const serveUrl = bundleResult.serveUrl;
const bundleCacheHit = bundleResult.cacheHit;
if (bundleCacheHit) console.log(`[paper-studio-v3] bundle cache hit ${bundleKey.slice(0, 12)}`);
const inputProps = { snapshot, debug: false };
const composition = await selectComposition({
  serveUrl,
  id: 'PaperStudioV3',
  inputProps,
  logLevel: 'warn',
  timeoutInMilliseconds: renderTimeoutMs,
  binariesDirectory,
  ...(browser ? { browserExecutable: browser } : {}),
});
const chromiumOptions = { gl: process.env.REMOTION_GL || 'swiftshader' };
const openRenderBrowser = () => openBrowser('chrome', {
  browserExecutable: browser,
  chromiumOptions,
  forceDeviceScaleFactor: 1,
  logLevel: 'warn',
});
// Proof mode reuses Chrome for a bounded batch. The batch/time limits retain
// the old memory-release behavior without paying one browser startup per target.
const puppeteerInstance = mode === 'proof' ? null : await openRenderBrowser();
const proofTargetsPerBrowser = Math.max(1, Number(args['proof-targets-per-browser'] || 5));
const configuredConcurrency = Math.max(1, Number(args.concurrency || Math.min(Math.max(1, Math.floor(os.cpus().length / 2)), 4)));
const renderConcurrency = mode === 'preview' ? Math.min(2, configuredConcurrency) : configuredConcurrency;
let browserSessions = mode === 'proof' ? 0 : 1;

const manifest = {
  version: 3,
  mode,
  snapshot_hash: snapshot.provenance?.snapshot_hash,
  render_hash: snapshot.provenance?.render_hash,
  composition: { id: composition.id, width: composition.width, height: composition.height, fps: composition.fps, duration_in_frames: composition.durationInFrames },
  toolchain: { node: process.version, remotion: require('remotion/package.json').version, renderer: require('@remotion/renderer/package.json').version, browser, binaries_directory: binariesDirectory, scale, bundle_key: bundleKey, bundle_cache_hit: bundleCacheHit, bundle_lock_waited: bundleResult.waitedForLock, render_concurrency: renderConcurrency, proof_targets_per_browser: proofTargetsPerBrowser },
  proofs: {},
  video: null,
};

try {
  if (mode === 'proof') {
    const proofDir = path.join(outputDir, 'proofs');
    fs.mkdirSync(proofDir, { recursive: true });
    let proofBrowser = null;
    let targetsInSession = 0;
    let sessionStartedAt = 0;
    const closeProofBrowser = async () => {
      if (proofBrowser) await proofBrowser.close({ silent: true });
      proofBrowser = null;
      targetsInSession = 0;
      sessionStartedAt = 0;
    };
    const ensureProofBrowser = async (force = false) => {
      if (force || !proofBrowser || targetsInSession >= proofTargetsPerBrowser || Date.now() - sessionStartedAt >= 60_000) {
        await closeProofBrowser();
        proofBrowser = await openRenderBrowser();
        browserSessions += 1;
        sessionStartedAt = Date.now();
      }
      return proofBrowser;
    };
    try {
      for (const target of snapshot.proof_targets || []) {
      const full = path.join(proofDir, `${target.key}-full.png`);
      const repeat = path.join(proofDir, `${target.key}-repeat.png`);
      const debug = path.join(proofDir, `${target.key}-debug.png`);
      const crop = path.join(proofDir, `${target.key}-crop.png`);
      const renderTarget = async (forceNewBrowser = false) => {
        const targetBrowser = await ensureProofBrowser(forceNewBrowser);
        const options = {
          composition, serveUrl, frame: Number(target.frame), imageFormat: 'png', overwrite: true,
          logLevel: 'warn', timeoutInMilliseconds: renderTimeoutMs, binariesDirectory, puppeteerInstance: targetBrowser,
          chromiumOptions, scale, ...(browser ? { browserExecutable: browser } : {}),
        };
        await renderStill({ ...options, inputProps: { snapshot, debug: false }, output: full });
        await renderStill({ ...options, inputProps: { snapshot, debug: false }, output: repeat });
        await renderStill({ ...options, inputProps: { snapshot, debug: true }, output: debug });
      };
      try {
        await renderTarget();
      } catch (error) {
        if (!/Target closed|Session closed|browser.*closed|ECONNRESET|delayRender|timed?\s*out|timeout/i.test(String(error?.message || error))) throw error;
        console.warn(`[paper-studio-v3] proof browser restarted for ${target.key}`);
        await renderTarget(true);
      }
      targetsInSession += 1;
      await cropProof(full, crop, target.crop, Math.round(composition.width * scale), Math.round(composition.height * scale));
      const fullHash = sha256File(full);
      const repeatHash = sha256File(repeat);
      const repeatComparison = fullHash === repeatHash
        ? {
            pass: true,
            same_geometry: true,
            changed_pixels: 0,
            changed_pixel_ratio: 0,
            mean_channel_delta: 0,
            max_channel_delta: 0,
            exact_hash_match: true,
          }
        : { ...(await compareProofFrames(full, repeat)), exact_hash_match: false };
      if (!repeatComparison.pass) {
        throw new Error(`Non-deterministic proof frame: ${target.key} ${JSON.stringify(repeatComparison)}`);
      }
      manifest.proofs[target.key] = {
        frame: Number(target.frame),
        target_node_key: target.target_node_key,
        full_path: full,
        crop_path: crop,
        debug_path: debug,
        full_hash: fullHash,
        repeat_hash: repeatHash,
        crop_hash: sha256File(crop),
        debug_hash: sha256File(debug),
        deterministic: repeatComparison.pass,
        repeat_comparison: repeatComparison,
      };
      }
    } finally {
      await closeProofBrowser();
    }
    manifest.toolchain.browser_sessions = browserSessions;
  } else {
    const output = path.join(outputDir, mode === 'preview' ? 'preview.mp4' : 'formal.mp4');
    await renderMedia({
      composition, serveUrl, inputProps, outputLocation: output, codec: 'h264', pixelFormat: 'yuv420p',
      audioCodec: 'aac', audioBitrate: '192k', sampleRate: 48000, enforceAudioTrack: (snapshot.audio || []).length > 0,
      crf: mode === 'preview' ? Number(args.crf || 28) : Number(args.crf || 20),
      x264Preset: mode === 'preview' ? 'veryfast' : 'medium', colorSpace: 'bt709', overwrite: true,
      concurrency: renderConcurrency, logLevel: 'warn', timeoutInMilliseconds: renderTimeoutMs, binariesDirectory,
      puppeteerInstance, chromiumOptions, scale, ...(browser ? { browserExecutable: browser } : {}),
      onProgress: ({ progress }) => {
        const percent = Math.floor(progress * 100);
        if (percent % 10 === 0) console.log(`[paper-studio-v3] ${mode} ${percent}%`);
      },
    });
    manifest.video = { path: output, hash: sha256File(output), bytes: fs.statSync(output).size };
  }
} finally {
  if (puppeteerInstance) await puppeteerInstance.close({ silent: true });
}

manifest.duration_ms = Date.now() - started;
manifest.completed_at = new Date().toISOString();
const manifestPath = path.join(outputDir, 'manifest.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[paper-studio-v3] manifest ${manifestPath}`);
