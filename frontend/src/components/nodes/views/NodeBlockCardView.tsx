/**
 * NodeBlockCardView — Card view using Lexical editors.
 *
 * Each card has a header Lexical editor and a content Lexical editor.
 * Cards show their children as a flat multi-level list.
 */

import { type JSX } from 'react';
import { NoteesEditor } from '../../../editor/NoteesEditor';
import { useRuntimeProjection } from '../../../hooks/useRuntimeProjection';
import type { ProjectedNode } from '../../../runtime/types';

import './NodeBlockCardView.css';

export interface NodeBlockCardViewProps {
  rootBlockId: string;
  readOnly?: boolean;
  onNavigateToNode?: (linkId: string) => void;
  className?: string;
}

export function NodeBlockCardView({
  rootBlockId,
  readOnly = false,
  onNavigateToNode,
  className,
}: NodeBlockCardViewProps): JSX.Element {
  const { visibleNodes } = useRuntimeProjection({
    rootBlockId,
    maxDepth: 1,
    includeRoot: false,
    viewMode: 'card',
  });

  return (
    <div className={`node-block-card-view ${className || ''}`}>
      {visibleNodes.map(node => (
        <NodeBlockCard
          key={node.blockId}
          node={node}
          readOnly={readOnly}
          onNavigateToNode={onNavigateToNode}
        />
      ))}
    </div>
  );
}

interface NodeBlockCardProps {
  node: ProjectedNode;
  readOnly: boolean;
  onNavigateToNode?: (linkId: string) => void;
}

function NodeBlockCard({ node, readOnly, onNavigateToNode }: NodeBlockCardProps): JSX.Element {
  return (
    <div className="node-block-card" data-block-id={node.blockId}>
      {/* Card header: editable name */}
      <div className="node-block-card-header">
        {node.icon && <span className="node-block-card-icon">{node.icon}</span>}
        <NoteesEditor
          editorId={`card-header-${node.blockId}`}
          rootBlockId={node.blockId}
          viewMode="document"
          readOnly={readOnly}
          onNavigateToNode={onNavigateToNode}
          placeholder="Card title…"
          className="node-block-card-header-editor"
        />
      </div>

      {/* Card content: children as flat list */}
      {node.hasChildren && (
        <div className="node-block-card-content">
          <NoteesEditor
            editorId={`card-content-${node.blockId}`}
            rootBlockId={node.blockId}
            viewMode="list"
            readOnly={readOnly}
            onNavigateToNode={onNavigateToNode}
            placeholder="Card content…"
            className="node-block-card-content-editor"
          />
        </div>
      )}
    </div>
  );
}
