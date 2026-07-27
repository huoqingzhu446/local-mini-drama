import React from 'react';
import { staticFile } from 'remotion';
import { clamp } from './motion/trackResolver.cjs';

const boundaryBackground = (frame, amount, foreground, appearance) => {
  const phase = Math.round(frame * 0.8) % 120;
  const liquid = appearance === 'liquid';
  const strength = clamp(Number(amount || 0));
  const highlightAlpha = foreground ? 0.16 + strength * 0.16 : 0.07 + strength * 0.08;
  const darkAlpha = foreground ? 0.38 + strength * 0.26 : 0.14 + strength * 0.1;
  const highlight = liquid
    ? `rgba(201,215,207,${highlightAlpha})`
    : `rgba(215,199,168,${highlightAlpha})`;
  const dark = liquid
    ? `rgba(54,77,81,${darkAlpha})`
    : `rgba(71,63,52,${darkAlpha})`;
  return {
    backgroundColor: dark,
    backgroundImage: `linear-gradient(180deg, ${highlight} 0%, transparent 18%), repeating-radial-gradient(ellipse at ${phase}% 0%, transparent 0 18px, ${highlight} 20px 23px, transparent 25px 44px)`,
    backgroundSize: `100% 100%, ${150 + Math.round(amount * 30)}px ${58 + Math.round(amount * 10)}px`,
  };
};

const TransitionParticles = ({ amount, frame, appearance }) => {
  const strength = clamp(Number(amount || 0));
  const liquid = appearance === 'liquid';
  const particles = Array.from({ length: 9 }, (_, index) => {
    const angle = (-78 + (index * 18)) * Math.PI / 180;
    const distance = strength * (22 + ((index * 13) % 34));
    const x = 50 + Math.cos(angle) * distance;
    const y = 78 + Math.sin(angle) * distance;
    const size = 4 + ((index * 5) % 11);
    return <span key={index} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, width: size, height: size * (liquid ? 1.7 : 1), borderRadius: '50%', background: liquid ? 'rgba(218,228,218,.82)' : 'rgba(224,205,169,.78)', opacity: strength, transform: `rotate(${index * 19 + frame * 0.2}deg)` }} />;
  });
  return <div style={{ position: 'absolute', inset: 0, opacity: strength }}>{particles}<div style={{ position: 'absolute', left: '14%', right: '8%', bottom: '10%', height: '26%', borderRadius: '50%', borderTop: `10px solid ${liquid ? 'rgba(211,224,215,.7)' : 'rgba(215,190,151,.62)'}`, transform: `scaleY(${0.3 + strength})` }} /></div>;
};

