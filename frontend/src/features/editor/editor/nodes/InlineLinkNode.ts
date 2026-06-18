/**
 * InlineLinkNode — Lexical DecoratorNode for rendering inline link references.
 *
 * Renders as an atomic inline element that represents a link
 * to another node in the graph, a URL, or an embed. Shows the target
 * node's name/icon and is non-editable inline content.
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
import { InlineLink } from '@/features/editor/editor/components/InlineLink';

// ─── Types ────────────────────────────────────────────────────────

export type InlineLinkRefType = 'node' | 'class' | 'url' | 'embed' | 'broken' | 'user';

// ─── Serialized form ──────────────────────────────────────────────

export interface SerializedInlineLinkNode extends SerializedLexicalNode {
  type: 'inline-link';
  version: 1;
  linkId: string;
  refType: InlineLinkRefType;
  /** URL for external-link pills (refType === 'url'). */
  url?: string;
  /** Custom display label (e.g., [laboral]([[uuid]])) — overrides target node name. */
  label?: string;
}

// ─── Node class ───────────────────────────────────────────────────

export class InlineLinkNode extends DecoratorNode<JSX.Element> {
  __linkId: string;
  __refType: InlineLinkRefType;
  /** URL for external-link pills. */
  __url: string;
  /** Custom display label — overrides target node name when set. */
  __label: string;

  static getType(): string {
    return 'inline-link';
  }

  static clone(node: InlineLinkNode): InlineLinkNode {
    return new InlineLinkNode(node.__linkId, node.__refType, node.__key, node.__url, node.__label);
  }

  constructor(linkId: string, refType: InlineLinkRefType = 'node', key?: NodeKey, url = '', label = '') {
    super(key);
    this.__linkId = linkId;
    this.__refType = refType;
    this.__url = url;
    this.__label = label;
  }

  // ─── Getters ──────────────────────────────────────────────────

  getLinkId(): string {
    return this.__linkId;
  }

  getRefType(): InlineLinkRefType {
    return this.__refType;
  }

  getUrl(): string {
    return this.__url;
  }

  getLabel(): string {
    return this.__label;
  }

  // ─── DOM ──────────────────────────────────────────────────────

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.classList.add('inline-link-wrapper');
    span.dataset.linkId = this.__linkId;
    span.dataset.refType = this.__refType;
    if (this.__url) span.dataset.url = this.__url;
    if (this.__label) span.dataset.label = this.__label;
    span.contentEditable = 'false';
    span.setAttribute('tabindex', '-1');
    return span;
  }

  updateDOM(prevNode: InlineLinkNode, dom: HTMLElement): boolean {
    if (prevNode.__linkId !== this.__linkId) {
      dom.dataset.linkId = this.__linkId;
    }
    if (prevNode.__refType !== this.__refType) {
      dom.dataset.refType = this.__refType;
    }
    if (prevNode.__url !== this.__url) {
      if (this.__url) dom.dataset.url = this.__url;
      else delete dom.dataset.url;
    }
    if (prevNode.__label !== this.__label) {
      if (this.__label) dom.dataset.label = this.__label;
      else delete dom.dataset.label;
    }
    return false;
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const span = document.createElement('span');
    span.classList.add('inline-link');
    span.dataset.linkId = this.__linkId;
    span.textContent = `[[${this.__linkId}]]`;
    return { element: span };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  // ─── Serialization ───────────────────────────────────────────

  exportJSON(): SerializedInlineLinkNode {
    const json: SerializedInlineLinkNode = {
      type: 'inline-link',
      version: 1,
      linkId: this.__linkId,
      refType: this.__refType,
    };
    if (this.__url) json.url = this.__url;
    if (this.__label) json.label = this.__label;
    return json;
  }

  static importJSON(json: SerializedInlineLinkNode): InlineLinkNode {
    return $createInlineLinkNode(json.linkId, json.refType, json.url, json.label);
  }

  // ─── Behavior ─────────────────────────────────────────────────

  isInline(): boolean {
    return true;
  }

  /**
   * Not isolated — pills should be keyboard-selectable and deletable.
   * `isIsolated=true` makes Lexical skip over the node entirely during
   * navigation and deletion, which is wrong for inline link pills.
   */
  isIsolated(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  /**
   * Decorator render — returns a React element portaled into the inline link wrapper.
   */
  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return createElement(InlineLink, {
      linkId: this.__linkId,
      refType: this.__refType,
      url: this.__url || undefined,
      label: this.__label || undefined,
    });
  }
}

// ─── Factory functions ────────────────────────────────────────────

export function $createInlineLinkNode(
  linkId: string,
  refType: InlineLinkRefType = 'node',
  url?: string,
  label?: string,
): InlineLinkNode {
  return $applyNodeReplacement(new InlineLinkNode(linkId, refType, undefined, url ?? '', label));
}

export function $isInlineLinkNode(
  node: LexicalNode | null | undefined,
): node is InlineLinkNode {
  return node instanceof InlineLinkNode;
}
