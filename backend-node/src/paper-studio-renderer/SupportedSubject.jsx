import React from 'react';

export const SupportedSubject = ({ node, style, children, debug }) => (
  <div data-paper-node={node.key} data-paper-kind="supported-subject" data-support={node.relation?.support || ''} style={{ ...style, outline: debug ? '2px solid rgba(215,105,88,.55)' : 'none' }}>
    {children}
  </div>
);
