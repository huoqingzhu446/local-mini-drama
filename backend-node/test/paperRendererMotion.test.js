const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rigTrackModel = require('../src/paper-renderer/motion/rigTrackModel.cjs');
const occlusionModel = require('../src/paper-renderer/motion/occlusionModel.cjs');

const rig = {
  rig_key: 'character-8-front',
  parts: [
    { key: 'torso' },
    { key: 'head' },
    { key: 'arm_front' },
  ],
  tracks: [
    { target: 'rig.character-8-front.arm_front', property: 'rotation', from: 0, to: 18 },
    { target: 'head', property: 'rotation', keyframes: [{ frame: 0, value: 0 }, { frame: 20, value: -5 }] },
    { target: 'layer', property: 'y', from: 0.01, to: 0 },
  ],
};

test('rig target normalizer accepts compiled and legacy part targets only', () => {
  const partKeys = new Set(rig.parts.map((part) => part.key));
  assert.equal(
    rigTrackModel.normalizeRigPartTarget('rig.character-8-front.arm_front', rig.rig_key, partKeys),
    'arm_front',
  );
  assert.equal(rigTrackModel.normalizeRigPartTarget('rig.head', rig.rig_key, partKeys), 'head');
  assert.equal(rigTrackModel.normalizeRigPartTarget('head', rig.rig_key, partKeys), 'head');
  assert.equal(rigTrackModel.normalizeRigPartTarget('layer', rig.rig_key, partKeys), null);
  assert.equal(rigTrackModel.normalizeRigPartTarget('rig.character-8-front.unknown', rig.rig_key, partKeys), null);
});

test('only rig part tracks are returned as rig motion and changes are measurable', () => {
  const tracks = rigTrackModel.rigMotionTracks(rig, { tracks: rig.tracks });
  assert.equal(tracks.length, 2);
  assert.ok(tracks.every((track) => track.target !== 'layer'));
  assert.equal(rigTrackModel.trackHasSpatialChange(tracks[0]), true);
  assert.equal(rigTrackModel.trackHasSpatialChange({ keyframes: [{ frame: 0, value: 2 }, { frame: 10, value: 2 }] }), false);
  assert.deepEqual(rigTrackModel.numericTrackValues(tracks[0]), [0, 18]);
});

test('occlusion model scopes masks to affected rig parts and normalizes clip paths', () => {
  const occlusion = {
    group: 'body-front',
    affected_part_keys: ['arm_front', 'arm_front', 'prop'],
    clip_path: [[0, 0], [1, 0], [1, 1], [0, 1]],
    mask_src: 'projects/demo/paper/mask.svg',
    feather_px: 2,
  };
  const arm = occlusionModel.resolveOcclusion(occlusion, 'arm_front');
  const head = occlusionModel.resolveOcclusion(occlusion, 'head');
  assert.equal(arm.enabled, true);
  assert.equal(head.enabled, false);
  assert.equal(arm.clip_path, 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)');
  assert.equal(arm.mask_src, 'projects/demo/paper/mask.svg');
  assert.deepEqual(arm.affected_part_keys, ['arm_front', 'prop']);
  assert.equal(occlusionModel.resolveOcclusion({ mask_src: '../escape.svg' }, null).enabled, false);
});

test('renderer source keeps foreground z-order and wires rig/occlusion components', () => {
  const rendererRoot = path.join(__dirname, '..', 'src', 'paper-renderer');
  const rigSource = fs.readFileSync(path.join(rendererRoot, 'PaperRig.jsx'), 'utf8');
  const compositionSource = fs.readFileSync(path.join(rendererRoot, 'PaperComposition.jsx'), 'utf8');
  assert.match(rigSource, /resolvePartMotion/);
  assert.match(rigSource, /PaperOcclusion/);
  assert.match(compositionSource, /sort\(\(a, b\) => a\.z_index - b\.z_index/);
});

test('paper renderer schemas expose rig keyframes and local occlusion fields', () => {
  const schemaRoot = path.join(__dirname, '..', 'src', 'paper-renderer', 'schema');
  const animation = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'animation.schema.json'), 'utf8'));
  const paperSpec = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'paperSpec.schema.json'), 'utf8'));
  assert.ok(animation.$defs.track.properties.keyframes);
  assert.ok(animation.$defs.keyframe.anyOf.some((rule) => rule.required.includes('offset')));
  assert.ok(paperSpec.$defs.occlusion.properties.clip_path);
  assert.ok(paperSpec.$defs.occlusion.properties.mask_src);
  assert.ok(paperSpec.$defs.occlusion.properties.affected_part_keys);
});
