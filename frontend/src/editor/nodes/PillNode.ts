/**
 * PillNode — Lexical DecoratorNode for rendering inline node/class references.
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
import { createElement, type JSX } from 'react';
import { InlineNodeLink } from '../components/InlineNodeLink';

// ─── Types ────────────────────────────────────────────────────────

export type PillRefType = 'node' | 'class' | 'url' | 'embed';

// ─── Serialized form ──────────────────────────────────────────────

export interface SerializedPillNode extends SerializedLexicalNode {
  type: 'node-pill';
  version: 1;
  linkId: string;
  refType: PillRefType;
  /** URL for external-link pills (refType === 'url'). */
  url?: string;
  /** Custom display label (e.g., [laboral]([[uuid]])) — overrides target node name. */
  label?: string;
}

// ─── Node class ───────────────────────────────────────────────────

export class PillNode extends DecoratorNode<JSX.Element> {
  __linkId: string;
  __refType: PillRefType;
  /** URL for external-link pills. */
  __url: string;
  /** Custom display label — overrides target node name when set. */
  __label: string;

  static getType(): string {
    return 'node-pill';
  }

  static clone(node: PillNode): PillNode {
    return new PillNode(node.__linkId, node.__refType, node.__key, node.__url, node.__label);
  }

  constructor(linkId: string, refType: PillRefType = 'node', key?: NodeKey, url = '', label = '') {
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

  getRefType(): PillRefType {
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
    span.classList.add('node-pill-wrapper');
    span.dataset.linkId = this.__linkId;
    span.dataset.refType = this.__refType;
    if (this.__url) span.dataset.url = this.__url;
    if (this.__label) span.dataset.label = this.__label;
    span.contentEditable = 'false';
    span.setAttribute('tabindex', '-1');
    return span;
  }

  updateDOM(prevNode: PillNode, dom: HTMLElement): boolean {
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
    span.classList.add('node-pill');
    span.dataset.linkId = this.__linkId;
    span.textContent = `[[${this.__linkId}]]`;
    return { element: span };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  // ─── Serialization ───────────────────────────────────────────

  exportJSON(): SerializedPillNode {
    const json: SerializedPillNode = {
      type: 'node-pill',
      version: 1,
      linkId: this.__linkId,
      refType: this.__refType,
    };
    if (this.__url) json.url = this.__url;
    if (this.__label) json.label = this.__label;
    return json;
  }

  static importJSON(json: SerializedPillNode): PillNode {
    return $createPillNode(json.linkId, json.refType, json.url, json.label);
  }

  // ─── Behavior ─────────────────────────────────────────────────

  isInline(): boolean {
    return true;
  }

  /**
   * Not isolated - we handle navigation ourselves via NodeLinkPlugin.
   * Setting this to true causes Lexical's default navigation to fail
   * with "key is read-only" errors when trying to jump over the node.
   */
  isIsolated(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  /**
   * Decorator render — returns a React element portaled into the pill wrapper.
   */
  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return createElement(InlineNodeLink, {
      linkId: this.__linkId,
      refType: this.__refType,
      url: this.__url || undefined,
      label: this.__label || undefined,
    });
  }
}

// ─── Factory functions ────────────────────────────────────────────

export function $createPillNode(
  linkId: string,
  refType: PillRefType = 'node',
  url?: string,
  label?: string,
): PillNode {
  return $applyNodeReplacement(new PillNode(linkId, refType, undefined, url ?? '', label));
}

export function $isPillNode(
  node: LexicalNode | null | undefined,
): node is PillNode {
  return node instanceof PillNode;
}
