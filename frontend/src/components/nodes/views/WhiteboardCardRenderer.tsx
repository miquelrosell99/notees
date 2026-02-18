/**
 * WhiteboardCardRenderer — Renders a card element displaying a child block's content.
 */
import React from 'react';
import type { WhiteboardCardElement } from '@/types/whiteboard';
import { useNodeByUuid, nodeNameToText } from '@/hooks/useNodes';
import Icon from '@mdi/react';
import { mdiChevronDown, mdiChevronRight, mdiFileDocumentOutline } from '@mdi/js';

interface Props {
  element: WhiteboardCardElement;
  zoom: number;
}

export const WhiteboardCardRenderer: React.FC<Props> = ({ element, zoom }) => {
  const { data: node } = useNodeByUuid(element.nodeUuid);

  const displayName = node ? nodeNameToText(node.name) : 'Loading...';
  const children = node?.children ?? [];

  return (
    <div
      className="whiteboard-card"
      style={{
        backgroundColor: element.color ?? undefined,
        fontSize: Math.max(10, 13 * zoom),
      }}
    >
      <div className="whiteboard-card__header">
        <span className="whiteboard-card__icon">
          <Icon path={node?.icon ? mdiFileDocumentOutline : mdiFileDocumentOutline} size={0.55} />
        </span>
        <span className="whiteboard-card__title" title={displayName}>
          {displayName}
        </span>
        {children.length > 0 && (
          <button className="whiteboard-card__collapse-btn" onClick={(e) => e.stopPropagation()}>
            <Icon path={element.collapsed ? mdiChevronRight : mdiChevronDown} size={0.6} />
          </button>
        )}
      </div>
      <div className={`whiteboard-card__body ${element.collapsed ? 'whiteboard-card__body--collapsed' : ''}`}>
        {node && !node.name && !children.length && (
          <span style={{ opacity: 0.5, fontStyle: 'italic' }}>Empty block</span>
        )}
        {element.showChildren && children.length > 0 && (
          <div className="whiteboard-card__children">
            {children.slice(0, 10).map(child => (
              <div key={child.id} className="whiteboard-card__child">
                {nodeNameToText(child.name) || '(empty)'}
              </div>
            ))}
            {children.length > 10 && (
              <div className="whiteboard-card__child" style={{ opacity: 0.5 }}>
                +{children.length - 10} more...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
