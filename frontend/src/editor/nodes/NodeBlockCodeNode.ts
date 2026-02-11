/**
 * NodeBlockCodeNode — Variant for code blocks.
 *
 * Renders as a <pre><code> element with optional language.
 */

import {
  type LexicalNode,
  type NodeKey,
  type EditorConfig,
  $applyNodeReplacement,
} from 'lexical';
import { NodeBlockNode, type SerializedNodeBlockNode } from './NodeBlockNode';
import type { GraphNodeType } from '../../runtime/types';

export class NodeBlockCodeNode extends NodeBlockNode {
  __language: string;

  static getType(): string {
    return 'node-block-code';
  }

  static clone(node: NodeBlockCodeNode): NodeBlockCodeNode {
    return new NodeBlockCodeNode(
      node.__blockId,
      node.__language,
      node.__depth,
      node.__key,
    );
  }

  constructor(
    blockId: string,
    language: string = '',
    depth: number = 0,
    key?: NodeKey,
  ) {
    super(blockId, depth, false, 'code' as GraphNodeType, false, null, null, '', key);
    this.__language = language;
  }

  getLanguage(): string {
    return this.__language;
  }

  setLanguage(language: string): this {
    const writable = this.getWritable();
    writable.__language = language;
    return this;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const pre = document.createElement('pre');
    pre.classList.add('node-block-code');
    pre.dataset.blockId = this.__blockId;
    if (this.__language) {
      pre.dataset.language = this.__language;
      pre.classList.add(`language-${this.__language}`);
    }
    return pre;
  }

  updateDOM(prevNode: NodeBlockNode, dom: HTMLElement, _config: EditorConfig): boolean {
    if (!(prevNode instanceof NodeBlockCodeNode)) return true;
    if ((prevNode as NodeBlockCodeNode).__language !== this.__language) {
      if ((prevNode as NodeBlockCodeNode).__language) dom.classList.remove(`language-${(prevNode as NodeBlockCodeNode).__language}`);
      if (this.__language) {
        dom.dataset.language = this.__language;
        dom.classList.add(`language-${this.__language}`);
      }
    }
    return false;
  }

  exportJSON(): SerializedNodeBlockNode & { type: 'node-block-code'; language: string } {
    return {
      ...super.exportJSON(),
      type: 'node-block-code' as unknown as 'node-block',
      language: this.__language,
    } as SerializedNodeBlockNode & { type: 'node-block-code'; language: string };
  }
}

export function $createNodeBlockCodeNode(
  blockId: string,
  language: string = '',
  depth: number = 0,
): NodeBlockCodeNode {
  return $applyNodeReplacement(new NodeBlockCodeNode(blockId, language, depth));
}

export function $isNodeBlockCodeNode(
  node: LexicalNode | null | undefined,
): node is NodeBlockCodeNode {
  return node instanceof NodeBlockCodeNode;
}
