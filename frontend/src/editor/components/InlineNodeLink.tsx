/**
 * InlineNodeLink — React component rendered inside PillNode (DecoratorNode).
 *
 * Lexical portals this into the PillNode's DOM element (<span class="node-pill-wrapper">).
 * Fetches node data by UUID and renders a lightweight inline pill.
 *
 * Also used by BlockClassPillsPlugin to render class pills on blocks.
 * Supports URL pills (refType === 'url') that render an external-link pill.
 */

import { useMemo } from 'react';
import Icon from '@mdi/react';
import { mdiWeb } from '@mdi/js';
import { useNodeByUuid } from '@/hooks/useNodeQueries';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useClasses } from '@/hooks';
import { NodeIcon } from '@/components/core/icons';
import { parseLinkId } from '@/lib/astBuilder';
import type { PillRefType } from '../nodes/PillNode';

export interface InlineNodeLinkProps {
  linkId: string;
  refType: PillRefType;
  /** URL for external-link pills. */
  url?: string;
  /** Custom display label — overrides target node name when set. */
  label?: string;
}

export function InlineNodeLink({ linkId, refType, url, label }: InlineNodeLinkProps) {
  // ─── URL pill ──────────────────────────────────────────────
  if (refType === 'url') {
    const displayText = url
      ? url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 50) || url
      : 'URL';

    return (
      <span className="node-pill-inner" data-ref-type="url">
        <span className="node-pill-icon">
          <Icon path={mdiWeb} size="14px" />
        </span>
        <span className="node-pill-text">{displayText}</span>
      </span>
    );
  }

  // ─── Node / class / embed pill ────────────────────────────
  return <NodePill linkId={linkId} refType={refType} label={label} />;
}

/** Inner component for node/class/embed pills — uses hooks that need stable renders. */
function NodePill({ linkId, refType, label }: { linkId: string; refType: 'node' | 'class' | 'embed'; label?: string }) {
  const { nodeUuid } = parseLinkId(linkId);
  const { data: node } = useNodeByUuid(nodeUuid);
  const { data: allClasses } = useClasses();

  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);

  const displayText = useMemo(() => {
    // Custom label overrides the target node's name
    if (label) return label;
    if (!node) return linkId.slice(0, 8) + '…';
    const text = nodeNameToText(node.name);
    if (!text || text.trim() === '') {
      return node.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    if (!node.is_page && text.length > 50) {
      return text.slice(0, 50) + '…';
    }
    return text;
  }, [node, linkId, label]);

  const isPage = node?.is_page ?? true;
  const nodeColor = node?.color || undefined;

  return (
    <span
      className="node-pill-inner"
      data-ref-type={refType}
      style={nodeColor ? { textDecorationColor: nodeColor, color: nodeColor } : undefined}
    >
      {effectiveIcon && (
        <span className="node-pill-icon">
          <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" />
        </span>
      )}
      <span className="node-pill-text">
        {displayText}
      </span>
    </span>
  );
}
