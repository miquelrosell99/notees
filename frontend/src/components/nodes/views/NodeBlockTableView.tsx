/**
 * NodeBlockTableView
 *
 * Table view that embeds a NoteesEditor per content-cell, giving every row
 * Lexical-based editing while keeping the familiar spreadsheet layout.
 */

import React, { useMemo } from 'react';
import { NoteesEditor } from '@/editor/NoteesEditor';
import { useRuntimeProjection } from '@/hooks/useRuntimeProjection';
import type { ProjectedNode } from '@/runtime/types';
import './NodeBlockTableView.css';

export interface NodeBlockTableViewProps {
  rootBlockId: string;
  readOnly?: boolean;
  propertyUuids?: string[];
  onNavigateToNode?: (linkId: string) => void;
}

/**
 * Renders top-level children of `pageId` as table rows.
 * The first column shows the block name in a NoteesEditor (single-block),
 * remaining columns are property stubs (placeholder for property editors).
 */
export const NodeBlockTableView: React.FC<NodeBlockTableViewProps> = ({
  rootBlockId,
  readOnly = false,
  propertyUuids = [],
  onNavigateToNode,
}) => {
  const { projectedNodes } = useRuntimeProjection({
    rootBlockId,
    maxDepth: 1,
    includeRoot: false,
    viewMode: 'table',
  });

  // Only show top-level children as rows
  const rows = useMemo(
    () => projectedNodes.filter((n) => n.depth === 0),
    [projectedNodes],
  );

  const columns = useMemo(
    () => [
      { key: '__name__', label: 'Name' },
      ...propertyUuids.map((uuid) => ({ key: uuid, label: uuid })),
    ],
    [propertyUuids],
  );

  return (
    <div className="node-block-table-view">
      <table className="node-block-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <NodeBlockTableRow
              key={row.blockId}
              node={row}
              columns={columns}
              readOnly={readOnly}
              onNavigateToNode={onNavigateToNode}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Row ──────────────────────────────────────────────────────

interface NodeBlockTableRowProps {
  node: ProjectedNode;
  columns: { key: string; label: string }[];
  readOnly: boolean;
  onNavigateToNode?: (linkId: string) => void;
}

const NodeBlockTableRow: React.FC<NodeBlockTableRowProps> = ({
  node,
  columns,
  readOnly,
  onNavigateToNode,
}) => (
  <tr className="node-block-table-row" data-block-id={node.blockId}>
    {columns.map((col) => (
      <td key={col.key} className="node-block-table-cell">
        {col.key === '__name__' ? (
          <NoteesEditor
            editorId={`table-cell-${node.blockId}`}
            rootBlockId={node.blockId}
            readOnly={readOnly}
            viewMode="list"
            onNavigateToNode={onNavigateToNode}
          />
        ) : (
          <span className="node-block-table-property-stub" />
        )}
      </td>
    ))}
  </tr>
);
