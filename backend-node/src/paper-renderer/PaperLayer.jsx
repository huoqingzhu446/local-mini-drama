import React from 'react';
import { Img, staticFile } from 'remotion';
import { resolveAmbientMotion, resolveLayerMotion } from './motion/layerMotion';
import { PaperOcclusion } from './PaperOcclusion';

export const PaperLayer = ({ layer, frame, camera, composition }) => {
  const base = layer.transform;
  const motion = resolveLayerMotion(layer, frame);
  const ambient = resolveAmbientMotion(layer, frame);
  const depth = layer.depth ?? 0.5;
  const parallaxX = -(camera.x - camera.start.x) * composition.width * depth;
  const parallaxY = -(camera.y - camera.start.y) * composition.height * depth;
  const width = base.width * composition.width;
  const left = (base.x + motion.x) * composition.width;
  const top = (base.y + motion.y) * composition.height;
  const scale = (base.scale ?? 1) * motion.scale;
  const rotation = (base.rotation || 0) + motion.rotation;
  const opacity = (base.opacity ?? 1) * motion.opacity;
  const shadow = layer.paper?.shadow || '0 18px 26px rgba(49, 29, 15, 0.24)';

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width,
        opacity,
        zIndex: layer.z_index,
        transformOrigin: `${(base.anchor_x ?? 0.5) * 100}% ${(base.anchor_y ?? 0.5) * 100}%`,
        transform: `translate(${-((base.anchor_x ?? 0.5) * 100)}%, ${-((base.anchor_y ?? 0.5) * 100)}%) translate3d(${parallaxX}px, ${parallaxY}px, 0) scale(${scale}) rotate(${rotation}deg)`,
      }}
    >
      <div
        style={{
          transform: `translate3d(${ambient.x * composition.width}px, ${ambient.y * composition.height}px, 0) scale(${ambient.scale}) rotate(${ambient.rotation}deg)`,
          // CSS filter rasterization can vary by Chromium process/GPU. Keep
          // the paper silhouette deterministic; a dedicated shadow layer can
          // be added by the snapshot when a soft shadow is required.
          filter: 'none',
        }}
      >
        <PaperOcclusion occlusion={layer.occlusion}>
          <Img src={staticFile(layer.src)} style={{ display: 'block', width: '100%', height: 'auto' }} />
        </PaperOcclusion>
      </div>
    </div>
  );
};
