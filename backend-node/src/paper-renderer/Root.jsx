import React from 'react';
import { Composition } from 'remotion';
import { PaperComposition } from './PaperComposition';
import slice0Snapshot from './fixtures/slice0-snapshot.json';

const metadataFromSnapshot = ({ props }) => {
  const snapshot = props?.snapshot || slice0Snapshot;
  const composition = snapshot.composition;
  return {
    durationInFrames: composition.duration_frames,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    props: { ...props, snapshot },
  };
};

export const RemotionRoot = () => (
  <Composition
    id="PaperLayerSlice0"
    component={PaperComposition}
    durationInFrames={slice0Snapshot.composition.duration_frames}
    fps={slice0Snapshot.composition.fps}
    width={slice0Snapshot.composition.width}
    height={slice0Snapshot.composition.height}
    defaultProps={{ snapshot: slice0Snapshot }}
    calculateMetadata={metadataFromSnapshot}
  />
);
