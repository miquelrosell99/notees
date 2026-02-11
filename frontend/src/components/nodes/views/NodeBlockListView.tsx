/**
 * NodeBlockListView — List view using Lexical editor.
 *
 * Flat node list with depth for indentation.
 * The primary outliner-style editing mode.
 */

import { useCallback, type JSX } from 'react';
import { NoteesEditor } from '../../editor/NoteesEditor';
import type { ViewMode } from '../../runtime/types';

export interface NodeBlockListViewProps {
  rootBlockId: string;
  editorId?: string;
  readOnly?: boolean;
  onNavigateToNode?: (linkId: string) => void;
  onEscape?: () => void;
  className?: string;
}

export function NodeBlockListView({
  rootBlockId,
  editorId,
  readOnly = false,
  onNavigateToNode,
  onEscape,
  className,
}: NodeBlockListViewProps): JSX.Element {
  return (
    <div className={`node-block-list-view ${className || ''}`}>
      <NoteesEditor
        editorId={editorId || `list-${rootBlockId}`}
        rootBlockId={rootBlockId}
        viewMode="list"
        readOnly={readOnly}
        onNavigateToNode={onNavigateToNode}
        onEscape={onEscape}
        placeholder="Type / for commands…"
      />
    </div>
  );
}
