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
 * - Embed blocks      → Embedded node preview card
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { ImageNode } from '@/features/content/components/nodes/ImageNode';
import { QuerySection } from '@/features/content/components/nodes/QuerySection';
import { QueryNodeCollection } from '@/features/content/components/nodes/QueryNodeCollection';
import { useQueryBlock } from '@/hooks/useQueryBlock';
import { Card } from '@/components/ui/Card';
import { useNavigationStore } from '@/stores';
import { useNode, useNodeByUuid } from '@/hooks';
import type { Node } from '@/types/api';
import type { ASTDocument, ASTInlineNode } from '@/types/ast';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { NodeRef } from '@/features/content/components/nodes/NodeRef';
import { Icon } from '@/components/ui/Icon';
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
          <NodeRef
            key={i}
            variant="inline"
            nodeUuid={nodeUuid}
            refType={n.ref_type === 'class' ? 'class' : 'node'}
            customName={n.label ?? undefined}
          />
        );
      }
      case 'broken_link': {
        const text = n.label || n.link_id.split(':')[0] || '⛓️‍💥';
        return (
          <span key={i} className="broken-link" title={`Broken link: ${n.link_id}`}>
            {text}
          </span>
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

function TaskBadges({ node }: { node: Node }): JSX.Element | null {
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(node.uuid);
  const taskStatus = graphNode?.taskStatus;

  if (!taskStatus) return null;

  const badges: { label: string; cls: string }[] = [];

  if (taskStatus === 'Done') {
    badges.push({ label: 'Done', cls: 'badge--done' });
  } else if (taskStatus === 'Doing') {
    badges.push({ label: 'Doing', cls: 'badge--doing' });
  } else if (taskStatus === 'Pending') {
    badges.push({ label: 'Pending', cls: 'badge--pending' });
  }

  return (
    <div className="block-after-content__badges">
      {badges.map((b) => (
        <span key={b.label} className={`task-badge ${b.cls}`}>
          {b.label}
        </span>
      ))}
    </div>
  );
}

// ─── Asset Preview ───────────────────────────────────────────────

function AssetPreview({ node }: { node: Node }): JSX.Element | null {
  if (!node.id) return null;

  return (
    <div className="block-after-content__asset">
      <ImageNode
        assetNodeId={node.id}
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
      <span className="callout-icon mdi" style={{ color: `var(${config.colorVar})` }}>
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
        className={`backlink-preview ${isVisible ? 'backlink-preview--expanded' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="backlink-preview__inner">
          <Card variant="filled" radius="sm" paddingSize="sm">
            {showQuery ? (
              <QuerySection
                nodeId={node.id}
                nodeUuid={node.uuid}
                viewType="linked_references"
                title="Linked References"
                defaultExpanded
                hideWhenEmpty
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
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(node.uuid);
  const { queryAST, saveQueryAST } = useQueryBlock(node.id);

  return (
    <div className="block-after-content__query">
      <QueryNodeCollection
        nodeId={node.id}
        nodeUuid={node.uuid}
        nodeName={graphNode?.name}
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
      {cells.map((cell) => (
        <TableCell key={cell.id} cell={cell} isHeader={isHeader} />
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
  const { data: tableNode } = useNode(node.id, { include_children: true });

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
            <TableRow key={row.id} row={row} isHeader={rowIndex === 0} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Embed Preview ───────────────────────────────────────────────

function findEmbedLinkId(name: string): string | null {
  const ast = parseAST(name);
  for (const block of ast) {
    if (block.type !== 'paragraph' && block.type !== 'heading') continue;
    for (const inline of block.children) {
      if (inline.type === 'node_link' && inline.ref_type === 'embed') {
        return inline.link_id;
      }
    }
  }
  return null;
}

function EmbedPreview({ node }: { node: Node }): JSX.Element | null {
  const embedLinkId = useMemo(() => findEmbedLinkId(node.name), [node.name]);
  const { nodeUuid } = embedLinkId ? parseLinkId(embedLinkId) : { nodeUuid: null };
  const { data: embeddedNode, isLoading } = useNodeByUuid(nodeUuid, { include_children: true });

  if (!nodeUuid) return null;

  const embeddedName = embeddedNode ? nodeNameToText(embeddedNode.name) || '[Untitled]' : '';

  return (
    <div className="embed-block-card">
      <div className="embed-block-header">
        <Icon path="mdi-cube-outline" className="embed-block-header__icon" />
        <span className="embed-block-header__label" title={embeddedName}>
          {isLoading ? 'Loading embed…' : `Embed: ${embeddedName}`}
        </span>
      </div>
      {embeddedNode && (
        <div className="embed-block-content">
          {embeddedNode.children && embeddedNode.children.length > 0 ? (
            <ul className="embed-block-list">
              {embeddedNode.children.map((child) => (
                <li key={child.id} className="embed-block-list-item">
                  <CellContent name={child.name} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="embed-block-empty">
              <CellContent name={embeddedNode.name} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────

export function BlockAfterContent({ node, backlinkExpanded }: BlockAfterContentProps): JSX.Element {
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(node.uuid);
  const classIds = graphNode?.classIds ?? [];

  const isAsset = classIds.includes(SYSTEM_CLASS_UUIDS.asset);
  const isCode = classIds.includes(SYSTEM_CLASS_UUIDS.code);
  const isQuery = classIds.includes(SYSTEM_CLASS_UUIDS.query);
  const isTable = classIds.includes(SYSTEM_CLASS_UUIDS.table);
  const hasBacklinks = (node.backlink_count ?? 0) > 0;
  const isTask = graphNode?.taskStatus != null;
  const calloutType = detectCalloutType(classIds);
  const embedLinkId = useMemo(() => findEmbedLinkId(node.name), [node.name]);
  const hasEmbed = embedLinkId != null;
  const isCollapsed = graphNode?.collapsed ?? node.collapsed ?? false;

  const hasContent =
    isAsset || isCode || isQuery || isTable || hasBacklinks || isTask || calloutType != null || hasEmbed;

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
      {hasEmbed && <EmbedPreview node={node} />}
    </div>
  );
}
