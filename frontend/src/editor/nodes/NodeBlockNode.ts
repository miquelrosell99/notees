/**
 * NodeBlockNode — Custom Lexical ElementNode representing a single node/block
 * in the Notees graph.
 *
 * This is NOT an editor-level block. It's a projection of a GraphNode from
 * the NodeGraphRuntime into the Lexical tree. Each NodeBlockNode contains:
 * - blockId: links back to the runtime's GraphNode
 * - depth: indentation level from the projection
 * - collapsed: whether children are hidden
 * - nodeType: page, block, card, etc.
 *
 * The inline content is rendered as standard Lexical text/inline nodes
 * WITHIN this NodeBlockNode. The NodeBlockNode itself is an ElementNode
 * so it can contain children (TextNode, NodePillNode, etc.)
 */

import {
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type EditorConfig,
  type DOMConversionMap,
  type DOMExportOutput,
  type LexicalEditor,
  $applyNodeReplacement,
} from 'lexical';

import type { GraphNodeType } from '../../runtime/types';

// ─── Serialized form ──────────────────────────────────────────────

export interface SerializedNodeBlockNode extends SerializedElementNode {
  type: 'node-block';
  version: 1;
  blockId: string;
  depth: number;
  collapsed: boolean;
  nodeType: GraphNodeType;
  hasChildren: boolean;
  icon: string | null;
  color: string | null;
  blockName: string;
}

// ─── Node class ───────────────────────────────────────────────────

export class NodeBlockNode extends ElementNode {
  __blockId: string;
  __depth: number;
  __collapsed: boolean;
  __nodeType: GraphNodeType;
  __hasChildren: boolean;
  __icon: string | null;
  __color: string | null;
  __blockName: string;

  static getType(): string {
    return 'node-block';
  }

  static clone(node: NodeBlockNode): NodeBlockNode {
    return new NodeBlockNode(
      node.__blockId,
      node.__depth,
      node.__collapsed,
      node.__nodeType,
      node.__hasChildren,
      node.__icon,
      node.__color,
      node.__blockName,
      node.__key,
    );
  }

  constructor(
    blockId: string,
    depth: number = 0,
    collapsed: boolean = false,
    nodeType: GraphNodeType = 'block',
    hasChildren: boolean = false,
    icon: string | null = null,
    color: string | null = null,
    blockName: string = '',
    key?: NodeKey,
  ) {
    super(key);
    this.__blockId = blockId;
    this.__depth = depth;
    this.__collapsed = collapsed;
    this.__nodeType = nodeType;
    this.__hasChildren = hasChildren;
    this.__icon = icon;
    this.__color = color;
    this.__blockName = blockName;
  }

  // ─── Getters/Setters ─────────────────────────────────────────

  getBlockId(): string {
    return this.__blockId;
  }

  getDepth(): number {
    return this.getLatest().__depth;
  }

  setDepth(depth: number): this {
    const writable = this.getWritable();
    writable.__depth = depth;
    return this;
  }

  getCollapsed(): boolean {
    return this.getLatest().__collapsed;
  }

  setCollapsed(collapsed: boolean): this {
    const writable = this.getWritable();
    writable.__collapsed = collapsed;
    return this;
  }

  getNodeType(): GraphNodeType {
    return this.getLatest().__nodeType;
  }

  setNodeType(nodeType: GraphNodeType): this {
    const writable = this.getWritable();
    writable.__nodeType = nodeType;
    return this;
  }

  getHasChildren(): boolean {
    return this.getLatest().__hasChildren;
  }

  setHasChildren(hasChildren: boolean): this {
    const writable = this.getWritable();
    writable.__hasChildren = hasChildren;
    return this;
  }

  getIcon(): string | null {
    return this.getLatest().__icon;
  }

  setIcon(icon: string | null): this {
    const writable = this.getWritable();
    writable.__icon = icon;
    return this;
  }

  getColor(): string | null {
    return this.getLatest().__color;
  }

