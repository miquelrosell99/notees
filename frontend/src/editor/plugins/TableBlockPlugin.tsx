/**
 * TableBlockPlugin — Renders table blocks as `<table>` elements in the Lexical editor.
 *
 * For blocks with nodeType === 'table', fetches the table node's children
 * (rows → cells) from TanStack Query and renders a proper HTML table
 * into the `.node-block-table-preview` portal container.
 *
 * Includes a table/outline view mode toggle using SelectionButton.
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

import React, { useEffect, useRef, useState, useCallback, useMemo, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { useNode } from '@/hooks';
import { useContentSave } from '@/hooks/useContentSave';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';
import type { Node } from '@/types';
import type { ASTDocument, ASTInlineNode } from '@/types/ast';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { NodeRef } from '@/components/nodes/NodeRef';
import { BlockEditor } from '../BlockEditor';
import { SelectionButton } from '@/components/core/SelectionButton';
import { mdiTable, mdiFormatListBulleted } from '@mdi/js';
import './TableBlockPlugin.css';

// ─── Inline AST renderer ─────────────────────────────────────────

function renderInlineNodes(nodes: ASTInlineNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text || null;
      case 'node_link': {
        const { nodeUuid } = parseLinkId(node.link_id);
        return (
          <NodeRef
            key={i}
            variant="inline"
            nodeUuid={nodeUuid}
            refType={node.ref_type === 'class' ? 'class' : 'node'}
            customName={node.label ?? undefined}
          />
        );
      }
      case 'strong':
        return <strong key={i}>{renderInlineNodes(node.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInlineNodes(node.children)}</em>;
      case 'strikethrough':
        return <s key={i}>{renderInlineNodes(node.children)}</s>;
      case 'highlight':
        return <mark key={i}>{renderInlineNodes(node.children)}</mark>;
      case 'underline':
        return <u key={i}>{renderInlineNodes(node.children)}</u>;
      case 'external_link':
        return (
          <a key={i} href={node.url} target="_blank" rel="noreferrer">
            {renderInlineNodes(node.children)}
          </a>
        );
      case 'hard_break':
        return <br key={i} />;
      default:
        return null;
    }
  });
}

function CellContent({ name }: { name: string | null | undefined }): JSX.Element {
  const ast: ASTDocument = parseAST(name);
  const inlines = ast.flatMap(block => ('children' in block ? block.children : []));
  const content = renderInlineNodes(inlines as ASTInlineNode[]);
  return <>{content.length > 0 ? content : '\u00A0'}</>;
}

// ─── Table cell: lazy-mounted editor ────────────────────────────

interface TableCellProps {
  cell: Node;
  isHeader: boolean;
}

function TableCell({ cell, isHeader }: TableCellProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLTableCellElement>(null);
  const { handleContentChange: save, flushAll } = useContentSave();
  const flushRef = useRef(flushAll);
  flushRef.current = flushAll;

  // Close editing: flush pending saves first
  const closeEditing = useCallback(() => {
    flushRef.current();
    setEditing(false);
  }, []);

  // Click-outside → close editor
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as HTMLElement)) {
        closeEditing();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editing, closeEditing]);

  // Bridge: BlockEditor string blockId → numeric cell.id
  const handleContentChangeBridge = useCallback((_blockId: string, content: string) => {
    save(cell.id, content);
  }, [cell.id, save]);

  const CellTag = isHeader ? 'th' : 'td';

  return (
    <CellTag
      ref={containerRef}
      className={`table-block-cell${editing ? ' table-block-cell--editing' : ''}`}
      onClick={!editing ? () => setEditing(true) : undefined}
    >
      {editing ? (
        <BlockEditor
          nodes={[cell]}
          mode="document"
          hideProperties={true}
          draftMode={true}
          onContentChange={handleContentChangeBridge}
          canIndent={() => false}
          canOutdent={() => false}
          canMerge={() => false}
          canDelete={() => false}
          onEscape={closeEditing}
          className="table-block-cell-editor"
        />
      ) : (
        <CellContent name={cell.name} />
      )}
    </CellTag>
  );
}

// ─── Types ────────────────────────────────────────────────────────

interface TableBlockInfo {
  blockId: string;
  serverId: number;
  container: HTMLElement;
}

type TableViewMode = 'table' | 'outline';

const TABLE_VIEW_OPTIONS = [
  { value: 'table', icon: mdiTable, label: 'Table view' },
  { value: 'outline', icon: mdiFormatListBulleted, label: 'Outline view' },
];

// ─── Inner Component (per table) ──────────────────────────────────

interface TablePreviewProps {
  serverId: number;
  viewMode: TableViewMode;
  onViewModeChange: (mode: TableViewMode) => void;
}

/**
 * Renders a single table's content by fetching the node with children.
 */
function TablePreview({ serverId, viewMode, onViewModeChange }: TablePreviewProps): JSX.Element | null {
  const { data: tableNode } = useNode(serverId, { include_children: true });

  const rows = useMemo(() => {
    if (!tableNode?.children) return [];
    return tableNode.children.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  }, [tableNode?.children]);

  return (
    <div className="table-block-container">
      <div className="table-block-toolbar">
        <SelectionButton
          options={TABLE_VIEW_OPTIONS}
          value={viewMode}
          onChange={(v) => onViewModeChange(v as TableViewMode)}
          size="sm"
        />
      </div>
      {viewMode === 'outline' ? null : rows.length === 0 ? (
        <div className="table-block-empty">
          <span className="table-block-empty-text">Empty table</span>
        </div>
      ) : (
        <div className="table-block-wrapper">
          <table className="table-block-table">
            <tbody>
              {rows.map((row, rowIndex) => (
                <TableRow key={row.id} row={row} isHeader={rowIndex === 0} />
              ))}
            </tbody>
          </table>
        </div>
      )}
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

  if (cells.length === 0) {
    return (
      <tr className={`table-block-row ${isHeader ? 'table-block-row--header' : ''}`}>
        <TableCell cell={row} isHeader={isHeader} />
      </tr>
    );
  }

  return (
    <tr className={`table-block-row ${isHeader ? 'table-block-row--header' : ''}`}>
      {cells.map(cell => (
        <TableCell key={cell.id} cell={cell} isHeader={isHeader} />
      ))}
    </tr>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────

export function TableBlockPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [tableBlocks, setTableBlocks] = useState<TableBlockInfo[]>([]);
  // Per-block view mode state (persisted across re-scans)
  const [viewModes, setViewModes] = useState<Map<string, TableViewMode>>(new Map());
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  const handleViewModeChange = useCallback((blockId: string, mode: TableViewMode) => {
    setViewModes(prev => {
      const next = new Map(prev);
      next.set(blockId, mode);
      return next;
    });

    // Tell the runtime whether to project table children as normal blocks
    const runtime = getNodeGraphRuntime();
    runtime.setTableOutlineMode(blockId, mode === 'outline');
  }, []);

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
          <TablePreview
            key={blockId}
            serverId={serverId}
            viewMode={viewModes.get(blockId) || 'table'}
            onViewModeChange={(mode) => handleViewModeChange(blockId, mode)}
          />,
          container,
        ),
      )}
    </>
  );
}
