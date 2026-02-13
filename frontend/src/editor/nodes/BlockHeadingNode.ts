/**
 * BlockHeadingNode — Variant of BlockNode for page/card headers.
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
import { BlockNode, type SerializedBlockNode } from './BlockNode';
import type { GraphNodeType } from '../../runtime/types';
import { parseColorToRgb } from '@/utils/color';

export interface SerializedBlockHeadingNode extends Omit<SerializedBlockNode, 'type'> {
  type: 'node-block-heading';
  level: 1 | 2 | 3;
}

export class BlockHeadingNode extends BlockNode {
  __level: 1 | 2 | 3;

  static getType(): string {
    return 'node-block-heading';
  }

  static clone(node: BlockHeadingNode): BlockHeadingNode {
    return new BlockHeadingNode(
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
      const rgb = parseColorToRgb(this.__color);
      if (rgb) {
        dom.style.setProperty('--node-color-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
      }
    }
    return dom;
  }

  updateDOM(prevNode: BlockNode, dom: HTMLElement, _config: EditorConfig): boolean {
    if (!(prevNode instanceof BlockHeadingNode)) return true;
    if ((prevNode as BlockHeadingNode).__level !== this.__level) return true; // Recreate DOM for tag change
    if ((prevNode as BlockHeadingNode).__color !== this.__color) {
      if (this.__color) {
        dom.style.setProperty('--node-block-color', this.__color);
        const rgb = parseColorToRgb(this.__color);
        if (rgb) {
          dom.style.setProperty('--node-color-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
        }
      } else {
        dom.style.removeProperty('--node-block-color');
        dom.style.removeProperty('--node-color-rgb');
      }
    }
    return false;
  }

  // @ts-expect-error - subclass uses different 'type' discriminant
  exportJSON(): SerializedBlockHeadingNode {
    return {
      ...super.exportJSON(),
      type: 'node-block-heading',
      level: this.__level,
    };
  }

  static importJSON(json: SerializedBlockHeadingNode): BlockHeadingNode {
    return new BlockHeadingNode(
      json.blockId,
      json.level,
      json.depth ?? 0,
      json.nodeType ?? 'page',
      json.icon ?? null,
      json.color ?? null,
      json.blockName ?? '',
    );
  }
}

export function $createBlockHeadingNode(
  blockId: string,
  level: 1 | 2 | 3 = 1,
  nodeType: GraphNodeType = 'page',
  icon: string | null = null,
  color: string | null = null,
  blockName: string = '',
): BlockHeadingNode {
  return $applyNodeReplacement(
    new BlockHeadingNode(blockId, level, 0, nodeType, icon, color, blockName),
  );
}

export function $isBlockHeadingNode(
  node: LexicalNode | null | undefined,
): node is BlockHeadingNode {
  return node instanceof BlockHeadingNode;
}
