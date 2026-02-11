/**
 * NodeBlockHeadingNode — Variant of NodeBlockNode for page/card headers.
 *
 * Renders as an h1/h2 element depending on context.
 * Used at the top of page views and card views.
 */

import {
  type LexicalNode,
  type NodeKey,
  type EditorConfig,
  $applyNodeReplacement,
} from 'lexical';
import { NodeBlockNode, type SerializedNodeBlockNode } from './NodeBlockNode';
import type { GraphNodeType } from '../../runtime/types';

export interface SerializedNodeBlockHeadingNode extends Omit<SerializedNodeBlockNode, 'type'> {
  type: 'node-block-heading';
  level: 1 | 2 | 3;
}

export class NodeBlockHeadingNode extends NodeBlockNode {
  __level: 1 | 2 | 3;

  static getType(): string {
    return 'node-block-heading';
  }

  static clone(node: NodeBlockHeadingNode): NodeBlockHeadingNode {
    return new NodeBlockHeadingNode(
      node.__blockId,
      node.__level,
      node.__depth,
      node.__nodeType,
      node.__icon,
      node.__color,
      node.__blockName,
      node.__key,
    );
  }

  constructor(
    blockId: string,
    level: 1 | 2 | 3 = 1,
    depth: number = 0,
    nodeType: GraphNodeType = 'page',
    icon: string | null = null,
    color: string | null = null,
    blockName: string = '',
    key?: NodeKey,
  ) {
    super(blockId, depth, false, nodeType, false, icon, color, blockName, key);
    this.__level = level;
  }

  getLevel(): number {
    return this.__level;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const tag = `h${this.__level}` as keyof HTMLElementTagNameMap;
    const dom = document.createElement(tag);
    dom.classList.add('node-block-heading');
    dom.classList.add(`node-block-heading--h${this.__level}`);
    dom.dataset.blockId = this.__blockId;
    if (this.__color) {
      dom.style.setProperty('--node-block-color', this.__color);
    }
    return dom;
  }

  updateDOM(prevNode: NodeBlockNode, dom: HTMLElement, _config: EditorConfig): boolean {
    if (!(prevNode instanceof NodeBlockHeadingNode)) return true;
    if ((prevNode as NodeBlockHeadingNode).__level !== this.__level) return true; // Recreate DOM for tag change
    if ((prevNode as NodeBlockHeadingNode).__color !== this.__color) {
      if (this.__color) {
        dom.style.setProperty('--node-block-color', this.__color);
      } else {
        dom.style.removeProperty('--node-block-color');
      }
    }
    return false;
  }

  // @ts-expect-error - subclass uses different 'type' discriminant
  exportJSON(): SerializedNodeBlockHeadingNode {
    return {
      ...super.exportJSON(),
      type: 'node-block-heading',
      level: this.__level,
    };
  }

  static importJSON(json: SerializedNodeBlockHeadingNode): NodeBlockHeadingNode {
    return new NodeBlockHeadingNode(json.blockId, json.level);
  }
}

export function $createNodeBlockHeadingNode(
  blockId: string,
  level: 1 | 2 | 3 = 1,
  nodeType: GraphNodeType = 'page',
  icon: string | null = null,
  color: string | null = null,
  blockName: string = '',
): NodeBlockHeadingNode {
  return $applyNodeReplacement(
    new NodeBlockHeadingNode(blockId, level, 0, nodeType, icon, color, blockName),
  );
}

export function $isNodeBlockHeadingNode(
  node: LexicalNode | null | undefined,
): node is NodeBlockHeadingNode {
  return node instanceof NodeBlockHeadingNode;
}
