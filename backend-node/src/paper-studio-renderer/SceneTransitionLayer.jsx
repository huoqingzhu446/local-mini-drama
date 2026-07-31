import React from 'react';
import { clamp } from './motion/trackResolver.cjs';

const hash = (text) => [...String(text || '')].reduce((value, char) => ((value * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
const unit = (seed, index) => {
  const value = Math.sin((seed + index * 977) * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

export const SceneTransitionLayer = ({ node, amount, frame, theme }) => {
  const strength = clamp(Number(amount || 0));
  const direction = node.relation?.direction === 'right' ? 1 : -1;
  const seed = hash(node.relation?.transition_key || node.key);
  const paper = theme?.palette?.paper || '#D8C9A7';
  const ink = theme?.palette?.ink || '#241C16';
  return (
    <div
      data-paper-node={node.key}
      data-paper-kind="scene-transition-dust"
      data-transition-key={node.relation?.transition_key || ''}
      data-proof-amount={strength.toFixed(4)}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', opacity: strength, pointerEvents: 'none' }}
    >
      <div style={{
        position: 'absolute', inset: '-15%',
        transform: `translateX(${direction * (1 - strength) * 16}%) skewX(${direction * -8}deg)`,
        background: `linear-gradient(${direction > 0 ? 90 : 270}deg, transparent 2%, ${paper}33 28%, ${paper}B8 54%, ${ink}28 78%, transparent 98%)`,
        filter: `blur(${6 + strength * 16}px)`,
      }} />
      {Array.from({ length: 26 }, (_, index) => {
        const drift = direction * ((frame * (0.16 + unit(seed, index + 200) * 0.18)) % 24);
        const x = unit(seed, index) * 118 - 9 + direction * (1 - strength) * 18 + drift;
        const y = unit(seed, index + 40) * 100;
        const size = 8 + unit(seed, index + 80) * 38;
        const alpha = 0.18 + unit(seed, index + 120) * 0.42;
        return (
          <span key={index} style={{
            position: 'absolute', left: `${x}%`, top: `${y}%`, width: size, height: size * (0.35 + unit(seed, index + 160) * 0.8),
            borderRadius: '50%', background: index % 4 === 0 ? ink : paper, opacity: alpha * strength,
            filter: `blur(${2 + size * 0.12}px)`, transform: `rotate(${direction * (index * 17 + frame * 0.8)}deg)`,
          }} />
        );
      })}
    </div>
  );
};
