#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    parsed[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return parsed;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveCompositorDir() {
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
}

function probeVideo(videoPath) {
  const compositorDir = resolveCompositorDir();
  const candidates = [
    process.env.FFPROBE_PATH || 'ffprobe',
    compositorDir ? path.join(compositorDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : null,
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
}

function assert(condition, message, details) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

const args = parseArgs(process.argv.slice(2));
const backendRoot = path.resolve(__dirname, '..');
const manifestPath = path.resolve(backendRoot, args.manifest || 'data/paper-slice0/manifest.json');
assert(fs.existsSync(manifestPath), 'manifest does not exist', { manifestPath });
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const expectedProofs = ['first', 'anticipation', 'peak', 'settle', 'final_minus_hold', 'exact_final'];
for (const kind of expectedProofs) {
  const proof = manifest.proofs?.[kind];
  assert(proof, `missing proof: ${kind}`);
  assert(fs.existsSync(proof.path), `proof file missing: ${kind}`, proof);
  assert(sha256(proof.path) === proof.sha256, `proof hash mismatch: ${kind}`, proof);
  if (manifest.repeat_proofs) {
    const repeated = manifest.repeat_proofs[kind];
    assert(repeated && fs.existsSync(repeated.path), `repeat proof missing: ${kind}`, repeated);
    assert(proof.sha256 === repeated.sha256, `proof is not deterministic: ${kind}`, { proof, repeated });
  }
}
assert(manifest.deterministic_proofs !== false, 'determinism flag is false');

const video = manifest.video;
assert(video && fs.existsSync(video.path), 'video file missing', video);
assert(fs.statSync(video.path).size > 10000, 'video file is unexpectedly small', video);
assert(sha256(video.path) === video.sha256, 'video hash mismatch', video);
const ffprobe = probeVideo(video.path);
assert(ffprobe.ok, 'ffprobe failed', ffprobe);

const streams = ffprobe.data.streams || [];
const videoStream = streams.find((stream) => stream.codec_type === 'video');
const audioStream = streams.find((stream) => stream.codec_type === 'audio');
assert(videoStream, 'video stream missing', streams);
assert(audioStream, 'audio stream missing', streams);
assert(videoStream.codec_name === 'h264', 'video codec must be h264', videoStream);
assert(videoStream.pix_fmt === 'yuv420p', 'pixel format must be yuv420p', videoStream);
assert(videoStream.width === manifest.composition.width, 'width mismatch', videoStream);
assert(videoStream.height === manifest.composition.height, 'height mismatch', videoStream);
assert(videoStream.r_frame_rate === `${manifest.composition.fps}/1`, 'fps mismatch', videoStream);
assert(audioStream.codec_name === 'aac', 'audio codec must be aac', audioStream);
assert(Number(audioStream.sample_rate) === 48000, 'audio sample rate must be 48000', audioStream);

const expectedSeconds = manifest.composition.duration_in_frames / manifest.composition.fps;
const videoSeconds = Number(videoStream.duration || ffprobe.data.format.duration);
const containerSeconds = Number(ffprobe.data.format.duration);
assert(Math.abs(videoSeconds - expectedSeconds) <= 1 / manifest.composition.fps, 'video duration differs by more than one frame', {
  expectedSeconds,
  videoSeconds,
  containerSeconds,
});
// AAC encoders may add a small priming/padding tail to the MP4 container.
// Validate the actual video timeline strictly while allowing up to two AAC
// codec frames in the container duration.
assert(containerSeconds >= videoSeconds && containerSeconds - videoSeconds <= 0.1, 'container duration has unexpected tail', {
  videoSeconds,
  containerSeconds,
});

console.log(JSON.stringify({
  ok: true,
  manifest: manifestPath,
  deterministic_proofs: manifest.deterministic_proofs,
  video: {
    path: video.path,
    bytes: video.bytes,
    sha256: video.sha256,
    duration_seconds: videoSeconds,
    container_duration_seconds: containerSeconds,
    width: videoStream.width,
    height: videoStream.height,
    fps: videoStream.r_frame_rate,
    pixel_format: videoStream.pix_fmt,
    audio_codec: audioStream.codec_name,
    sample_rate: audioStream.sample_rate,
  },
}, null, 2));
