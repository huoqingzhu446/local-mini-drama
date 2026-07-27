const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const episodeService = require('../src/services/paper-studio/paperStudioEpisodeService');
const storyboardService = require('../src/services/paper-studio/paperStoryboardService');
const audioService = require('../src/services/paper-studio/paperStoryboardAudioService');
const episodeMergeService = require('../src/services/paper-studio/paperEpisodeMergeService');
const videoMergeService = require('../src/services/videoMergeService');
const ttsService = require('../src/services/ttsService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function silentWav(seconds = 0.35, sampleRate = 8000) {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function setup() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-audio-'));
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'有声纸片项目',?,?)").run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, {
    request_id: randomUUID(), title: '第一集', fps: 30, default_duration: 4,
  }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '门口告别', description: '人物站在门口', action: '人物挥手',
    dialogue: '我先走了。明天见！', narration: '暮色落在门前。', duration: 4,
  }).storyboard;
  return { db, storage, cfg: { storage: { local_path: storage } }, project, episode, storyboard };
}

function audioFile(buffer = silentWav()) {
  return { buffer, originalname: 'voice.wav', mimetype: 'audio/wav', size: buffer.length };
}

test('migration 39 creates independent paper audio versions and delivery provenance columns', () => {
  const { db, storage } = setup();
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert.equal(tables.has('paper_storyboard_audio_versions'), true);
    const storyboardColumns = new Set(db.prepare('PRAGMA table_info(paper_storyboards)').all().map((row) => row.name));
    const mergeColumns = new Set(db.prepare('PRAGMA table_info(video_merges)').all().map((row) => row.name));
    assert.equal(storyboardColumns.has('current_dialogue_audio_version_id'), true);
    assert.equal(storyboardColumns.has('audio_mode'), true);
    assert.equal(mergeColumns.has('delivery_hash'), true);
    assert.equal(mergeColumns.has('subtitle_local_path'), true);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('uploaded dialogue and narration become immutable current versions with cues, captions and snapshot hashes', async () => {
  const { db, storage, cfg, storyboard } = setup();
  try {
    const dialogue = await audioService.upload(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: storyboard.version, audio_kind: 'dialogue',
      volume: '0.8', start_seconds: '0.5', captions_enabled: 'true',
    }, audioFile());
    assert.equal(dialogue.audio.ready, false);
    assert.deepEqual(dialogue.audio.missing.map((item) => item.kind), ['narration']);
    assert.equal(dialogue.audio_version.start_frame, 15);
    assert.equal(dialogue.audio_version.volume, 0.8);
    assert.equal(dialogue.audio_version.captions_json.length, 2);
    assert.ok(fs.existsSync(path.join(storage, dialogue.audio_version.local_path)));
    assert.ok(fs.existsSync(path.join(storage, dialogue.audio_version.subtitle_local_path)));

    const narration = await audioService.upload(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: dialogue.storyboard.version, audio_kind: 'narration',
      volume: '0.65', start_seconds: '0', captions_enabled: 'true',
    }, audioFile(silentWav(0.5)));
    assert.equal(narration.audio.ready, true);
    assert.equal(narration.audio.dialogue.id, dialogue.audio_version.id);
    assert.equal(narration.audio.narration.id, narration.audio_version.id);

    const bundle = audioService.snapshotBundle(db, cfg, {
      paper_storyboard_id: storyboard.id,
      storyboard: { dialogue: storyboard.dialogue, narration: storyboard.narration, duration: 4 },
    });
    assert.equal(bundle.sources.length, 2);
    assert.equal(bundle.captions.length, 3);
    assert.ok(bundle.sources.every((item) => item.hash.startsWith('sha256:')));
    assert.deepEqual(bundle.sources.map((item) => item.version_id), [dialogue.audio_version.id, narration.audio_version.id]);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('audio cue and subtitle edits create a new version without mutating the accepted file', async () => {
  const { db, storage, cfg, storyboard } = setup();
  try {
    const uploaded = await audioService.upload(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: storyboard.version, audio_kind: 'dialogue',
      volume: '1', start_seconds: '0', captions_enabled: 'true',
    }, audioFile());
    const revised = audioService.revise(db, cfg, log, storyboard.id, uploaded.audio_version.id, {
      request_id: randomUUID(), expected_version: uploaded.storyboard.version,
      volume: 0.55, start_seconds: 1, captions_enabled: true, caption_text: '我先走了。\n明天见！',
    });
    assert.notEqual(revised.audio_version.id, uploaded.audio_version.id);
    assert.equal(revised.audio_version.parent_version_id, uploaded.audio_version.id);
    assert.equal(revised.audio_version.local_path, uploaded.audio_version.local_path);
    assert.equal(revised.audio_version.audio_hash, uploaded.audio_version.audio_hash);
    assert.equal(revised.audio_version.start_frame, 30);
    assert.equal(revised.audio_version.volume, 0.55);
    assert.equal(db.prepare('SELECT status FROM paper_storyboard_audio_versions WHERE id = ?').get(uploaded.audio_version.id).status, 'superseded');
    assert.equal(revised.audio.dialogue.id, revised.audio_version.id);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('changing saved dialogue invalidates only its audio while preserving narration history', async () => {
  const { db, storage, cfg, storyboard } = setup();
  try {
    const dialogue = await audioService.upload(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: storyboard.version, audio_kind: 'dialogue',
    }, audioFile());
    const narration = await audioService.upload(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: dialogue.storyboard.version, audio_kind: 'narration',
    }, audioFile());
    const updated = storyboardService.update(db, log, storyboard.id, {
      request_id: randomUUID(), expected_version: narration.storyboard.version, dialogue: '我改主意了。',
    });
    assert.equal(updated.current_dialogue_audio_version_id, null);
    assert.equal(updated.current_narration_audio_version_id, narration.audio_version.id);
    assert.equal(db.prepare('SELECT status FROM paper_storyboard_audio_versions WHERE id = ?').get(dialogue.audio_version.id).status, 'stale');
    assert.equal(db.prepare('SELECT status FROM paper_storyboard_audio_versions WHERE id = ?').get(narration.audio_version.id).status, 'ready');
    const workspace = audioService.workspace(db, cfg, storyboard.id);
    assert.deepEqual(workspace.missing.map((item) => item.kind), ['dialogue']);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('TTS writes into the paper storyboard directory and explicit silent mode closes an empty audio gate', async () => {
  const { db, storage, cfg, storyboard } = setup();
  const original = ttsService.synthesize;
  ttsService.synthesize = async (unusedDb, unusedLog, options) => {
    const relative = `${options.output_subdir}/dialogue-fake.wav`;
    const absolute = path.join(storage, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, silentWav());
    return { local_path: relative, provider: 'fixture', model: 'fixture-tts', voice_id: options.voice_id || 'voice-a', speed: options.speed || 1 };
  };
  try {
    const generated = await audioService.synthesize(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: storyboard.version, audio_kind: 'dialogue',
      voice_id: 'voice-a', speed: 1.1, captions_enabled: true,
    });
    assert.match(generated.audio_version.local_path, /paper-studio\/episodes\/\d+\/storyboards\/\d+\/audio/);
    assert.equal(generated.audio_version.provider, 'fixture');

    const clearedText = storyboardService.update(db, log, storyboard.id, {
      request_id: randomUUID(), expected_version: generated.storyboard.version, dialogue: '', narration: '',
    });
    const undecided = audioService.workspace(db, cfg, storyboard.id);
    assert.equal(undecided.ready, false);
    assert.equal(undecided.explicit_silence, false);
    assert.deepEqual(undecided.missing.map((item) => item.kind), ['audio_choice']);
    const silent = audioService.setPolicy(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: clearedText.version, audio_mode: 'silent',
    });
    assert.equal(silent.audio.ready, true);
    assert.equal(silent.audio.explicit_silence, true);
    assert.equal(silent.audio.audio_mode, 'silent');
    assert.equal(silent.storyboard.audio_status, 'ready');
  } finally {
    ttsService.synthesize = original;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('delivery board requires the published snapshot to contain current audio versions and merge history is content-addressed', async () => {
  const { db, storage, cfg, episode, storyboard } = setup();
  const originalProcess = videoMergeService.processVideoMerge;
  videoMergeService.processVideoMerge = async () => {};
  try {
    const dialogue = await audioService.upload(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: storyboard.version, audio_kind: 'dialogue',
    }, audioFile());
    const narration = await audioService.upload(db, cfg, log, storyboard.id, {
      request_id: randomUUID(), expected_version: dialogue.storyboard.version, audio_kind: 'narration',
    }, audioFile());
    const now = '2026-07-26T03:00:00.000Z';
    const renderHash = `sha256:${'b'.repeat(64)}`;
    const snapshotHash = `sha256:${'c'.repeat(64)}`;
    const snapshotId = Number(db.prepare(
      `INSERT INTO paper_render_snapshots
        (shot_id, schema_version, renderer_version, source_revision_hash, snapshot_json,
         snapshot_hash, render_hash, local_path, status, created_at)
       VALUES (900, 3, 'paper-studio-v3.1', ?, ?, ?, ?, 'snapshot.json', 'approved', ?)`,
    ).run(
      `sha256:${'d'.repeat(64)}`,
      JSON.stringify({
        audio: [dialogue.audio_version, narration.audio_version].map((version) => ({ version_id: version.id, hash: version.audio_hash })),
        captions: [],
      }),
      snapshotHash,
      renderHash,
      now,
    ).lastInsertRowid);
    const videoId = Number(db.prepare(
      `INSERT INTO video_generations
        (drama_id, storyboard_id, paper_storyboard_id, provider, model, duration,
         aspect_ratio, video_url, local_path, status, generation_kind, render_hash,
         renderer_version, paper_studio_shot_id, paper_snapshot_id, created_at, updated_at, completed_at)
       VALUES (1, ?, ?, 'local-remotion', 'paper-studio-v3.1', 4, '16:9',
               '/static/final.mp4', 'final.mp4', 'completed', 'paper_studio', ?,
               'paper-studio-v3.1', 900, ?, ?, ?, ?)`,
    ).run(-storyboard.id, storyboard.id, renderHash, snapshotId, now, now, now).lastInsertRowid);
    fs.writeFileSync(path.join(storage, 'final.mp4'), Buffer.from('paper-studio-fixture'));
    db.prepare("UPDATE paper_storyboards SET published_video_generation_id = ?, status = 'published' WHERE id = ?").run(videoId, storyboard.id);

    const board = episodeMergeService.deliveryBoard(db, cfg, episode.id);
    assert.equal(board.ready, true);
    assert.equal(board.items[0].audio_embedded, true);
    assert.equal(board.items[0].subtitle_ready, true);
    assert.deepEqual(board.items[0].audio_version_ids, [dialogue.audio_version.id, narration.audio_version.id]);

    const first = episodeMergeService.create(db, cfg, log, episode.id, {
      request_id: randomUUID(), expected_version: episodeService.get(db, episode.id).version,
    });
    assert.equal(first.reused, false);
    assert.match(first.merge.delivery_hash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(first.merge.subtitle_local_path);
    assert.ok(fs.existsSync(path.join(storage, first.merge.subtitle_local_path)));
    const repeated = episodeMergeService.create(db, cfg, log, episode.id, {
      request_id: randomUUID(), expected_version: episodeService.get(db, episode.id).version,
    });
    assert.equal(repeated.reused, true);
    assert.equal(repeated.merge.id, first.merge.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_merges WHERE paper_episode_id = ?').get(episode.id).count, 1);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    videoMergeService.processVideoMerge = originalProcess;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
