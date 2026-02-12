/**
 * BlockCodeNode — Variant for code blocks.
 *
 * Renders as a <pre><code> element with optional language.
 */

import {
  type LexicalNode,
  type NodeKey,
  type EditorConfig,
  $applyNodeReplacement,
} from 'lexical';
import { BlockNode, type SerializedBlockNode } from './BlockNode';
import type { GraphNodeType } from '../../runtime/types';

export class BlockCodeNode extends BlockNode {
  __language: string;

  static getType(): string {
    return 'node-block-code';
  }

  static clone(node: BlockCodeNode): BlockCodeNode {
    return new BlockCodeNode(
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

  updateDOM(prevNode: BlockNode, dom: HTMLElement, _config: EditorConfig): boolean {
    if (!(prevNode instanceof BlockCodeNode)) return true;
    if ((prevNode as BlockCodeNode).__language !== this.__language) {
      if ((prevNode as BlockCodeNode).__language) dom.classList.remove(`language-${(prevNode as BlockCodeNode).__language}`);
      if (this.__language) {
        dom.dataset.language = this.__language;
        dom.classList.add(`language-${this.__language}`);
      }
    }
    return false;
  }

  exportJSON(): SerializedBlockNode & { type: 'node-block-code'; language: string } {
    return {
      ...super.exportJSON(),
      type: 'node-block-code' as unknown as 'node-block',
      language: this.__language,
    } as SerializedBlockNode & { type: 'node-block-code'; language: string };
  }

  static importJSON(json: SerializedBlockNode & { language?: string }): BlockCodeNode {
    return $createBlockCodeNode(
      json.blockId,
      json.language ?? '',
      json.depth,
    );
  }
}

export function $createBlockCodeNode(
  blockId: string,
  language: string = '',
  depth: number = 0,
): BlockCodeNode {
  return $applyNodeReplacement(new BlockCodeNode(blockId, language, depth));
}

export function $isBlockCodeNode(
  node: LexicalNode | null | undefined,
): node is BlockCodeNode {
  return node instanceof BlockCodeNode;
}