  setColor(color: string | null): this {
    const writable = this.getWritable();
    writable.__color = color;
    return this;
  }

  getBlockName(): string {
    return this.getLatest().__blockName;
  }

  setBlockName(name: string): this {
    const writable = this.getWritable();
    writable.__blockName = name;
    return this;
  }

  // ─── DOM ──────────────────────────────────────────────────────

  createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement('div');
    dom.classList.add('node-block');
    dom.classList.add(`node-block--${this.__nodeType}`);
    dom.dataset.blockId = this.__blockId;
    dom.dataset.depth = String(this.__depth);
    dom.style.setProperty('--node-block-depth', String(this.__depth));

    if (this.__collapsed) {
      dom.classList.add('node-block--collapsed');
    }
    if (this.__color) {
      dom.style.setProperty('--node-block-color', this.__color);
    }

    return dom;
  }

  updateDOM(prevNode: NodeBlockNode, dom: HTMLElement, _config: EditorConfig): boolean {
    // Update depth
    if (prevNode.__depth !== this.__depth) {
      dom.dataset.depth = String(this.__depth);
      dom.style.setProperty('--node-block-depth', String(this.__depth));
    }

    // Update collapsed
    if (prevNode.__collapsed !== this.__collapsed) {
      dom.classList.toggle('node-block--collapsed', this.__collapsed);
    }

    // Update node type
    if (prevNode.__nodeType !== this.__nodeType) {
      dom.classList.remove(`node-block--${prevNode.__nodeType}`);
      dom.classList.add(`node-block--${this.__nodeType}`);
    }

    // Update color
    if (prevNode.__color !== this.__color) {
      if (this.__color) {
        dom.style.setProperty('--node-block-color', this.__color);
      } else {
        dom.style.removeProperty('--node-block-color');
      }
    }

    return false; // Don't recreate DOM
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement('div');
    element.classList.add('node-block');
    element.dataset.blockId = this.__blockId;
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return null; // We don't import from HTML
  }

  // ─── Serialization ───────────────────────────────────────────

  exportJSON(): SerializedNodeBlockNode {
    return {
      ...super.exportJSON(),
      type: 'node-block',
      version: 1,
      blockId: this.__blockId,
      depth: this.__depth,
      collapsed: this.__collapsed,
      nodeType: this.__nodeType,
      hasChildren: this.__hasChildren,
      icon: this.__icon,
      color: this.__color,
      blockName: this.__blockName,
    };
  }

  static importJSON(json: SerializedNodeBlockNode): NodeBlockNode {
    return $createNodeBlockNode(
      json.blockId,
      json.depth,
      json.collapsed,
      json.nodeType,
      json.hasChildren,
      json.icon,
      json.color,
      json.blockName,
    );
  }

  // ─── Behavior ─────────────────────────────────────────────────

  /** NodeBlockNodes can contain inline content */
  canIndent(): boolean {
    return false; // Indent is handled by NodeGraphRuntime, not Lexical
  }

  /** Blocks are always at root level in the Lexical tree (flat list with depth metadata) */
  isInline(): boolean {
    return false;
  }

  /** Allow merging adjacent text nodes within the block */
  canMergeWhenEmpty(): boolean {
    return false;
  }

  collapseAtStart(): boolean {
    return false;
  }
}

// ─── Factory functions ────────────────────────────────────────────

export function $createNodeBlockNode(
  blockId: string,
  depth: number = 0,
  collapsed: boolean = false,
  nodeType: GraphNodeType = 'block',
  hasChildren: boolean = false,
  icon: string | null = null,
  color: string | null = null,
  blockName: string = '',
): NodeBlockNode {
  return $applyNodeReplacement(
    new NodeBlockNode(blockId, depth, collapsed, nodeType, hasChildren, icon, color, blockName),
  );
}

export function $isNodeBlockNode(
  node: LexicalNode | null | undefined,
): node is NodeBlockNode {
  return node instanceof NodeBlockNode;
}
