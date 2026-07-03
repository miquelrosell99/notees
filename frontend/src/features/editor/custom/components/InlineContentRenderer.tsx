/**
 * InlineContentRenderer — renders a ContentAST inline stream as React DOM.
 *
 * Used by both the read-only static view and the active custom editor surface.
 * The editable variant relies on the flat unit structure to map logical offsets
 * to DOM positions.
 */

import React, { useMemo, type JSX } from 'react';
import type { ContentAST } from '@/runtime/types';
import type { ASTInlineNode } from '@/types/ast';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { formatDateRange } from '@/utils/dateRange';
import { NodeRef } from '@/features/content/components/nodes/NodeRef';
import { NodeLinkContextMenuTrigger } from '@/features/content';
import { Icon } from '@/components/ui/icons';
import { astToUnits, getInlineChildren } from '../model/inlineEditorModel';
import type { InlineUnit, MarkType } from '../model/types';
import type { InlineLinkRefType } from '@/features/editor/editor/types';
import katex from 'katex';
import 'katex/dist/katex.min.css';

interface InlineContentRendererProps {
  /** Block content AST (JSON string or already-parsed AST). */
  name: string;
  /** Whether this is rendered inside the active editor (affects wrappers). */
  editable?: boolean;
  /** Additional CSS class on each text unit. */
  textUnitClassName?: string;
  /** Called when a link-like pill is clicked. */
  onPillClick?: (linkId: string, refType: InlineLinkRefType) => void;
  /** Called when the user chooses "Edit link" from a pill's context menu. */
  onEditPill?: (linkId: string) => void;
  /** Called when the user chooses "Remove" from a pill's context menu. */
  onRemovePill?: (linkId: string) => void;
  /** Called when the user toggles inline class for a node link. */
  onToggleClassPill?: (linkId: string) => void;
  /** Link id of the currently selected pill (visual selection only). */
  selectedPillLinkId?: string | null;
}

function renderMath(expression: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expression, {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    return displayMode
      ? `<div class="katex-error">$$${expression.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}$$</div>`
      : `<span class="katex-error">$${expression.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}$</span>`;
  }
}

function wrapWithMark(children: React.ReactNode, mark: MarkType): JSX.Element {
  switch (mark) {
    case 'strong':
      return <strong>{children}</strong>;
    case 'em':
      return <em>{children}</em>;
    case 'strikethrough':
      return <s>{children}</s>;
    case 'underline':
      return <u>{children}</u>;
    case 'highlight':
      return <mark>{children}</mark>;
    case 'code':
      return <code>{children}</code>;
  }
}

interface AtomicNodeRendererProps {
  node: ASTInlineNode;
  editable?: boolean;
  onPillClick?: InlineContentRendererProps['onPillClick'];
  onEditPill?: InlineContentRendererProps['onEditPill'];
  onRemovePill?: InlineContentRendererProps['onRemovePill'];
  onToggleClassPill?: InlineContentRendererProps['onToggleClassPill'];
  selectedPillLinkId?: string | null;
}

