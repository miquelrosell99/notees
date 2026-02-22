/**
 * InlineLink — React component rendered inside InlineLinkNode (DecoratorNode).
 *
 * Lexical portals this into the InlineLinkNode's DOM element (<span class="inline-link-wrapper">).
 * Resolves target node metadata from the ReferencedNodesContext (populated by
 * the page content response), falling back to useBatchedNode for any misses.
 *
 * Also used by BlockClassPillsPlugin to render class pills on blocks.
 * Supports URL pills (refType === 'url') that render an external-link pill.
 */

import { useMemo, memo } from 'react';
import Icon from '@mdi/react';
import { mdiWeb } from '@mdi/js';
import { useReferencedNode } from '@/contexts/ReferencedNodesContext';
import { useNodeByUuid } from '@/hooks/useNodeQueries';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useClasses } from '@/hooks';
import { NodeIcon } from '@/components/core/icons';
import { parseLinkId } from '@/lib/astBuilder';
import type { InlineLinkRefType } from '../nodes/InlineLinkNode';
import type { Node } from '@/types/api';

export interface InlineLinkProps {
  linkId: string;
  refType: InlineLinkRefType;
  /** URL for external-link pills. */
  url?: string;
  /** Custom display label — overrides target node name when set. */
  label?: string;
}

export function InlineLink({ linkId, refType, url, label }: InlineLinkProps) {
  // ─── URL pill ──────────────────────────────────────────────
  if (refType === 'url') {
    const displayText = url
      ? url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 50) || url
      : 'URL';

    return (
      <span className="inline-link-inner" data-ref-type="url">
        <span className="inline-link-icon">
          <Icon path={mdiWeb} size="14px" />
        </span>
        <span className="inline-link-text">{displayText}</span>
      </span>
    );
  }

  // ─── Node / class / embed pill ────────────────────────────
  return <NodeLinkPill linkId={linkId} refType={refType} label={label} />;
}

/** Inner component for node/class/embed pills — uses hooks that need stable renders. */
const NodeLinkPill = memo(function NodeLinkPill({ linkId, refType, label }: { linkId: string; refType: 'node' | 'class' | 'embed'; label?: string }) {
  const { nodeUuid } = parseLinkId(linkId);

  // 1. Try the pre-fetched referenced_nodes map (from page content response — zero API calls)
  const refNode = useReferencedNode(nodeUuid);

  // 2. Fallback: fetch by UUID only when not in the pre-fetched map.
  //    This fires for newly created links (not yet saved) or cross-context renders.
  const { data: fallbackNode } = useNodeByUuid(!refNode ? nodeUuid : null);

  const nodeData = refNode ?? fallbackNode ?? null;

  const { data: allClasses } = useClasses();

  const effectiveIcon = useMemo(() => {
    if (!nodeData) return null;
    return getEffectiveIcon(nodeData as Node, allClasses);
  }, [nodeData, allClasses]);

  const displayText = useMemo(() => {
    // Custom label overrides the target node's name
    if (label) return label;
    if (!nodeData) return linkId.slice(0, 8) + '…';
    const text = nodeNameToText(nodeData.name);
    if (!text || text.trim() === '') {
      return nodeData.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    if (!nodeData.is_page && text.length > 50) {
      return text.slice(0, 50) + '…';
    }
    return text;
  }, [nodeData, linkId, label]);

  const isPage = nodeData?.is_page ?? true;
  const nodeColor = nodeData?.color || undefined;

  return (
    <span
      className="inline-link-inner"
      data-ref-type={refType}
      style={nodeColor ? { textDecorationColor: nodeColor, color: nodeColor } : undefined}
    >
      {effectiveIcon && (
        <span className="inline-link-icon">
          <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" />
        </span>
      )}
      <span className="inline-link-text">
        {displayText}
      </span>
    </span>
  );
});
