import React from 'react';
import { AssetNode } from './AssetNode';
import { ProceduralLayer } from './ProceduralLayer';
import { RegisteredEnvironment } from './RegisteredEnvironment';
import { SupportedSubject } from './SupportedSubject';
import { resolveTargetMotion, velocityFor, stateTransition } from './motion/trackResolver.cjs';
import { secondaryDelta } from './motion/secondaryMotion.cjs';

const percent = (value, fallback = 0) => `${Number(value == null ? fallback : value) * 100}%`;

const roleForNode = (node) => {
  if (node.kind !== 'asset') return 'other';
  if (node.relation?.role === 'front-occluder') return 'other';
  if (node.relation?.predicate === 'held-by' || /^prop/.test(String(node.key))) return 'prop';
  if (node.relation?.role === 'actor' || node.pattern === 'supported-subject' || /^(actor|subject)/.test(String(node.key))) return 'actor';
  return 'other';
};

export const nodeStyle = (node, motion, secondary = null, contactAnchor = null) => {
  const transform = node.transform || {};
  const x = Number(transform.x == null ? 0.5 : transform.x) + Number(motion.x || 0) + Number(secondary?.x || 0);
  const y = Number(transform.y == null ? 0.5 : transform.y) + Number(motion.y || 0) + Number(secondary?.y || 0);
  const anchorX = Number(contactAnchor?.x == null ? (transform.anchor_x == null ? 0.5 : transform.anchor_x) : contactAnchor.x);
  const anchorY = Number(contactAnchor?.y == null ? (transform.anchor_y == null ? 0.5 : transform.anchor_y) : contactAnchor.y);
  const baseScale = Number(transform.scale || 1) * Number(motion.scale || 1);
  const scaleY = baseScale * (1 + Number(secondary?.scaleY || 0));
  const rotation = Number(transform.rotation || 0) + Number(motion.rotation || 0) + Number(secondary?.rotation || 0);
  const skew = Number(secondary?.skewX || 0);
  return {
    position: 'absolute',
    left: percent(x),
    top: percent(y),
    width: percent(transform.width == null ? 1 : transform.width, 1),
    height: percent(transform.height == null ? 1 : transform.height, 1),
    opacity: Number(transform.opacity == null ? 1 : transform.opacity) * Number(motion.opacity == null ? 1 : motion.opacity),
    filter: Number(motion.blur || 0) > 0 ? `blur(${Number(motion.blur).toFixed(3)}px)` : 'none',
    zIndex: Number(node.local_z || 0),
    transformOrigin: `${anchorX * 100}% ${anchorY * 100}%`,
    transform: `translate(${-anchorX * 100}%, ${-anchorY * 100}%) scale(${baseScale}, ${scaleY}) rotate(${rotation}deg)${skew ? ` skewX(${skew}deg)` : ''}`,
    overflow: node.clip?.overflow === 'hidden' ? 'hidden' : 'visible',
  };
};

const Children = ({ node, snapshot, assetMap, frame, canvas, debug }) => (
  <>
    {(node.children || []).slice().sort((a, b) => Number(a.local_z || 0) - Number(b.local_z || 0)).map((child) => (
      <RecursiveNode key={child.key} node={child} snapshot={snapshot} assetMap={assetMap} frame={frame} canvas={canvas} debug={debug} />
    ))}
  </>
);

export const RecursiveNode = ({ node, snapshot, assetMap, frame, canvas, debug }) => {
  const motion = resolveTargetMotion(snapshot.motion_plan, node.key, frame);
  const quality = snapshot.motion_quality || null;
  const role = roleForNode(node);
  let secondary = null;
  let velocity = null;
  if (quality && quality.secondary !== 'off' && role !== 'other') {
    velocity = velocityFor(snapshot.motion_plan, node.key, frame);
    const transform = node.transform || {};
    const tall = Number(transform.height || 0) > 0 && Number(transform.width || 1) > 0
      ? (Number(transform.height) / Number(transform.width)) > 1.6
      : false;
    secondary = secondaryDelta({
      role,
      frame,
      fps: Number(snapshot.composition?.fps || 30),
      velocity,
      seedKey: `${snapshot.provenance?.shot_id || 0}:${node.key}`,
      config: quality,
      relativeHeight: Number(node.relation?.relative_height || 1),
      tall,
    });
    if (node.relation?.placement?.contact_lock) secondary = { ...secondary, y: 0 };
  }
  const contactAnchor = node.relation?.state_contact_anchors?.[motion.state]
    || node.relation?.contact_anchor
    || null;
  const style = nodeStyle(node, motion, secondary, contactAnchor);
  if (node.kind === 'asset') {
    const fade = quality && Number(quality.state_crossfade_frames || 0) > 0
      ? stateTransition(snapshot.motion_plan, node.key, frame, Number(quality.state_crossfade_frames))
      : null;
    return (
      <AssetNode
        node={node}
        motion={motion}
        assetMap={assetMap}
        style={style}
        debug={debug}
        quality={quality}
        role={role}
        velocity={velocity || velocityFor(snapshot.motion_plan, node.key, frame)}
        fps={Number(snapshot.composition?.fps || 30)}
        secondary={secondary}
        stateFade={fade}
      />
    );
  }
  if (node.kind === 'procedural') {
    return <ProceduralLayer node={node} motion={motion} frame={frame} style={style} theme={snapshot.visual_style} assetMap={assetMap} snapshot={snapshot} debug={debug} />;
  }
  const children = <Children node={node} snapshot={snapshot} assetMap={assetMap} frame={frame} canvas={canvas} debug={debug} />;
  if (node.kind === 'registered-environment') return <RegisteredEnvironment node={node} style={style} debug={debug}>{children}</RegisteredEnvironment>;
  if (node.kind === 'supported-subject') return <SupportedSubject node={node} style={style} debug={debug}>{children}</SupportedSubject>;
  return <div data-paper-node={node.key} data-paper-kind={node.kind} style={style}>{children}</div>;
};
