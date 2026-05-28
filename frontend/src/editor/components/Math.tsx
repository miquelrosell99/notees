/**
 * Math — KaTeX renderer for Lexical MathNode decorator.
 */
import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export interface MathProps {
  expression: string;
  displayMode?: boolean;
}

export function Math({ expression, displayMode = false }: MathProps) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(expression, {
        displayMode,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return displayMode
        ? `<div class="katex-error">$$${escapeHtml(expression)}$$</div>`
        : `<span class="katex-error">$${escapeHtml(expression)}$</span>`;
    }
  }, [expression, displayMode]);

  return (
    <span
      className={displayMode ? 'math-inner math-inner--display' : 'math-inner'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
