/**
 * InlineLink — React component rendered inside InlineLinkNode (DecoratorNode).
 *
 * Lexical portals this into the InlineLinkNode's DOM element (<span class="inline-link-wrapper">).
 * Delegates node resolution and rendering to NodeRef (variant="inline").
 *
 * Supports URL pills (refType === 'url') that render an external-link pill.
 */

import Icon from '@mdi/react';
import { mdiWeb } from '@mdi/js';
import { NodeRef } from '@/components/nodes/NodeRef';
import { parseLinkId } from '@/lib/astBuilder';
import type { InlineLinkRefType } from '../nodes/InlineLinkNode';

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
    // linkId holds the custom label when it differs from the URL
    const customLabel = linkId && linkId !== url ? linkId : null;
    const displayText = customLabel
      ?? (url
        ? url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 50) || url
        : 'URL');

    return (
      <span className="inline-link-inner" data-ref-type="url" title={customLabel ? url : undefined}>
        <span className="inline-link-icon">
          <Icon path={mdiWeb} size="14px" />
        </span>
        <span className="inline-link-text">{displayText}</span>
      </span>
    );
  }

  // ─── Node / class / embed pill — rendered by NodeRef inline variant ───
  const { nodeUuid } = parseLinkId(linkId);

  return (
    <NodeRef
      variant="inline"
      nodeUuid={nodeUuid}
      refType={refType === 'embed' ? 'node' : refType}
      customName={label}
    />
  );
}
