/**
 * InlineNodeLinks — Custom-editor equivalent of NodeLinkPlugin.
 *
 * Handles click/double-click selection, Enter navigation, copy shortcuts,
 * and URL-pill opening for link-like atomic pills rendered inside the
 * contentEditable root.
 */

import { useEffect, useCallback, useRef, type JSX } from 'react';
import type { ASTInlineNode } from '@/types/ast';
import { parseLinkId } from '@/lib/astBuilder';
import { copyToClipboard } from '@/utils/clipboardManager';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import {
  astToUnits,
  getInlineChildren,
  getUnitLogicalSize,
  setCollapsedOffset,
} from '../model/inlineEditorModel';
import type { InlineEditorState } from '../model/types';
import type { InlineLinkRefType } from '@/features/editor/editor/types';

interface InlineNodeLinksProps {
  rootRef: React.RefObject<HTMLDivElement | null>;
  stateRef: React.MutableRefObject<InlineEditorState>;
  applyMutation: (mutator: (prev: InlineEditorState) => InlineEditorState) => void;
  selectedPillLinkId: string | null;
  setSelectedPillLinkId: (linkId: string | null) => void;
  onPillClick?: (linkId: string, refType: InlineLinkRefType) => void;
}

function isLinkAtomic(node: ASTInlineNode): node is Extract<ASTInlineNode, { link_id: string }> {
  return node.type === 'node_link' || node.type === 'broken_link' || node.type === 'external_link';
}

function getLinkRefType(node: ASTInlineNode): InlineLinkRefType {
  if (node.type === 'node_link') return node.ref_type;
  if (node.type === 'broken_link') return 'broken';
  if (node.type === 'external_link') return 'url';
  return 'node';
}

function getLinkId(node: ASTInlineNode): string | null {
  if (node.type === 'node_link' || node.type === 'broken_link') return node.link_id;
  if (node.type === 'external_link') return node.url;
  return null;
}

function getPillOffset(state: InlineEditorState, linkId: string): number {
  const units = astToUnits(getInlineChildren(state.ast));
  let offset = 0;
  for (const unit of units) {
    if (
      unit.type === 'atomic' &&
      isLinkAtomic(unit.node) &&
      getLinkId(unit.node) === linkId
    ) {
      return offset;
    }
    offset += getUnitLogicalSize(unit);
  }
  return offset;
}

function getSelectedPillNode(state: InlineEditorState, linkId: string): ASTInlineNode | null {
  const units = astToUnits(getInlineChildren(state.ast));
  for (const unit of units) {
    if (unit.type === 'atomic' && isLinkAtomic(unit.node) && getLinkId(unit.node) === linkId) {
      return unit.node;
    }
  }
  return null;
}

function computeDisplayLabel(node: ASTInlineNode): string {
  if (node.type === 'external_link') {
    const label = node.children.map((c) => ('text' in c ? (c as { text: string }).text : '')).join('');
    if (label && label !== node.url) return label;
    return node.url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 50) || node.url || 'URL';
  }

  if (node.type === 'broken_link') {
    const { nodeUuid } = parseLinkId(node.link_id);
    return node.label || nodeUuid || '⛓️‍💥';
  }

  if (node.type === 'node_link') {
    const { nodeUuid } = parseLinkId(node.link_id);
    if (node.label) return node.label;
    if (nodeUuid) {
      const runtime = getOperationRuntime();
      const target = getNode(runtime, nodeUuid);
      if (target?.name) return target.name;
      return nodeUuid;
    }
  }

  return '';
}