function AtomicNodeRenderer({ node, editable, onPillClick, onEditPill, onRemovePill, onToggleClassPill, selectedPillLinkId }: AtomicNodeRendererProps): JSX.Element | null {
  switch (node.type) {
    case 'node_link': {
      const { nodeUuid } = parseLinkId(node.link_id);
      const isSelected = selectedPillLinkId === node.link_id;
      const handleKeyDown = onPillClick
        ? (e: React.KeyboardEvent<HTMLSpanElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onPillClick(node.link_id, node.ref_type);
            }
          }
        : undefined;

      return (
        <NodeLinkContextMenuTrigger
          linkId={node.link_id}
          refType={node.ref_type}
          label={node.label}
          nodeUuid={nodeUuid}
          onEdit={editable && onEditPill ? () => onEditPill(node.link_id) : undefined}
          onRemove={editable && onRemovePill ? () => onRemovePill(node.link_id) : undefined}
          onToggleClass={editable && onToggleClassPill ? () => onToggleClassPill(node.link_id) : undefined}
        >
          <span
            className={`inline-link-wrapper${isSelected ? ' inline-link-wrapper--selected' : ''}`}
            data-link-id={node.link_id}
            data-ref-type={node.ref_type}
            data-label={node.label ?? undefined}
            data-editable={editable || undefined}
            contentEditable="false"
            suppressContentEditableWarning
            role={onPillClick ? 'button' : undefined}
            tabIndex={onPillClick ? -1 : undefined}
            onClick={onPillClick ? () => onPillClick(node.link_id, node.ref_type) : undefined}
            onKeyDown={handleKeyDown}
          >
            <NodeRef variant="inline" nodeUuid={nodeUuid} refType={node.ref_type === 'class' ? 'class' : 'node'} customName={node.label ?? undefined} />
          </span>
        </NodeLinkContextMenuTrigger>
      );
    }
    case 'broken_link': {
      const text = node.label || node.link_id.split(':')[0] || '⛓️‍💥';
      const isSelected = selectedPillLinkId === node.link_id;
      const handleBrokenKeyDown = onPillClick
        ? (e: React.KeyboardEvent<HTMLSpanElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onPillClick(node.link_id, 'broken');
            }
          }
        : undefined;
      return (
        <NodeLinkContextMenuTrigger
          linkId={node.link_id}
          refType="broken"
          label={node.label}
          onEdit={editable && onEditPill ? () => onEditPill(node.link_id) : undefined}
          onRemove={editable && onRemovePill ? () => onRemovePill(node.link_id) : undefined}
        >
          <span
            className={`inline-link-wrapper${isSelected ? ' inline-link-wrapper--selected' : ''}`}
            data-link-id={node.link_id}
            data-ref-type="broken"
            data-label={node.label ?? undefined}
            data-editable={editable || undefined}
            contentEditable="false"
            suppressContentEditableWarning
            role={onPillClick ? 'button' : undefined}
            tabIndex={onPillClick ? -1 : undefined}
            title={`Broken link: ${node.link_id}`}
            onClick={onPillClick ? () => onPillClick(node.link_id, 'broken') : undefined}
            onKeyDown={handleBrokenKeyDown}
          >
            <span className="inline-link-inner broken-link" data-ref-type="broken">
              {text}
            </span>
          </span>
        </NodeLinkContextMenuTrigger>
      );
    }
    case 'external_link': {
      const label = node.children.map((c: ASTInlineNode) => ('text' in c ? (c as { text: string }).text : '')).join('');
      const displayText = label || node.url;
      const isSelected = selectedPillLinkId === node.url;
      const handleUrlKeyDown = onPillClick
        ? (e: React.KeyboardEvent<HTMLSpanElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onPillClick(node.url, 'url');
            }
          }
        : undefined;
      return (
        <NodeLinkContextMenuTrigger
          linkId={node.url}
          refType="url"
          label={label}
          url={node.url}
          onEdit={editable && onEditPill ? () => onEditPill(node.url) : undefined}
          onRemove={editable && onRemovePill ? () => onRemovePill(node.url) : undefined}
        >
          <span
            className={`inline-link-wrapper${isSelected ? ' inline-link-wrapper--selected' : ''}`}
            data-link-id={node.url}
            data-ref-type="url"
            data-url={node.url}
            data-editable={editable || undefined}
            contentEditable="false"
            suppressContentEditableWarning
            role={onPillClick ? 'button' : undefined}
            tabIndex={onPillClick ? -1 : undefined}
            onClick={onPillClick ? () => onPillClick(node.url, 'url') : undefined}
            onKeyDown={handleUrlKeyDown}
          >
            <span className="inline-link-inner" data-ref-type="url">
              <span className="inline-link-icon">
                <Icon path="mdi mdi-web" size="14px" />
              </span>
              <span className="inline-link-text">{displayText}</span>
            </span>
          </span>
        </NodeLinkContextMenuTrigger>
      );
    }
    case 'date_range': {
      const label = node.label || formatDateRange(node);
      return (
        <span className="inline-date-range-pill" contentEditable="false" suppressContentEditableWarning title={`${node.start} → ${node.end}`}>
          {label}
        </span>
      );
    }
    case 'math': {
      const html = renderMath(node.expression, node.displayMode ?? false);
      return (
        <span
          className={node.displayMode ? 'math-wrapper math-wrapper--display' : 'math-wrapper'}
          contentEditable="false"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    case 'hard_break':
      return <br contentEditable="false" />;
    default:
      return null;
  }
}

function InlineUnitRenderer({ unit, editable, textUnitClassName, onPillClick, onEditPill, onRemovePill, onToggleClassPill, selectedPillLinkId }: { unit: InlineUnit; editable?: boolean; textUnitClassName?: string; onPillClick?: InlineContentRendererProps['onPillClick']; onEditPill?: InlineContentRendererProps['onEditPill']; onRemovePill?: InlineContentRendererProps['onRemovePill']; onToggleClassPill?: InlineContentRendererProps['onToggleClassPill']; selectedPillLinkId?: string | null }): JSX.Element {
  if (unit.type === 'atomic') {
    return <AtomicNodeRenderer node={unit.node} editable={editable} onPillClick={onPillClick} onEditPill={onEditPill} onRemovePill={onRemovePill} onToggleClassPill={onToggleClassPill} selectedPillLinkId={selectedPillLinkId} />;
  }

  let content: React.ReactNode = unit.text === '' ? '\u200B' : unit.text;
  for (const mark of unit.marks) {
    content = wrapWithMark(content, mark);
  }

  return <span className={textUnitClassName}>{content}</span>;
}

export function InlineContentRenderer({ name, editable, textUnitClassName, onPillClick, onEditPill, onRemovePill, onToggleClassPill, selectedPillLinkId }: InlineContentRendererProps): JSX.Element {
  const ast = useMemo(() => parseAST(name) as ContentAST, [name]);
  const units = useMemo(() => astToUnits(getInlineChildren(ast)), [ast]);

  return (
    <>
      {units.map((unit, index) => (
        <InlineUnitRenderer
          key={index}
          unit={unit}
          editable={editable}
          textUnitClassName={textUnitClassName}
          onPillClick={onPillClick}
          onEditPill={onEditPill}
          onRemovePill={onRemovePill}
          onToggleClassPill={onToggleClassPill}
          selectedPillLinkId={selectedPillLinkId}
        />
      ))}
    </>
  );
}
