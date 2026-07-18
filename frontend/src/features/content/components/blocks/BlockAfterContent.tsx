/**
 * BlockAfterContent — Post-content block chrome.
 *
 * Renders specialized block-type chrome at the React level for the
 * per-block InlineEditor architecture. Old monolithic plugins
 * (AssetBlockPlugin, BlockCodePlugin, etc.) relied on BlockNode
 * DOM portals which no longer exist.
 *
 * Supported block types:
 * - Asset blocks      → Image preview
 * - Code blocks       → Monospace preview with line numbers
 * - Callout blocks    → Colored border + icon (quote, warning, tip, danger, success)
 * - Backlink blocks   → Count badge + expandable linked references
 * - Task blocks       → Status badges
 * - Query blocks      → Query results via QueryNodeCollection
 * - Table blocks      → HTML table with row/cell rendering
 * - Embed links       → Rendered inline as pills with a floating preview
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_STATUSES,
  TASK_CLOSED_STATUSES,
} from '@/constants/systemProperties';
import type { TaskStatus } from '@/features/tasks';
import { useProperties } from '@/features/properties';
import { nodeNameToText } from '@/features/queries';
import { AssetImage } from '@/features/content/components/nodes/AssetImage';
import { QuerySection } from '@/features/content/components/nodes/QuerySection';
import { QueryNodeCollection } from '@/features/content/components/nodes/QueryNodeCollection';
import { useQueryBlock } from '@/features/queries';
import { Card } from '@/components/ui/Card';
import { useNavigationStore } from '@/stores';
import { useUIStateStore } from '@/features/sync';
import { useNode } from '@/features/content';
import type { Node } from '@/types/api';
import type { ASTDocument, ASTInlineNode } from '@/types/ast';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { NodeRef } from '@/features/content/components/nodes/NodeRef';
import { NodeLinkContextMenuTrigger } from '@/features/content';
import type { JSX } from 'react';
import './BlockAfterContent.css';

interface BlockAfterContentProps {
  node: Node;
  backlinkExpanded?: boolean;
}

// ─── Callout Configuration ───────────────────────────────────────

const CALLOUT_CONFIG: Record<
  string,
  { label: string; icon: string; colorVar: string; borderVar: string; bgVar: string }
> = {
  quote:   { label: 'Quote',   icon: 'mdi-format-quote-open',     colorVar: '--callout-quote-color',   borderVar: '--callout-quote-border',   bgVar: '--callout-quote-bg' },
  warning: { label: 'Warning', icon: 'mdi-alert-circle-outline',  colorVar: '--callout-warning-color', borderVar: '--callout-warning-border', bgVar: '--callout-warning-bg' },
  tip:     { label: 'Tip',     icon: 'mdi-lightbulb-on-outline',  colorVar: '--callout-tip-color',     borderVar: '--callout-tip-border',     bgVar: '--callout-tip-bg' },
  danger:  { label: 'Danger',  icon: 'mdi-alert-octagon-outline', colorVar: '--callout-danger-color',  borderVar: '--callout-danger-border',  bgVar: '--callout-danger-bg' },
  success: { label: 'Success', icon: 'mdi-check-circle-outline',  colorVar: '--callout-success-color', borderVar: '--callout-success-border', bgVar: '--callout-success-bg' },
};

const CALLOUT_CLASS_MAP: Record<string, string> = {
  [SYSTEM_CLASS_UUIDS.quote]: 'quote',
  [SYSTEM_CLASS_UUIDS.warning]: 'warning',
  [SYSTEM_CLASS_UUIDS.tip]: 'tip',
  [SYSTEM_CLASS_UUIDS.danger]: 'danger',
  [SYSTEM_CLASS_UUIDS.success]: 'success',
};

function detectCalloutType(classIds: string[]): string | null {
  for (const id of classIds) {
    const type = CALLOUT_CLASS_MAP[id];
    if (type) return type;
  }
  return null;
}

// ─── Inline AST Renderer (shared) ────────────────────────────────

function renderInlineNodes(nodes: ASTInlineNode[]): React.ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return n.text || null;
      case 'node_link': {
        const { nodeUuid } = parseLinkId(n.link_id);
        return (
          <NodeLinkContextMenuTrigger
            key={i}
            linkId={n.link_id}
            refType={n.ref_type}
            label={n.label}
            nodeUuid={nodeUuid}
          >
            <NodeRef
              variant="inline"
              nodeUuid={nodeUuid}
              refType={n.ref_type === 'class' ? 'class' : 'node'}
              customName={n.label ?? undefined}
            />
          </NodeLinkContextMenuTrigger>
        );
      }
      case 'broken_link': {
        const text = n.label || n.link_id.split(':')[0] || '⛓️‍💥';
        return (
          <NodeLinkContextMenuTrigger
            key={i}
            linkId={n.link_id}
            refType="broken"
            label={n.label}
          >
            <span className="broken-link" title={`Broken link: ${n.link_id}`}>
              {text}
            </span>
          </NodeLinkContextMenuTrigger>
        );
      }
      case 'strong':
        return <strong key={i}>{renderInlineNodes(n.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInlineNodes(n.children)}</em>;
      case 'strikethrough':
        return <s key={i}>{renderInlineNodes(n.children)}</s>;
      case 'highlight':
        return <mark key={i}>{renderInlineNodes(n.children)}</mark>;
      case 'underline':
        return <u key={i}>{renderInlineNodes(n.children)}</u>;
      case 'external_link':
        return (
          <a key={i} href={n.url} target="_blank" rel="noreferrer">
            {renderInlineNodes(n.children)}
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
  const inlines = ast.flatMap((block) => ('children' in block ? block.children : []));
  const content = renderInlineNodes(inlines as ASTInlineNode[]);
  return <>{content.length > 0 ? content : '\u00A0'}</>;
}

// ─── Task Badges ─────────────────────────────────────────────────

const TASK_BADGE_CLASS: Record<TaskStatus, string> = {
  Backlog: 'badge--backlog',
  Pending: 'badge--pending',
  Doing: 'badge--doing',
  Reviewing: 'badge--reviewing',
  Done: 'badge--done',
  Cancelled: 'badge--cancelled',
};

function TaskBadges({ node }: { node: Node }): JSX.Element | null {
  const { data: allProperties } = useProperties();

  const statusValue = node.properties_uuid?.[SYSTEM_PROPERTY_UUIDS.task_status];
  let taskStatus: string | null = null;
  if (statusValue != null) {
    if (typeof statusValue === 'string') {
      const statusProp = allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status);
      const option = statusProp?.options?.find(o => o.uuid === statusValue);
      taskStatus = option?.name ?? statusValue;
    } else {
      taskStatus = String(statusValue);
    }
  }

  if (!taskStatus || !TASK_STATUSES.includes(taskStatus as TaskStatus)) {
    return null;
  }

  const status = taskStatus as TaskStatus;
  const isClosed = TASK_CLOSED_STATUSES.has(status);

  return (
    <div className="block-after-content__badges">
      <span
        className={`task-badge ${TASK_BADGE_CLASS[status]}`}
        data-task-status={status}
        data-task-closed={isClosed}
      >
        {status}
      </span>
    </div>
  );
}

// ─── Asset Preview ───────────────────────────────────────────────

function AssetPreview({ node }: { node: Node }): JSX.Element | null {
  if (!node.uuid) return null;

  return (
    <div className="block-after-content__asset">
      <AssetImage
        assetNodeId={node.uuid}
        showCard={false}
        elevation="none"
        radius="sm"
        clickable
        showActions={false}
        className="block-after-content__asset-image"
      />
    </div>
  );
}

// ─── Code Preview ────────────────────────────────────────────────

function CodePreview({ node }: { node: Node }): JSX.Element | null {
  const text = useMemo(() => nodeNameToText(node.name), [node.name]);
  const lines = useMemo(() => text.split('\n'), [text]);

  if (!text) return null;

  return (
    <div className="block-after-content__code">
      <div className="code-block-gutter">
        {lines.map((_, i) => (
          <span key={i} className="code-block-line-number">
            {i + 1}
          </span>
        ))}
      </div>
      <pre className="code-block-content">
        <code>{text}</code>
      </pre>
    </div>
  );
}

// ─── Callout Preview ─────────────────────────────────────────────

function CalloutPreview({ node, type }: { node: Node; type: string }): JSX.Element | null {
  const config = CALLOUT_CONFIG[type];
  const text = useMemo(() => nodeNameToText(node.name), [node.name]);

  if (!config || !text) return null;

  return (
    <div
      className={`block-after-content__callout block-after-content__callout--${type}`}
      style={{
        borderLeftColor: `var(${config.borderVar})`,
        backgroundColor: `var(${config.bgVar})`,
        color: `var(${config.colorVar})`,
      }}
    >
      <span className="callout-icon mdi" style={{ color: `var(${config.colorVar})` }} aria-hidden="true">
        <span className={config.icon} />
      </span>
      <span className="callout-text">{text}</span>
    </div>
  );
}

// ─── Backlink Preview ────────────────────────────────────────────

function BacklinkPreview({ node, expanded }: { node: Node; expanded?: boolean }): JSX.Element | null {
  const openNode = useNavigationStore((s) => s.openNode);
  const addSidebarCard = useNavigationStore((s) => s.addSidebarCard);
  const [isExiting, setIsExiting] = useState(false);
  const [showQuery, setShowQuery] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!expanded) {
      setIsExiting(true);
      setShowQuery(false);
      timeoutRef.current = setTimeout(() => {
        setIsExiting(false);
        timeoutRef.current = null;
      }, 350);
    } else {
      // Defer heavy QuerySection mount to next frame so the click & animation
      // feel instant — the card opens first, then the query loads in.
      rafRef.current = requestAnimationFrame(() => {
        setShowQuery(true);
        rafRef.current = null;
      });
    }
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [expanded]);

  const count = node.backlink_count ?? 0;
  if (count === 0) return null;
  if (!expanded && !isExiting) return null;

  const isVisible = expanded || isExiting;

  return (
    <div className="block-after-content__backlinks">
      <div
        role="region"
        aria-label="Linked references"
        className={`backlink-preview ${isVisible ? 'backlink-preview--expanded' : ''}`}
        onMouseDownCapture={(e) => e.stopPropagation()}
        onPointerDownCapture={(e) => e.stopPropagation()}
      >
        <div className="backlink-preview__inner">
          <Card variant="filled" radius="sm" paddingSize="sm" className="backlink-preview__card">
            {showQuery ? (
              <QuerySection
                nodeUuid={node.uuid}
                viewType="linked_references"
                title="Linked References"
                defaultExpanded
                hideWhenEmpty
                variant="backlink"
                onNodeClick={(id) => openNode(id)}
                onBlockCreated={(id) => addSidebarCard(id, 'block')}
                hideViewManagement
              />
            ) : (
              <div className="backlink-loading" />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── Query Preview ───────────────────────────────────────────────

function QueryPreview({ node }: { node: Node }): JSX.Element | null {
  const openNode = useNavigationStore((s) => s.openNode);
  const addSidebarCard = useNavigationStore((s) => s.addSidebarCard);
  const { queryAST, saveQueryAST } = useQueryBlock(node.uuid);

  return (
    <div className="block-after-content__query">
      <QueryNodeCollection
        nodeUuid={node.uuid}
        nodeName={node.name}
        viewType="main_content"
        onNodeClick={(id, isPage) => {
          if (isPage) openNode(id);
          else addSidebarCard(id, 'block');
        }}
        onBlockCreated={(id) => addSidebarCard(id, 'block')}
        hideToolbar
        showAddButton={false}
        hideViewManagement={false}
        queryAST={queryAST}
        onQueryASTChange={saveQueryAST}
      >
        {({ results, controls }) => (
          <>
            {controls && <div className="query-block-controls">{controls}</div>}
            <div className="query-block-results">{results}</div>
          </>
        )}
      </QueryNodeCollection>
    </div>
  );
}

// ─── Table Preview ───────────────────────────────────────────────

function TableRow({ row, isHeader }: { row: Node; isHeader: boolean }): JSX.Element {
  const { data: rowNode } = useNode(row.uuid, { include_children: true });

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
      {cells.map((cell) => (
        <TableCell key={cell.uuid} cell={cell} isHeader={isHeader} />
      ))}
    </tr>
  );
}

function TableCell({ cell, isHeader }: { cell: Node; isHeader: boolean }): JSX.Element {
  const CellTag = isHeader ? 'th' : 'td';
  return (
    <CellTag className="table-block-cell">
      <CellContent name={cell.name} />
    </CellTag>
  );
}

function TablePreview({ node }: { node: Node }): JSX.Element | null {
  const { data: tableNode } = useNode(node.uuid, { include_children: true });

  const rows = useMemo(() => {
    if (!tableNode?.children) return [];
    return tableNode.children.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  }, [tableNode]);

  if (rows.length === 0) {
    return (
      <div className="table-block-empty">
        <span>Empty table</span>
      </div>
    );
  }

  return (
    <div className="table-block-wrapper">
      <table className="table-block-table">
        <tbody>
          {rows.map((row, rowIndex) => (
            <TableRow key={row.uuid} row={row} isHeader={rowIndex === 0} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────

export function BlockAfterContent({ node, backlinkExpanded }: BlockAfterContentProps): JSX.Element {
  const classIds = node.classes_uuid ?? [];

  const isAsset = classIds.includes(SYSTEM_CLASS_UUIDS.asset);
  const isCode = classIds.includes(SYSTEM_CLASS_UUIDS.code);
  const isQuery = classIds.includes(SYSTEM_CLASS_UUIDS.query);
  const isTable = classIds.includes(SYSTEM_CLASS_UUIDS.table);
  const hasBacklinks = (node.backlink_count ?? 0) > 0;
  const isTask = node.properties_uuid?.[SYSTEM_PROPERTY_UUIDS.task_status] != null;
  const calloutType = detectCalloutType(classIds);
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const isCollapsed = useUIStateStore(
    (s) => (workspaceId ? s.states[workspaceId]?.[node.uuid]?.collapsed ?? false : false),
  );

  const hasContent =
    isAsset || isCode || isQuery || isTable || hasBacklinks || isTask || calloutType != null;

  if (!hasContent) {
    return <div className="block-after-content" />;
  }

  return (
    <div className="block-after-content">
      {isTask && <TaskBadges node={node} />}
      {isAsset && <AssetPreview node={node} />}
      {isCode && <CodePreview node={node} />}
      {calloutType && <CalloutPreview node={node} type={calloutType} />}
      {hasBacklinks && <BacklinkPreview node={node} expanded={backlinkExpanded} />}
      {isQuery && !isCollapsed && <QueryPreview node={node} />}
      {isTable && <TablePreview node={node} />}
    </div>
  );
}