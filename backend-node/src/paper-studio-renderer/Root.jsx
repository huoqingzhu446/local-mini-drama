import React from 'react';
import { Composition } from 'remotion';
import { PaperStudioComposition } from './PaperStudioComposition';

const fallbackSnapshot = {
  schema_version: 3,
  renderer_version: 'paper-studio-v3.1',
  source_revision_hash: `sha256:${'0'.repeat(64)}`,
  composition: { width: 1920, height: 1080, fps: 30, duration_frames: 150 },
  visual_style: { medium: 'tactile-2d-paper-animation', palette: { paper: '#D8C9A7', ink: '#241C16', accent: '#A3322B', secondary: '#B38A4A' }, texture: '', lighting: '' },
  assets: [],
  root: { key: 'root', kind: 'group', pattern: 'free', transform: {}, children: [] },
  motion_plan: { schema_version: 1, fps: 30, duration_frames: 150, primary_action: 'fixture', camera_only: false, subject_tracks: [], camera_tracks: [] },
  proof_targets: [],
  provenance: {},
};

const metadataFromSnapshot = ({ props }) => {
  const snapshot = props?.snapshot || fallbackSnapshot;
  return {
    durationInFrames: snapshot.composition.duration_frames,
    fps: snapshot.composition.fps,
    width: snapshot.composition.width,
    height: snapshot.composition.height,
    props: { ...props, snapshot },
  };
};

export const RemotionRoot = () => (
  <Composition
    id="PaperStudioV3"
    component={PaperStudioComposition}
    durationInFrames={fallbackSnapshot.composition.duration_frames}
    fps={fallbackSnapshot.composition.fps}
    width={fallbackSnapshot.composition.width}
    height={fallbackSnapshot.composition.height}
    defaultProps={{ snapshot: fallbackSnapshot, debug: false }}
    calculateMetadata={metadataFromSnapshot}
  />
);
