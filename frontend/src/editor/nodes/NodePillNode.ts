/**
 * NodePillNode — Lexical DecoratorNode for rendering inline node/class references.
 *
 * Renders as an atomic inline element (pill) that represents a link
 * to another node in the graph. The pill shows the target node's name/icon
 * and is non-editable inline content.
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
import type { JSX } from 'react';

// ─── Serialized form ──────────────────────────────────────────────

export interface SerializedNodePillNode extends SerializedLexicalNode {
  type: 'node-pill';
  version: 1;
  linkId: string;
  refType: 'node' | 'class';
}

// ─── Node class ───────────────────────────────────────────────────

export class NodePillNode extends DecoratorNode<JSX.Element> {
  __linkId: string;
  __refType: 'node' | 'class';

  static getType(): string {
    return 'node-pill';
  }

  static clone(node: NodePillNode): NodePillNode {
    return new NodePillNode(node.__linkId, node.__refType, node.__key);
  }

  constructor(linkId: string, refType: 'node' | 'class' = 'node', key?: NodeKey) {
    super(key);
    this.__linkId = linkId;
    this.__refType = refType;
  }

  // ─── Getters ──────────────────────────────────────────────────

  getLinkId(): string {
    return this.__linkId;
  }

  getRefType(): 'node' | 'class' {
    return this.__refType;
  }

  // ─── DOM ──────────────────────────────────────────────────────

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.classList.add('node-pill-wrapper');
    span.dataset.linkId = this.__linkId;
    span.dataset.refType = this.__refType;
    span.contentEditable = 'false';
    return span;
  }

  updateDOM(prevNode: NodePillNode, dom: HTMLElement): boolean {
    if (prevNode.__linkId !== this.__linkId) {
      dom.dataset.linkId = this.__linkId;
    }
    if (prevNode.__refType !== this.__refType) {
      dom.dataset.refType = this.__refType;
    }
    return false;
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const span = document.createElement('span');
    span.classList.add('node-pill');
    span.dataset.linkId = this.__linkId;
    span.textContent = `[[${this.__linkId}]]`;
    return { element: span };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  // ─── Serialization ───────────────────────────────────────────

  exportJSON(): SerializedNodePillNode {
    return {
      type: 'node-pill',
      version: 1,
      linkId: this.__linkId,
      refType: this.__refType,
    };
  }

  static importJSON(json: SerializedNodePillNode): NodePillNode {
    return $createNodePillNode(json.linkId, json.refType);
  }

  // ─── Behavior ─────────────────────────────────────────────────

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  /**
   * Decorator render — returns a React element.
   * The actual React component is provided by the NodePillComponent.
   */
  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    // This will be overridden by the NodePillPlugin which registers
    // a decorator component. For now, return a placeholder.
    // The actual rendering is handled by NodePillPlugin.
    return null as unknown as JSX.Element;
  }
}

// ─── Factory functions ────────────────────────────────────────────

export function $createNodePillNode(
  linkId: string,
  refType: 'node' | 'class' = 'node',
): NodePillNode {
  return $applyNodeReplacement(new NodePillNode(linkId, refType));
}

export function $isNodePillNode(
  node: LexicalNode | null | undefined,
): node is NodePillNode {
  return node instanceof NodePillNode;
}
