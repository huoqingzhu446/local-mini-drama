import React from 'react';
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { PaperLayer } from './PaperLayer';
import { PaperRig } from './PaperRig';
import { resolveCamera } from './motion/cameraMotion';

const TechnicalOverlay = ({ snapshot, frame }) => {
  if (!snapshot.provenance?.debug_overlay) return null;
  return (
  <>
    <div
      style={{
        position: 'absolute',
        left: 64,
        top: 54,
        zIndex: 1000,
        color: '#f5e7c6',
        fontFamily: 'Georgia, serif',
        letterSpacing: 5,
        fontSize: 20,
        textShadow: '0 2px 8px rgba(0,0,0,0.45)',
      }}
    >
      PAPER LAYER · SLICE 0
    </div>
    <div
      style={{
        position: 'absolute',
        right: 60,
        bottom: 44,
        zIndex: 1000,
        color: 'rgba(245,231,198,0.78)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 17,
        letterSpacing: 2,
      }}
    >
      {snapshot.composition.fps} FPS · FRAME {String(frame).padStart(3, '0')} · 4 DEPTH LAYERS
    </div>
  </>
  );
};

const AudioTrack = ({ snapshot }) => {
  const sources = Array.isArray(snapshot.audio?.sources) ? snapshot.audio.sources : [];
  return (
    <>
      {sources.map((source) => source?.src ? (
        <Audio key={`${source.kind || 'audio'}:${source.src}`} src={staticFile(source.src)} volume={source.volume == null ? 1 : source.volume} />
      ) : null)}
    </>
  );
};

export const PaperComposition = ({ snapshot }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const composition = { ...snapshot.composition, width, height };
  const camera = resolveCamera(snapshot, frame);
  const layers = [...snapshot.layers].sort((a, b) => a.z_index - b.z_index || a.key.localeCompare(b.key));
  const translateX = -(camera.x - 0.5) * width;
  const translateY = -(camera.y - 0.5) * height;

  return (
    <AbsoluteFill style={{ backgroundColor: '#25150e', overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${camera.scale}) rotate(${camera.rotation}deg)`,
          transformOrigin: '50% 50%',
        }}
      >
        {layers.map((layer) => {
          if (layer.rig_id) {
            const rig = snapshot.rigs.find((candidate) => candidate.id === layer.rig_id);
            return rig ? <PaperRig key={layer.key} layer={layer} rig={rig} frame={frame} camera={camera} composition={composition} /> : null;
          }
          return <PaperLayer key={layer.key} layer={layer} frame={frame} camera={camera} composition={composition} />;
        })}
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          zIndex: 900,
          pointerEvents: 'none',
          backgroundImage: 'radial-gradient(circle at 50% 42%, transparent 34%, rgba(25,10,4,0.46) 100%), repeating-linear-gradient(7deg, rgba(255,245,210,0.018) 0, rgba(255,245,210,0.018) 1px, transparent 1px, transparent 5px)',
          mixBlendMode: 'multiply',
        }}
      />
      <TechnicalOverlay snapshot={snapshot} frame={frame} />
      <AudioTrack snapshot={snapshot} />
    </AbsoluteFill>
  );
};
