const test = require('node:test');
const assert = require('node:assert/strict');
const paperSpecCompiler = require('../src/services/paperSpecCompiler');

function makeDb({ duration = 120, timingStatus = 'unlocked', audio = {} } = {}) {
  const timing = {
    source: 'draft',
    phases: [
      { name: 'anticipation', start_frame: 0, end_frame: 10 },
      { name: 'peak', start_frame: 40, end_frame: 60 },
      { name: 'settle', start_frame: 60, end_frame: 75 },
      { name: 'hold', start_frame: 90, end_frame: duration },
    ],
    cues: [{ id: 'stale', kind: 'manual_cue', frame: 7 }],
  };
  const audioJson = {
    timing,
    // The locker writes these fields at the top level. They must override the
    // planner's nested draft values when both shapes exist.
    source: 'manual',
    cues: [{ id: 'voice-peak', kind: 'speech_peak', frame: 33 }],
    sources: [],
    enforce_audio_track: false,
    ...audio,
  };
  const composition = {
    id: 1, drama_id: 1, episode_id: 1, storyboard_id: 10, sequence_id: null,
    sequence_index: 1, template_key: 'paper_history_v1', width: 1920,
    height: 1080, fps: 30, duration_frames: duration, camera_json: '{}',
    continuity_json: '{}', audio_json: JSON.stringify(audioJson),
    audio_timing_status: timingStatus, audio_timing_hash: 'timing-hash', deleted_at: null,
  };
  return {
    prepare(sql) {
      if (sql.includes('FROM paper_compositions')) return { get: () => composition };
      if (sql.includes('FROM storyboards')) return { get: () => ({ id: 10 }) };
      if (sql.includes('FROM paper_layers')) return { all: () => [] };
      throw new Error(`Unexpected fake DB query: ${sql}`);
    },
  };
}

test('paperSpecCompiler emits the six clamped proof frames and prefers speech_peak', () => {
  const db = makeDb();
  assert.throws(
    () => paperSpecCompiler.compile(db, {}, 1),
    (error) => error.code === 'PAPER_TIMING_NOT_LOCKED'
  );

  const compiled = paperSpecCompiler.compile(db, {}, 1, { allowProvisional: true });
  assert.deepEqual(compiled.snapshot.proof_frames, {
    first: 0,
    anticipation: 9,
    peak: 33,
    settle: 74,
    final_minus_hold: 89,
    exact_final: 119,
  });
  assert.equal(compiled.snapshot.timing.source, 'manual');
  assert.equal(compiled.snapshot.timing.cues[0].kind, 'speech_peak');
  assert.deepEqual(compiled.snapshot.audio.cues, compiled.snapshot.timing.cues);
});

test('paperSpecCompiler uses peak midpoint and exact_final - 1 without a hold', () => {
  const db = makeDb({
    duration: 5,
    audio: {
      cues: [],
      timing: {
        phases: [
          { name: 'anticipation', start_frame: 0, end_frame: 1 },
          { name: 'peak', start_frame: 1, end_frame: 4 },
          { name: 'settle', start_frame: 4, end_frame: 5 },
        ],
      },
    },
    timingStatus: 'locked',
  });
  const frames = paperSpecCompiler.compile(db, {}, 1).snapshot.proof_frames;
  assert.deepEqual(frames, {
    first: 0,
    anticipation: 0,
    peak: 2,
    settle: 4,
    final_minus_hold: 3,
    exact_final: 4,
  });
});

test('proof frames never exceed a one-frame composition', () => {
  const db = makeDb({
    duration: 1,
    timingStatus: 'locked',
    audio: {
      cues: [{ kind: 'speech_peak', frame: 999 }],
      timing: {
        phases: [
          { name: 'anticipation', start_frame: 9, end_frame: 999 },
          { name: 'peak', start_frame: 9, end_frame: 999 },
          { name: 'settle', start_frame: 9, end_frame: 999 },
          { name: 'hold', start_frame: 999, end_frame: 999 },
        ],
      },
    },
  });
  const frames = paperSpecCompiler.compile(db, {}, 1).snapshot.proof_frames;
  for (const frame of Object.values(frames)) assert.equal(frame, 0);
});

test('layer phase tracks compile to seek-safe keyframes with a neutral prefix', () => {
  const motion = paperSpecCompiler.trackToLegacyMotion({
    tracks: [{ target: 'layer', property: 'y', phase: 'settle', from: 0.01, to: 0, ease: 'sine.out' }],
  }, [
    { name: 'action', start_frame: 10, end_frame: 40 },
    { name: 'settle', start_frame: 40, end_frame: 60 },
  ]);
  assert.deepEqual(motion.tracks[0].keyframes.map(({ frame, value }) => ({ frame, value })), [
    { frame: 39, value: 0 },
    { frame: 40, value: 0.01 },
    { frame: 59, value: 0 },
  ]);
});