export function InlineNodeLinks({
  rootRef,
  stateRef,
  applyMutation,
  selectedPillLinkId,
  setSelectedPillLinkId,
  onPillClick,
}: InlineNodeLinksProps): JSX.Element | null {
  const selectedLinkIdRef = useRef(selectedPillLinkId);
  selectedLinkIdRef.current = selectedPillLinkId;

  const clearSelection = useCallback(() => {
    if (selectedLinkIdRef.current) {
      setSelectedPillLinkId(null);
    }
  }, [setSelectedPillLinkId]);

  const handleClick = useCallback(
    (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const target = event.target as HTMLElement;
      const wrapper = target.closest('.inline-link-wrapper') as HTMLElement | null;
      if (!wrapper || !root.contains(wrapper)) return;

      const linkId = wrapper.dataset.linkId;
      const refType = (wrapper.dataset.refType ?? 'node') as InlineLinkRefType;
      const url = wrapper.dataset.url;
      if (!linkId) return;

      event.preventDefault();
      event.stopPropagation();

      if (refType === 'url' && url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        clearSelection();
        return;
      }

      if (selectedLinkIdRef.current === linkId) {
        // Second click on an already-selected pill places the caret.
        const rect = wrapper.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const offset = getPillOffset(stateRef.current, linkId);
        const targetOffset = event.clientX >= midX ? offset + 1 : offset;
        applyMutation((prev) => setCollapsedOffset(prev, targetOffset));
        clearSelection();
        return;
      }

      // First click selects the pill.
      root.focus();
      setSelectedPillLinkId(linkId);
    },
    [rootRef, stateRef, applyMutation, setSelectedPillLinkId, clearSelection],
  );

  const handleDoubleClick = useCallback(
    (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const target = event.target as HTMLElement;
      const wrapper = target.closest('.inline-link-wrapper') as HTMLElement | null;
      if (!wrapper || !root.contains(wrapper)) return;

      const linkId = wrapper.dataset.linkId;
      const refType = (wrapper.dataset.refType ?? 'node') as InlineLinkRefType;
      if (!linkId || refType === 'url') return;

      event.preventDefault();
      event.stopPropagation();

      onPillClick?.(linkId, refType);
      clearSelection();
    },
    [rootRef, onPillClick, clearSelection],
  );

  const handleMouseDown = useCallback(
    (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const target = event.target as HTMLElement;
      const wrapper = target.closest('.inline-link-wrapper') as HTMLElement | null;
      if (!wrapper || !root.contains(wrapper)) {
        clearSelection();
        return;
      }

      const linkId = wrapper.dataset.linkId;
      // Clicks on a different pill are handled by the click listener; keep
      // selection until then so second-click caret logic still works.
      if (linkId && selectedLinkIdRef.current && selectedLinkIdRef.current !== linkId) {
        clearSelection();
      }
    },
    [rootRef, clearSelection],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const linkId = selectedLinkIdRef.current;
      if (!linkId) return;

      const key = event.key;
      const isMod = event.ctrlKey || event.metaKey;

      // Enter on selected pill navigates.
      if (key === 'Enter' && !isMod && !event.shiftKey && !event.altKey) {
        const node = getSelectedPillNode(stateRef.current, linkId);
        if (!node) return;

        event.preventDefault();
        event.stopPropagation();

        const refType = getLinkRefType(node);
        if (refType === 'url' && node.type === 'external_link') {
          window.open(node.url, '_blank', 'noopener,noreferrer');
        } else {
          onPillClick?.(linkId, refType);
        }
        clearSelection();
        return;
      }

      // Copy shortcuts for selected pills.
      if (isMod && key.toLowerCase() === 'c') {
        if (event.shiftKey && event.altKey) return;

        const node = getSelectedPillNode(stateRef.current, linkId);
        if (!node) return;

        event.preventDefault();
        event.stopPropagation();

        const refType = getLinkRefType(node);
        const displayLabel = computeDisplayLabel(node);
        const linkIdForParse = getLinkId(node);
        const { nodeUuid } = linkIdForParse ? parseLinkId(linkIdForParse) : { nodeUuid: '' };

        if (event.shiftKey && !event.altKey) {
          // Shift+Ctrl+C — copy label
          void copyToClipboard(displayLabel);
        } else if (event.altKey && !event.shiftKey) {
          // Alt+Ctrl+C — copy markdown link
          const target = refType === 'url' && node.type === 'external_link' ? node.url : nodeUuid;
          void copyToClipboard(`[${displayLabel}](${target})`);
        } else {
          // Ctrl+C — copy link reference
          const text = refType === 'url' && node.type === 'external_link' ? node.url : `[[${nodeUuid}]]`;
          void copyToClipboard(text);
        }
        return;
      }

      // Any other key clears the visual pill selection so typing/arrows work.
      clearSelection();
    },
    [rootRef, stateRef, onPillClick, clearSelection],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    root.addEventListener('click', handleClick, true);
    root.addEventListener('dblclick', handleDoubleClick, true);
    root.addEventListener('mousedown', handleMouseDown, true);
    root.addEventListener('keydown', handleKeyDown, true);

    return () => {
      root.removeEventListener('click', handleClick, true);
      root.removeEventListener('dblclick', handleDoubleClick, true);
      root.removeEventListener('mousedown', handleMouseDown, true);
      root.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [rootRef, handleClick, handleDoubleClick, handleMouseDown, handleKeyDown]);

  return null;
}
