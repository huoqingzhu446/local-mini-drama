const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dramaService = require('../src/services/dramaService');
const videoMergeService = require('../src/services/videoMergeService');
const {
  getFfmpegPath,
  hasLocalFfmpeg,
  hasLocalFfprobe,
} = require('../src/utils/ffmpegPath');

const tempDirs = [];
const log = { info() {}, warn() {}, error() {} };

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeVideoSelectionDb(storyboard, generations) {
  return {
    prepare(sql) {
      if (/FROM storyboards/.test(sql)) {
        return { get: (id) => (Number(id) === Number(storyboard.id) ? storyboard : undefined) };
      }
      if (/FROM video_generations/.test(sql)) {
        return {
          get(storyboardId, selectedUrl) {
            const rows = generations
              .filter((row) => Number(row.storyboard_id) === Number(storyboardId) && row.status === 'completed' && !row.deleted_at)
              .sort((a, b) => {
                const rank = (row) => {
                  if (selectedUrl && row.video_url === selectedUrl) return 0;
                  if (selectedUrl && row.local_path && selectedUrl.includes(row.local_path)) return 1;
                  return 2;
                };
                return rank(a) - rank(b) || String(b.created_at || '').localeCompare(String(a.created_at || ''));
              });
            return rows[0];
          },
        };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

test('episode merge resolves the selected video generation instead of storyboard image local_path', () => {
  const db = makeVideoSelectionDb({
    id: 7,
    video_url: 'https://video.example/selected-no-extension',
    local_path: 'media/images/tailframe_6_to_7.jpg',
  }, [{
    id: 11,
    storyboard_id: 7,
    status: 'completed',
    video_url: 'https://video.example/selected-no-extension',
    local_path: 'projects/demo/videos/selected.mp4',
    completed_at: '2026-07-24T01:00:00.000Z',
    updated_at: '2026-07-24T01:00:00.000Z',
    created_at: '2026-07-24T00:00:00.000Z',
  }]);

  assert.equal(
    dramaService.getVideoUrlForStoryboard(db, 7, 'http://localhost:5679/static'),
    'http://localhost:5679/static/projects/demo/videos/selected.mp4'
  );
});

test('episode merge respects an explicitly selected older video generation', () => {
  const db = makeVideoSelectionDb({
    id: 8,
    video_url: 'https://video.example/older',
    local_path: 'media/images/first-frame.jpg',
  }, [
    { id: 20, storyboard_id: 8, status: 'completed', video_url: 'https://video.example/older', local_path: 'projects/demo/videos/older.mp4', created_at: '2026-07-24T01:00:00.000Z' },
    { id: 21, storyboard_id: 8, status: 'completed', video_url: 'https://video.example/newer', local_path: 'projects/demo/videos/newer.mp4', created_at: '2026-07-24T02:00:00.000Z' },
  ]);

  assert.equal(
    dramaService.getVideoUrlForStoryboard(db, 8, 'http://localhost:5679/static'),
    'http://localhost:5679/static/projects/demo/videos/older.mp4'
  );
});

test('ffmpeg merge normalizes mismatched resolution, frame rate, and audio layout', {
  skip: !(hasLocalFfmpeg() && hasLocalFfprobe()),
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-video-merge-'));
  tempDirs.push(dir);
  const clipA = path.join(dir, 'a.mp4');
  const clipB = path.join(dir, 'b.mp4');
  const output = path.join(dir, 'merged.mp4');
  const ffmpeg = getFfmpegPath();

  const a = spawnSync(ffmpeg, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=0.8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    clipA,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(a.status, 0, a.stderr?.slice(-1000));

  const b = spawnSync(ffmpeg, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=0.7',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
    clipB,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(b.status, 0, b.stderr?.slice(-1000));

  const result = videoMergeService._test.runFfmpegConcat([clipA, clipB], output, log);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.mode, 'reencode');
  assert.ok(result.duration >= 1.4 && result.duration <= 1.7, `unexpected duration ${result.duration}`);
  assert.equal(result.info.video.width, 320);
  assert.equal(result.info.video.height, 180);
  assert.ok(result.info.audio, 'merged output should contain a normalized audio track');
});

test('ffmpeg merge rejects an image passed as a video segment', {
  skip: !(hasLocalFfmpeg() && hasLocalFfprobe()),
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-video-image-'));
  tempDirs.push(dir);
  const fakeImage = path.join(dir, 'tailframe.jpg');
  const output = path.join(dir, 'merged.mp4');
  fs.writeFileSync(fakeImage, Buffer.from('not-a-video'));

  const result = videoMergeService._test.runFfmpegConcat([fakeImage], output, log);
  assert.equal(result.ok, false);
  assert.match(result.error, /不含视频流|无法读取/);
  assert.equal(fs.existsSync(output), false);
});
