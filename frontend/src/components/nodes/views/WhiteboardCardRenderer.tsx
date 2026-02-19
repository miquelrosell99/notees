/**
 * WhiteboardCardRenderer — Renders card elements on the whiteboard.
 *
 * Two modes:
 *   'block'     — Normal editable child block. Shows block name + children preview.
 *   'reference' — Read-only reference to another node. Renders the node's full
 *                 content via NodeViewContent (like a sidebar card, without queries).
 */
import React from 'react';
import type { WhiteboardCardElement } from '@/types/whiteboard';
import { useNodeByUuid, nodeNameToText } from '@/hooks/useNodes';
import { NodeViewContent } from '@/views/NodeView';
import { NodeIcon } from '@/components/core/icons';
import Icon from '@mdi/react';
import { mdiChevronDown, mdiChevronRight, mdiFileDocumentOutline, mdiLinkVariant } from '@mdi/js';

interface Props {
  element: WhiteboardCardElement;
  zoom: number;
}

// ─── Block card (normal child block) ────────────────────────────────

const BlockCardContent: React.FC<{ element: WhiteboardCardElement; zoom: number }> = ({ element, zoom }) => {
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
          <Icon path={mdiFileDocumentOutline} size={0.55} />
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

// ─── Reference card (read-only embedded node view) ──────────────────

const ReferenceCardContent: React.FC<{ element: WhiteboardCardElement }> = ({ element }) => {
  const { data: node } = useNodeByUuid(element.nodeUuid);

  const displayName = node ? nodeNameToText(node.name) : 'Loading...';

  return (
    <div
      className="whiteboard-card whiteboard-card--reference"
      style={{ backgroundColor: element.color ?? undefined }}
    >
      <div className="whiteboard-card__header whiteboard-card__header--reference">
        <span className="whiteboard-card__icon">
          {node ? <NodeIcon icon={node.icon ?? null} isPage={node.is_page ?? true} size={0.55} /> : <Icon path={mdiLinkVariant} size={0.55} />}
        </span>
        <span className="whiteboard-card__title" title={displayName}>
          {displayName}
        </span>
        <span className="whiteboard-card__badge">
          <Icon path={mdiLinkVariant} size={0.4} />
        </span>
      </div>
      <div className={`whiteboard-card__body whiteboard-card__body--reference ${element.collapsed ? 'whiteboard-card__body--collapsed' : ''}`}>
        {node ? (
          <div className="whiteboard-card__node-content">
            <NodeViewContent
              nodeId={element.nodeId}
              viewMode="default"
              sidebarMode={true}
              hideQueries={true}
              hideFooter={true}
              propertiesCollapsed={true}
            />
          </div>
        ) : (
          <span style={{ opacity: 0.5, fontStyle: 'italic' }}>Loading node...</span>
        )}
      </div>
    </div>
  );
};

// ─── Main renderer (dispatches by cardMode) ─────────────────────────

export const WhiteboardCardRenderer: React.FC<Props> = ({ element, zoom }) => {
  if (element.cardMode === 'reference') {
    return <ReferenceCardContent element={element} />;
  }
  return <BlockCardContent element={element} zoom={zoom} />;
};
