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
import { astToUnits, getInlineChildren } from '../model/inlineEditorModel';
import type { InlineUnit, MarkType } from '../model/types';
import katex from 'katex';
import 'katex/dist/katex.min.css';

interface InlineContentRendererProps {
  /** Block content AST (JSON string or already-parsed AST). */
  name: string;
  /** Whether this is rendered inside the active editor (affects wrappers). */
  editable?: boolean;
  /** Additional CSS class on each text unit. */
  textUnitClassName?: string;
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

function AtomicNodeRenderer({ node }: { node: ASTInlineNode }): JSX.Element | null {
  switch (node.type) {
    case 'node_link': {
      const { nodeUuid } = parseLinkId(node.link_id);
      return (
        <span className="inline-link-wrapper" data-link-id={node.link_id} data-ref-type={node.ref_type} contentEditable="false">
          <NodeRef variant="inline" nodeUuid={nodeUuid} refType={node.ref_type === 'class' ? 'class' : 'node'} customName={node.label ?? undefined} />
        </span>
      );
    }
    case 'broken_link': {
      const text = node.label || node.link_id.split(':')[0] || '⛓️‍💥';
      return (
        <span className="broken-link" contentEditable="false" title={`Broken link: ${node.link_id}`}>
          {text}
        </span>
      );
    }
    case 'external_link': {
      const label = node.children.map((c: ASTInlineNode) => ('text' in c ? (c as { text: string }).text : '')).join('');
      return (
        <a href={node.url} target="_blank" rel="noreferrer" contentEditable="false">
          {label || node.url}
        </a>
      );
    }
    case 'date_range': {
      const label = node.label || formatDateRange(node);
      return (
        <span className="inline-date-range-pill" contentEditable="false" title={`${node.start} → ${node.end}`}>
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

function InlineUnitRenderer({ unit, textUnitClassName }: { unit: InlineUnit; textUnitClassName?: string }): JSX.Element {
  if (unit.type === 'atomic') {
    return <AtomicNodeRenderer node={unit.node} />;
  }

  let content: React.ReactNode = unit.text === '' ? '\u200B' : unit.text;
  for (const mark of unit.marks) {
    content = wrapWithMark(content, mark);
  }

  return <span className={textUnitClassName}>{content}</span>;
}

export function InlineContentRenderer({ name, textUnitClassName }: InlineContentRendererProps): JSX.Element {
  const ast = useMemo(() => parseAST(name) as ContentAST, [name]);
  const units = useMemo(() => astToUnits(getInlineChildren(ast)), [ast]);

  return (
    <>
      {units.map((unit, index) => (
        <InlineUnitRenderer key={index} unit={unit} textUnitClassName={textUnitClassName} />
      ))}
    </>
  );
}
