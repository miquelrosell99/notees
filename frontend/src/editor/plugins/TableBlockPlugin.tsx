/**
 * TableBlockPlugin — Renders table blocks as `<table>` elements in the Lexical editor.
 *
 * For blocks with nodeType === 'table', fetches the table node's children
 * (rows → cells) from TanStack Query and renders a proper HTML table
 * into the `.node-block-table-preview` portal container.
 *
 * Table structure in Notees:
 *   Table block (class: table)
 *   ├── Row 1 block
 *   │   ├── Cell 1,1 block
 *   │   └── Cell 1,2 block
 *   └── Row 2 block
 *       ├── Cell 2,1 block
 *       └── Cell 2,2 block
 *
 * Follows the portal pattern of BlockClassPillsPlugin and AssetBlockPlugin.
 */

import { useEffect, useState, useCallback, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { useNode } from '@/hooks';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';
import type { Node } from '@/types';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import './TableBlockPlugin.css';

// ─── Types ────────────────────────────────────────────────────────

interface TableBlockInfo {
  blockId: string;
  serverId: number;
  container: HTMLElement;
}

// ─── Inner Component (per table) ──────────────────────────────────

interface TablePreviewProps {
  serverId: number;
}

/**
 * Renders a single table's content by fetching the node with children.
 */
function TablePreview({ serverId }: TablePreviewProps): JSX.Element | null {
  const { data: tableNode } = useNode(serverId, { include_children: true });

  if (!tableNode?.children || tableNode.children.length === 0) {
    return (
      <div className="table-block-empty">
        <span className="table-block-empty-text">Empty table</span>
      </div>
    );
  }

  // Build table data: rows → cells
  const rows = tableNode.children
    .slice()
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  // Determine if first row is a header (check if it has children with header-like content)
  const isFirstRowHeader = rows.length > 0;

  return (
    <div className="table-block-wrapper">
      <table className="table-block-table">
        <tbody>
          {rows.map((row, rowIndex) => (
            <TableRow key={row.id} row={row} isHeader={rowIndex === 0 && isFirstRowHeader} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TableRowProps {
  row: Node;
  isHeader: boolean;
}

function TableRow({ row, isHeader }: TableRowProps): JSX.Element {
  const { data: rowNode } = useNode(row.id, { include_children: true });

  const cells = rowNode?.children
    ? rowNode.children.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    : [];

  // If the row has no children, render the row's own content as a single cell
  if (cells.length === 0) {
    const CellTag = isHeader ? 'th' : 'td';
    return (
      <tr className={`table-block-row ${isHeader ? 'table-block-row--header' : ''}`}>
        <CellTag className="table-block-cell">{nodeNameToText(row.name) || '\u00A0'}</CellTag>
      </tr>
    );
  }

  const CellTag = isHeader ? 'th' : 'td';
  return (
    <tr className={`table-block-row ${isHeader ? 'table-block-row--header' : ''}`}>
      {cells.map(cell => (
        <CellTag key={cell.id} className="table-block-cell">
          {nodeNameToText(cell.name) || '\u00A0'}
        </CellTag>
      ))}
    </tr>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────

export function TableBlockPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [tableBlocks, setTableBlocks] = useState<TableBlockInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // Scan all BlockNodes and extract table blocks with DOM containers
  const scanBlocks = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const runtime = getNodeGraphRuntime();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: TableBlockInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;
        if (child.getNodeType() !== 'table') continue;

        const blockId = child.getBlockId();

        // Skip off-screen blocks when virtualization is active
        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockEl) continue;

        const container = blockEl.querySelector('.node-block-table-preview') as HTMLElement;
        if (!container) continue;

        // Resolve serverId from runtime
        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) continue;

        infos.push({ blockId, serverId: graphNode.serverId, container });
      }

      setTableBlocks(infos);
    });
  }, [editor, virtualizationEnabled, visibleBlockIds]);

  // Re-scan when editor state changes
  useEffect(() => {
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      Promise.resolve().then(scanBlocks);
    });
  }, [editor, scanBlocks, visibleBlockIds]);

  // Render portals
  if (tableBlocks.length === 0) return null;

  return (
    <>
      {tableBlocks.map(({ blockId, serverId, container }) =>
        createPortal(
          <TablePreview key={blockId} serverId={serverId} />,
          container,
        ),
      )}
    </>
  );
}
