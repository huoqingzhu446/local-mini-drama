import React from 'react';

// M3 接触阴影（纸片动画优化方案 §5.1）：
// 椭圆径向渐变，位于 cutout 接地线处，让角色"踩"在场景里而不是"飘"在背景上。
// 阴影渲染在素材图之下（DOM 顺序在前 + 无 zIndex 提升），跟随节点自动移动。
export const ContactShadow = ({ opacity = 0.34, scale = 1, groundY = 0.88, role = 'actor' }) => {
  const widthRatio = role === 'prop' ? 0.6 : 0.72;
  const heightRatio = 0.22;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        left: '50%',
        top: `${groundY * 100}%`,
        width: `${widthRatio * 100 * scale}%`,
        height: `${widthRatio * heightRatio * 100 * scale}%`,
        transform: 'translate(-50%, -42%)',
        background: `radial-gradient(ellipse at center, rgba(20,16,10,${opacity}) 0%, rgba(20,16,10,${opacity * 0.55}) 46%, rgba(20,16,10,0) 72%)`,
        pointerEvents: 'none',
      }}
    />
  );
};
