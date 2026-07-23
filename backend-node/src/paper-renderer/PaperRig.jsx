import React from 'react';
import { Img, staticFile } from 'remotion';
import { resolveAmbientMotion, resolveLayerMotion } from './motion/layerMotion';
import { resolvePartMotion } from './motion/rigMotion';
import { PaperOcclusion, resolveOcclusion } from './PaperOcclusion';

const Part = ({ part, parts, rig, frame, rigWidth, durationFrames, occlusion }) => {
  const children = parts.filter((candidate) => candidate.parent === part.key).sort((a, b) => (a.z_index || 0) - (b.z_index || 0));
  const motion = resolvePartMotion(rig, part, frame, durationFrames);
  const initial = part.initial_transform || {};
  const width = Number(part.width || 1) * rigWidth;
  const height = width / Number(part.aspect_ratio || 1);
  const left = Number(part.offset?.[0] ?? initial.x ?? 0) * rigWidth;
  const top = Number(part.offset?.[1] ?? initial.y ?? 0) * rigWidth;
  const pivotX = part.pivot?.[0] ?? 0.5;
  const pivotY = part.pivot?.[1] ?? 0.5;
  const scale = Number(initial.scale ?? 1) * motion.scale;
  const rotation = Number(initial.rotation ?? part.initial_rotation ?? 0) + motion.rotation;
  const opacity = Number(initial.opacity ?? 1) * motion.opacity;
  const imageFrameStyle = {
    position: 'absolute',
    left: -pivotX * width,
    top: -pivotY * height,
    width,
    height,
  };
  const resolvedOcclusion = resolveOcclusion(occlusion, part.key);
  const image = resolvedOcclusion.enabled ? (
    <PaperOcclusion occlusion={occlusion} partKey={part.key} style={imageFrameStyle}>
      <Img
        src={staticFile(part.src)}
        style={{ display: 'block', width: '100%', height: '100%', filter: 'none' }}
      />
    </PaperOcclusion>
  ) : (
    <Img
      src={staticFile(part.src)}
      style={{ ...imageFrameStyle, filter: 'none' }}
    />
  );

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: 1,
        height: 1,
        zIndex: part.z_index || 0,
        opacity,
        transform: `translate3d(${motion.x * rigWidth}px, ${motion.y * rigWidth}px, 0) rotate(${rotation}deg) scale(${scale})`,
        transformOrigin: '0 0',
      }}
    >
      {image}
      {children.map((child) => (
        <Part key={child.key} part={child} parts={parts} rig={rig} frame={frame} rigWidth={rigWidth} durationFrames={durationFrames} occlusion={occlusion} />
      ))}
    </div>
  );
};

export const PaperRig = ({ layer, rig, frame, camera, composition }) => {
  const base = layer.transform;
  const motion = resolveLayerMotion(layer, frame);
  const ambient = resolveAmbientMotion(layer, frame);
  const depth = layer.depth ?? 0.7;
  const parallaxX = -(camera.x - camera.start.x) * composition.width * depth;
  const parallaxY = -(camera.y - camera.start.y) * composition.height * depth;
  const rigWidth = base.width * composition.width;
  const left = (base.x + motion.x) * composition.width;
  const top = (base.y + motion.y) * composition.height;
  const root = rig.parts.find((part) => part.key === rig.root);
  if (!root) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: 1,
        height: 1,
        opacity: (base.opacity ?? 1) * motion.opacity,
        zIndex: layer.z_index,
        transform: `translate3d(${parallaxX}px, ${parallaxY}px, 0) scale(${(base.scale ?? 1) * motion.scale}) rotate(${(base.rotation || 0) + motion.rotation}deg)`,
        transformOrigin: '0 0',
      }}
    >
      <div
        style={{
          transform: `translate3d(${ambient.x * composition.width}px, ${ambient.y * composition.height}px, 0) scale(${ambient.scale}) rotate(${ambient.rotation}deg)`,
          transformOrigin: '0 0',
        }}
      >
        <Part part={root} parts={rig.parts} rig={rig} frame={frame} rigWidth={rigWidth} durationFrames={composition.duration_frames} occlusion={layer.occlusion} />
      </div>
    </div>
  );
};
