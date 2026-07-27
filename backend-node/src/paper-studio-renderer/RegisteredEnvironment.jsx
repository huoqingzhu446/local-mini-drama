import React from 'react';

export const RegisteredEnvironment = ({ node, style, children, debug }) => (
  <div data-paper-node={node.key} data-paper-kind="registered-environment" data-boundary={node.relation?.boundary || ''} style={{ ...style, outline: debug ? '2px solid rgba(84,161,186,.45)' : 'none' }}>
    {children}
  </div>
);
