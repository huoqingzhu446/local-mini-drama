import React from 'react';
import { Img, staticFile } from 'remotion';
import { ContactShadow } from './ContactShadow';

const safeSrc = (localPath) => {
  const value = String(localPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.includes('..') || /^(?:https?:|data:|file:)/i.test(value)) return null;
  return staticFile(value);
};

function versionIdForState(node, state) {
  const stateVersions = node.relation?.state_asset_version_ids || {};
  if (state != null && stateVersions[state] != null) return Number(stateVersions[state]);
  return node.asset_version_id == null ? null : Number(node.asset_version_id);
}

function srcForState(node, state, assetMap) {
  const versionId = versionIdForState(node, state);
  const asset = versionId == null ? null : assetMap.get(versionId);
  return { versionId, src: safeSrc(asset?.local_path) };
}

export const AssetNode = ({ node, motion, assetMap, style, debug, quality = null, role = 'other', velocity = null, fps = 30, secondary = null, stateFade = null }) => {
  const current = srcForState(node, motion.state, assetMap);
  const isCutout = role === 'actor' || role === 'prop';

  // M3 边缘处理：半像素暗描边压住抠图锯齿，同时贴合剪纸描边审美
  const edgeFilter = quality && isCutout ? 'drop-shadow(0 0 0.5px rgba(0,0,0,0.35))' : 'none';
  const imgStyle = { display: 'block', width: '100%', height: '100%', objectFit: node.relation?.fit || 'contain', filter: edgeFilter };

  // M3 残影式运动模糊：速度超过阈值时沿速度反方向叠两层低透明残影
  const speedPerSecond = Number(velocity?.speed || 0) * Number(fps || 30);
  const smearActive = Boolean(quality?.smear) && isCutout && speedPerSecond > 0.15 && current.src;
  const smearX = smearActive ? -Number(velocity.vx || 0) * 100 : 0; // 相对节点尺寸的百分比位移
  const smearY = smearActive ? -Number(velocity.vy || 0) * 100 : 0;

  // M6 状态交叉过渡：语义状态切换时前后两版素材 3 帧交叉溶解
  const previous = stateFade && stateFade.previous != null && stateFade.progress < 1
    ? srcForState(node, stateFade.previous, assetMap)
    : null;
  const fadeProgress = previous ? Math.max(0, Math.min(1, stateFade.progress)) : 1;

  // M3 接触阴影：角色与未被携带的道具接地
  const held = node.relation?.predicate === 'held-by';
  const shadowEnabled = Boolean(quality?.contact_shadow?.enabled) && isCutout && !held && current.src;
  // 起伏抬升时阴影缩小变浅（脚离地暗示）
  const lift = Math.max(0, -Number(secondary?.y || 0));
  const contactAnchor = node.relation?.state_contact_anchors?.[motion.state]
    || node.relation?.contact_anchor
    || null;
  const anchorY = Number(contactAnchor?.y == null ? (node.transform?.anchor_y == null ? 0.88 : node.transform.anchor_y) : contactAnchor.y);

  return (
    <div data-paper-node={node.key} data-paper-kind="asset" data-paper-version={current.versionId || ''} data-paper-state={motion.state || ''} style={{ ...style, outline: debug ? '2px solid rgba(238,184,83,.5)' : 'none' }}>
      {shadowEnabled ? (
        <ContactShadow
          opacity={Number(quality?.contact_shadow?.opacity || 0.34) * (1 - Math.min(0.15, lift * 25))}
          scale={1 - Math.min(0.12, lift * 30)}
          groundY={anchorY}
          role={role}
        />
      ) : null}
      {smearActive ? (
        <>
          <Img src={current.src} style={{ ...imgStyle, position: 'absolute', inset: 0, opacity: 0.12, transform: `translate(${smearX * 0.8}%, ${smearY * 0.8}%)`, filter: 'none' }} />
          <Img src={current.src} style={{ ...imgStyle, position: 'absolute', inset: 0, opacity: 0.25, transform: `translate(${smearX * 0.4}%, ${smearY * 0.4}%)`, filter: 'none' }} />
        </>
      ) : null}
      {previous?.src && previous.versionId !== current.versionId ? (
        <Img src={previous.src} style={{ ...imgStyle, position: 'absolute', inset: 0, opacity: 1 - fadeProgress }} />
      ) : null}
      {current.src ? (
        <Img
          src={current.src}
          style={{
            ...imgStyle,
            position: 'relative',
            opacity: previous?.src && previous.versionId !== current.versionId ? fadeProgress : 1,
            transform: previous?.src && previous.versionId !== current.versionId ? `scale(${0.98 + 0.02 * fadeProgress})` : 'none',
          }}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', border: debug ? '2px dashed #d5a954' : 'none', color: '#d5a954', background: debug ? 'rgba(35,30,22,.4)' : 'transparent', fontSize: 18 }}>
          {debug ? `${node.key}: missing asset` : null}
        </div>
      )}
      {debug && contactAnchor ? (
        <span style={{
          position: 'absolute', left: `${Number(contactAnchor.x) * 100}%`, top: `${Number(contactAnchor.y) * 100}%`,
          width: 10, height: 10, marginLeft: -5, marginTop: -5, borderRadius: '50%',
          background: '#45e07b', border: '2px solid #102a18', boxSizing: 'border-box', zIndex: 99,
        }} />
      ) : null}
    </div>
  );
};
