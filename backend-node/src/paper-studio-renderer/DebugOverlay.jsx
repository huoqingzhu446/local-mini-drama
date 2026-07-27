import React from 'react';

export const DebugOverlay = ({ snapshot, frame, enabled }) => {
  if (!enabled) return null;
  const cue = (snapshot.motion_plan?.cues || []).filter((item) => item.frame <= frame).slice(-1)[0];
  return (
    <>
      <div style={{ position: 'absolute', zIndex: 2000, left: 28, top: 24, padding: '10px 13px', color: '#f3e3bc', background: 'rgba(16,18,18,.78)', font: '15px ui-monospace, monospace', lineHeight: 1.5 }}>
        <div>PAPER STUDIO V3 · FRAME {String(frame).padStart(4, '0')}</div>
        <div>ACTION {snapshot.motion_plan?.primary_action || 'unknown'} · CUE {cue?.key || '—'}</div>
        <div>SNAPSHOT {String(snapshot.provenance?.snapshot_hash || '').slice(0, 22)}</div>
      </div>
      <div style={{ position: 'absolute', zIndex: 1999, left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(220,175,80,.2)' }} />
      <div style={{ position: 'absolute', zIndex: 1999, left: 0, right: 0, top: '50%', height: 1, background: 'rgba(220,175,80,.2)' }} />
    </>
  );
};
