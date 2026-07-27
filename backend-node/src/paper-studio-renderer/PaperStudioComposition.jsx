import React from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { RecursiveNode } from './RecursiveNode';
import { DebugOverlay } from './DebugOverlay';
import { resolveTargetMotion } from './motion/trackResolver.cjs';
import { handheldDelta, depthFor } from './motion/secondaryMotion.cjs';

const safeStaticFile = (src) => {
  const value = String(src || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.includes('..') || /^(?:https?:|data:|file:)/i.test(value)) return null;
  return staticFile(value);
};

const AudioTracks = ({ sources = [], durationFrames }) => (
  <>
    {sources.map((source, index) => {
      const src = safeStaticFile(source?.local_path || source?.src);
      if (!src) return null;
      const from = Math.max(0, Math.round(Number(source.from_frame || 0)));
      const duration = Math.max(1, Math.min(durationFrames - from, Math.round(Number(source.duration_frames || durationFrames))));
      return (
        <Sequence key={`${source.kind || 'audio'}:${index}:${src}`} from={from} durationInFrames={duration} premountFor={30}>
          <Audio src={src} volume={source.volume == null ? 1 : Number(source.volume)} />
        </Sequence>
      );
    })}
  </>
);

const CaptionTracks = ({ captions = [], frame }) => {
  const visible = captions.filter((caption) => frame >= Number(caption.start_frame || 0) && frame < Number(caption.end_frame || 0));
  if (!visible.length) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 950, justifyContent: 'flex-end', alignItems: 'center', padding: '0 7% 6%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        {visible.map((caption) => (
          <div
            key={`${caption.audio_version_id || 'audio'}:${caption.key || caption.start_frame}`}
            style={{
              maxWidth: '82%', padding: '10px 22px 12px', borderRadius: 4,
              background: 'rgba(15, 14, 12, 0.72)', color: '#f4ead5',
              fontFamily: "'PingFang SC', 'Noto Sans CJK SC', sans-serif",
              fontSize: 38, fontWeight: 600, lineHeight: 1.35, letterSpacing: '0.02em',
              textAlign: 'center', textShadow: '0 2px 4px rgba(0,0,0,.88)',
              boxShadow: '0 8px 26px rgba(0,0,0,.2)',
            }}
          >
            {caption.text}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const cameraOverscanScale = (camera) => {
  const requested = Number(camera.scale || 1);
  const maxOffset = Math.max(Math.abs(Number(camera.x || 0)), Math.abs(Number(camera.y || 0)));
  const required = maxOffset > 0 ? 1 + (maxOffset * 2) + 0.012 : 1;
  return Math.max(requested, required);
};

export const PaperStudioComposition = ({ snapshot, debug = false }) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const baseCamera = snapshot.motion_plan ? resolveTargetMotion(snapshot.motion_plan, 'camera', frame) : { x: 0, y: 0, scale: 1, rotation: 0 };
  const quality = snapshot.motion_quality || null;
  // M4 手持质感：低于察觉阈值的确定性慢噪声
  const shake = quality ? handheldDelta(quality, frame, `cam:${snapshot.provenance?.shot_id || 0}`) : { x: 0, y: 0, rotation: 0 };
  const camera = {
    ...baseCamera,
    x: Number(baseCamera.x || 0) + shake.x,
    y: Number(baseCamera.y || 0) + shake.y,
    rotation: Number(baseCamera.rotation || 0) + shake.rotation,
  };
  const assetMap = new Map((snapshot.assets || []).map((asset) => [Number(asset.version_id), asset]));
  const translateX = -Number(camera.x || 0) * width;
  const translateY = -Number(camera.y || 0) * height;
  const parallaxOn = Boolean(quality?.parallax);
  // 视差开启时按最大深度系数放大过扫余量，避免前景层露边
  const cameraScale = parallaxOn
    ? Math.max(cameraOverscanScale(camera), cameraOverscanScale({ ...camera, x: Number(camera.x || 0) * 1.25, y: Number(camera.y || 0) * 1.25 }))
    : cameraOverscanScale(camera);

  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#273138' }}>
      <AbsoluteFill
        style={{
          transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${cameraScale}) rotate(${Number(camera.rotation || 0)}deg)`,
          transformOrigin: '50% 50%',
        }}
      >
        {(snapshot.root?.children || []).slice().sort((a, b) => Number(a.local_z || 0) - Number(b.local_z || 0)).map((node) => {
          // M4 视差：背景/主体/前景按深度系数响应不同的相机位移量
          const depth = parallaxOn ? depthFor(node) : 1;
          const child = <RecursiveNode key={node.key} node={node} snapshot={snapshot} assetMap={assetMap} frame={frame} canvas={{ width, height }} debug={debug} />;
          if (depth === 1) return child;
          return (
            <div key={`parallax:${node.key}`} style={{ position: 'absolute', inset: 0, transform: `translate3d(${translateX * (depth - 1)}px, ${translateY * (depth - 1)}px, 0)` }}>
              {child}
            </div>
          );
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 900, background: 'radial-gradient(circle at 50% 44%, transparent 44%, rgba(24,20,16,0.26) 100%)', mixBlendMode: 'multiply' }} />
      <AudioTracks sources={snapshot.audio || []} durationFrames={durationInFrames} />
      <CaptionTracks captions={snapshot.captions || []} frame={frame} />
      <DebugOverlay snapshot={snapshot} frame={frame} enabled={debug} />
    </AbsoluteFill>
  );
};
