import React from 'react';
import { Img, staticFile } from 'remotion';
import occlusionModel from './motion/occlusionModel.cjs';

const { resolveOcclusion } = occlusionModel;

const cssUrl = (src) => {
  if (!src) return undefined;
  // staticFile() returns a URL that is safe for the staged public directory;
  // quote it so spaces and unicode names cannot change the CSS tokenization.
  const url = staticFile(src).replace(/\\/g, '/').replace(/"/g, '\\"');
  return `url("${url}")`;
};

/**
 * Apply a local SVG/raster mask and/or clip path to one semantic paper image.
 * The wrapper is deliberately sized to the image itself (rather than the
 * rig's 1px pivot node), so the mask coordinate system remains stable while
 * parent joints rotate. The foreground/occluder layer is still drawn by the
 * normal z-index sort in PaperComposition.
 */
export const PaperOcclusion = ({ occlusion = {}, partKey = null, children, style = {}, className }) => {
  const resolved = resolveOcclusion(occlusion, partKey);
  if (!resolved.enabled) return children;

  const maskImage = cssUrl(resolved.mask_src);
  const maskStyle = maskImage ? {
    maskImage,
    WebkitMaskImage: maskImage,
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
  } : {};
  // WebKit's xor mask composite is the only broadly available CSS way to
  // invert a local alpha mask. It is inert unless the snapshot opts in.
  if (resolved.invert && maskImage) {
    maskStyle.WebkitMaskComposite = 'xor';
    maskStyle.maskComposite = 'exclude';
  }

  return (
    <div
      className={className}
      data-paper-occlusion={resolved.group || 'mask'}
      data-paper-occluder={resolved.occluder_layer_key || undefined}
      style={{
        ...style,
        ...(resolved.clip_path ? { clipPath: resolved.clip_path, WebkitClipPath: resolved.clip_path } : {}),
        ...maskStyle,
      }}
    >
      {resolved.mask_src ? (
        <Img
          src={staticFile(resolved.mask_src)}
          aria-hidden="true"
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        />
      ) : null}
      {children}
    </div>
  );
};

export { resolveOcclusion };
