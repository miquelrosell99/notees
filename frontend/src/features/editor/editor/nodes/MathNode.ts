/**
 * MathNode — Lexical DecoratorNode for rendering inline math formulas.
 *
 * Renders as an atomic inline element that displays LaTeX via KaTeX.
 */

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type DOMExportOutput,
  type LexicalEditor,
  type EditorConfig,
  $applyNodeReplacement,
  type DOMConversionMap,
} from 'lexical';
import { createElement, type JSX } from 'react';
import { Math } from '@/features/editor/editor/components/Math';

// ─── Types ────────────────────────────────────────────────────────

export interface SerializedMathNode extends SerializedLexicalNode {
  type: 'math';
  version: 1;
  expression: string;
  displayMode: boolean;
}

// ─── Node class ───────────────────────────────────────────────────

export class MathNode extends DecoratorNode<JSX.Element> {
  __expression: string;
  __displayMode: boolean;

  static getType(): string {
    return 'math';
  }

  static clone(node: MathNode): MathNode {
    return new MathNode(node.__expression, node.__displayMode, node.__key);
  }

  constructor(expression: string, displayMode = false, key?: NodeKey) {
    super(key);
    this.__expression = expression;
    this.__displayMode = displayMode;
  }

  // ─── Getters ──────────────────────────────────────────────────

  getExpression(): string {
    return this.__expression;
  }

  getDisplayMode(): boolean {
    return this.__displayMode;
  }

  // ─── DOM ──────────────────────────────────────────────────────

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.classList.add('math-wrapper');
    if (this.__displayMode) {
      span.classList.add('math-wrapper--display');
    }
    span.dataset.expression = this.__expression;
    span.dataset.displayMode = String(this.__displayMode);
    span.contentEditable = 'false';
    span.setAttribute('tabindex', '-1');
    return span;
  }

  updateDOM(prevNode: MathNode, dom: HTMLElement): boolean {
    if (prevNode.__expression !== this.__expression) {
      dom.dataset.expression = this.__expression;
    }
    if (prevNode.__displayMode !== this.__displayMode) {
      dom.dataset.displayMode = String(this.__displayMode);
      dom.classList.toggle('math-wrapper--display', this.__displayMode);
    }
    return false;
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const span = document.createElement('span');
    span.classList.add('math');
    if (this.__displayMode) {
      span.classList.add('math--display');
    }
    span.textContent = this.__displayMode
      ? `$$${this.__expression}$$`
      : `$${this.__expression}$`;
    return { element: span };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  // ─── Serialization ───────────────────────────────────────────

  exportJSON(): SerializedMathNode {
    return {
      type: 'math',
      version: 1,
      expression: this.__expression,
      displayMode: this.__displayMode,
    };
  }

  static importJSON(json: SerializedMathNode): MathNode {
    return $createMathNode(json.expression, json.displayMode);
  }

  // ─── Behavior ─────────────────────────────────────────────────

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  /**
   * Decorator render — returns a React element portaled into the math wrapper.
   */
  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return createElement(Math, {
      expression: this.__expression,
      displayMode: this.__displayMode,
    });
  }
}

// ─── Factory functions ────────────────────────────────────────────

export function $createMathNode(expression: string, displayMode = false): MathNode {
  return $applyNodeReplacement(new MathNode(expression, displayMode));
}

export function $isMathNode(
  node: LexicalNode | null | undefined,
): node is MathNode {
  return node instanceof MathNode;
}