const AtmosphereDrift = ({ amount, frame, appearance }) => {
  const strength = clamp(Number(amount || 0));
  const cool = appearance === 'mist';
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: 0.18 + strength * 0.58, overflow: 'hidden' }}>
      {Array.from({ length: 7 }, (_, index) => {
        const phase = (frame * (0.06 + index * 0.008) + index * 17) % 100;
        const left = -18 + phase + (index % 2) * 9;
        const top = 6 + (index * 13) % 68;
        const width = 32 + (index * 11) % 34;
        return <span key={index} style={{ position: 'absolute', left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${18 + (index % 3) * 9}%`, borderRadius: '50%', filter: 'blur(22px)', background: cool ? 'rgba(220,226,216,.38)' : 'rgba(208,194,168,.3)', transform: `scale(${0.75 + strength * 0.55})` }} />;
      })}
    </div>
  );
};

const AmbientFlow = ({ amount, frame }) => {
  const strength = clamp(Number(amount || 0));
  return <div style={{ position: 'absolute', inset: 0, opacity: 0.12 + strength * 0.48, backgroundImage: 'repeating-radial-gradient(ellipse at 50% 100%, transparent 0 22px, rgba(214,222,207,.3) 24px 28px, transparent 30px 54px)', backgroundSize: `${180 + strength * 80}px ${62 + strength * 24}px`, backgroundPosition: `${(frame * 0.7) % 120}px ${(frame * 0.18) % 20}px`, mixBlendMode: 'screen' }} />;
};

const safeColor = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : fallback;

const withAlpha = (hex, alpha) => {
  const color = safeColor(hex, '#241C16');
  const value = Number.parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
};

const safeAssetSrc = (localPath) => {
  const value = String(localPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.includes('..') || /^(?:https?:|data:|file:)/i.test(value)) return null;
  return staticFile(value);
};

const registeredBoundary = (node, snapshot) => {
  const family = (snapshot?.source_families || []).find((item) => item.family_key === node.relation?.family_key);
  const slot = (family?.slots || []).find((item) => item.slot_key === node.slot);
  const constraints = slot?.constraints || {};
  return {
    y: clamp(Number(node.relation?.boundary_y ?? constraints.boundary_y ?? 0.53), 0.05, 0.95),
    fillDirection: String(node.relation?.fill_direction || constraints.fill_direction || 'below'),
  };
};

const RouteReveal = ({ node, progress, amount, theme }) => {
  const points = (node.relation?.points || []).map(([x, y]) => [Number(x) * 1000, Number(y) * 600]);
  const pointString = points.map((point) => point.join(',')).join(' ');
  const encirclement = node.relation?.appearance === 'encirclement';
  const paper = safeColor(theme?.palette?.paper, '#D8C9A7');
  const ink = safeColor(theme?.palette?.ink, '#241C16');
  const accent = safeColor(theme?.palette?.accent, '#A3322B');
  const stroke = withAlpha(encirclement ? accent : ink, encirclement ? 0.84 : 0.76);
  const halo = withAlpha(encirclement ? accent : ink, encirclement ? 0.1 : 0.08);
  const lineWidth = encirclement ? 7 : 5;
  const haloWidth = encirclement ? 15 : 11;
  const markerRadius = encirclement ? 9 : 7;
  return (
    <svg viewBox="0 0 1000 600" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: '100%', overflow: 'visible', opacity: encirclement ? Math.max(0.15, amount) : 1, mixBlendMode: 'multiply' }}>
      <polyline points={pointString} pathLength="1" fill="none" stroke={halo} strokeWidth={haloWidth} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1" strokeDashoffset={1 - progress} />
      <polyline points={pointString} pathLength="1" fill="none" stroke={stroke} strokeWidth={lineWidth} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1" strokeDashoffset={1 - progress} />
      {points.map(([x, y], index) => {
        const threshold = points.length <= 1 ? 0 : index / (points.length - 1);
        const visible = clamp((progress - threshold) * 8);
        return <g key={index} opacity={visible}><circle cx={x} cy={y} r={markerRadius} fill={withAlpha(paper, 0.78)} stroke={stroke} strokeWidth={encirclement ? 3 : 2.5} /><circle cx={x} cy={y} r={encirclement ? 2.3 : 1.8} fill={stroke} /></g>;
      })}
    </svg>
  );
};

const EmberField = ({ amount, frame }) => {
  const strength = clamp(Number(amount || 0));
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: strength, background: `radial-gradient(ellipse at 72% 92%, rgba(167,52,24,${0.42 * strength}) 0%, rgba(114,45,21,${0.2 * strength}) 24%, transparent 58%)` }}>
      {Array.from({ length: 22 }, (_, index) => {
        const x = 48 + ((index * 37) % 50);
        const travel = (frame * (0.18 + (index % 5) * 0.035) + index * 7) % 60;
        const y = 94 - travel;
        const size = 3 + (index % 5) * 2;
        return <span key={index} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, width: size, height: size * 1.8, borderRadius: '50%', background: index % 3 === 0 ? '#f0c06a' : '#b94b2b', boxShadow: '0 0 8px rgba(213,91,40,.7)', transform: `rotate(${index * 23 + frame * 0.35}deg)` }} />;
      })}
    </div>
  );
};

export const ProceduralLayer = ({ node, motion, frame, style, theme, assetMap, snapshot, debug }) => {
  const kind = node.relation?.procedural_kind || '';
  const appearance = node.relation?.appearance || 'neutral';
  const amount = clamp(Number(motion.procedural_amount || 0));
  const progress = clamp(Number(motion.clip_progress || 0));
  if (kind === 'transition-effect') {
    return <div data-paper-node={node.key} data-paper-kind="procedural-transition-effect" data-proof-amount={amount.toFixed(4)} style={{ ...style, outline: debug ? '2px solid rgba(216,235,235,.5)' : 'none' }}><TransitionParticles amount={amount} frame={frame} appearance={appearance} /></div>;
  }
  if (kind === 'atmosphere-drift') {
    return <div data-paper-node={node.key} data-paper-kind="procedural-atmosphere" data-proof-amount={amount.toFixed(4)} style={{ ...style, outline: debug ? '2px solid rgba(216,235,235,.5)' : 'none' }}><AtmosphereDrift amount={amount} frame={frame} appearance={appearance} /></div>;
  }
  if (kind === 'ambient-flow') {
    return <div data-paper-node={node.key} data-paper-kind="procedural-ambient-flow" data-proof-amount={amount.toFixed(4)} style={{ ...style, outline: debug ? '2px solid rgba(216,235,235,.5)' : 'none' }}><AmbientFlow amount={amount} frame={frame} /></div>;
  }
  if (kind === 'route-reveal') {
    return <div data-paper-node={node.key} data-paper-kind="procedural-route-reveal" data-proof-progress={progress.toFixed(4)} style={{ ...style, outline: debug ? '2px solid rgba(216,180,90,.55)' : 'none' }}><RouteReveal node={node} progress={progress} amount={amount} theme={theme} /></div>;
  }
  if (kind === 'ember-field') {
    return <div data-paper-node={node.key} data-paper-kind="procedural-ember-field" data-proof-amount={amount.toFixed(4)} style={{ ...style, outline: debug ? '2px solid rgba(222,104,61,.55)' : 'none' }}><EmberField amount={amount} frame={frame} /></div>;
  }
  const foreground = kind === 'boundary-front' || kind === 'foreground-layer';
  const boundary = registeredBoundary(node, snapshot);
  const versionId = node.asset_version_id == null ? null : Number(node.asset_version_id);
  const maskAsset = versionId == null ? null : assetMap?.get(versionId);
  const maskSrc = foreground ? safeAssetSrc(maskAsset?.local_path) : null;
  const fillBelow = boundary.fillDirection !== 'above';
  const registeredStyle = maskSrc ? {
    ...style,
    left: '50%',
    top: '50%',
    width: '100%',
    height: '100%',
    transform: 'translate(-50%, -50%)',
    maskImage: `url("${maskSrc}")`,
    maskMode: 'luminance',
    maskSize: '100% 100%',
    maskRepeat: 'no-repeat',
  } : {
    ...style,
    left: '0%',
    top: fillBelow ? `${boundary.y * 100}%` : '0%',
    width: '100%',
    height: `${(fillBelow ? 1 - boundary.y : boundary.y) * 100}%`,
    transform: 'none',
  };
  return (
    <div data-paper-node={node.key} data-paper-kind={foreground ? 'procedural-boundary-front' : 'procedural-boundary-back'} data-proof-amount={amount.toFixed(4)} data-boundary-mask={maskSrc ? 'registered' : 'geometry'} style={{ ...registeredStyle, ...boundaryBackground(frame, amount, foreground, appearance), outline: debug ? '2px solid rgba(109,180,202,.6)' : 'none', boxShadow: foreground ? '0 -8px 22px rgba(178,204,201,.18)' : 'none' }} />
  );
};
