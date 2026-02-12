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
  isProjectionRoot: boolean;
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
  __isProjectionRoot: boolean;

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
      node.__isProjectionRoot,
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
    isProjectionRoot: boolean = false,
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
    this.__isProjectionRoot = isProjectionRoot;
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

  getIsProjectionRoot(): boolean {
    return this.getLatest().__isProjectionRoot;
  }

  setIsProjectionRoot(isProjectionRoot: boolean): this {
    const writable = this.getWritable();
    writable.__isProjectionRoot = isProjectionRoot;
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
    if (this.__hasChildren) {
      dom.classList.add('node-block--has-children');
    }
    if (this.__isProjectionRoot) {
      dom.classList.add('node-block--projection-root');
    }

    // Create bullet wrapper
    const bullet = document.createElement('div');
    bullet.className = 'node-block-bullet';
    bullet.dataset.blockId = this.__blockId;
    bullet.draggable = !this.__isProjectionRoot;
    
    // Prevent text selection when mousedown on bullet
    bullet.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
    });
    
    // Collapse arrow (only create if has children)
    if (this.__hasChildren) {
      const collapseArrow = document.createElement('button');
      collapseArrow.className = 'node-block-collapse-arrow';
      collapseArrow.setAttribute('aria-label', this.__collapsed ? 'Expand' : 'Collapse');
      collapseArrow.innerHTML = this.__collapsed
        ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>';
      bullet.appendChild(collapseArrow);
    }

    // Bullet container
    const bulletContainer = document.createElement('span');
    bulletContainer.className = 'node-block-bullet-container';
    
    // Outer ring (for collapsed state or hover)
    const outerRing = document.createElement('span');
    outerRing.className = 'node-block-outer-ring';
    bulletContainer.appendChild(outerRing);
    
    // Bullet dot or icon
    if (this.__icon) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'node-block-icon';
      iconSpan.textContent = this.__icon;
      bulletContainer.appendChild(iconSpan);
    } else {
      const dot = document.createElement('span');
      dot.className = 'node-block-dot';
      bulletContainer.appendChild(dot);
    }
    
    bullet.appendChild(bulletContainer);
    dom.appendChild(bullet);

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
      // Update collapse arrow icon
      const collapseArrow = dom.querySelector('.node-block-collapse-arrow');
      if (collapseArrow) {
        collapseArrow.setAttribute('aria-label', this.__collapsed ? 'Expand' : 'Collapse');
        collapseArrow.innerHTML = this.__collapsed
          ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>'
          : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>';
      }
    }

    // Update node type
    if (prevNode.__nodeType !== this.__nodeType) {
      dom.classList.remove(`node-block--${prevNode.__nodeType}`);
      dom.classList.add(`node-block--${this.__nodeType}`);
    }

    // Update hasChildren
    if (prevNode.__hasChildren !== this.__hasChildren) {
      dom.classList.toggle('node-block--has-children', this.__hasChildren);
      
      // Add or remove collapse arrow
      const bullet = dom.querySelector('.node-block-bullet');
      if (bullet) {
        const existingArrow = bullet.querySelector('.node-block-collapse-arrow');
        
        if (this.__hasChildren && !existingArrow) {
          // Add collapse arrow
          const collapseArrow = document.createElement('button');
          collapseArrow.className = 'node-block-collapse-arrow';
          collapseArrow.setAttribute('aria-label', this.__collapsed ? 'Expand' : 'Collapse');
          collapseArrow.innerHTML = this.__collapsed
            ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>';
          bullet.insertBefore(collapseArrow, bullet.firstChild);
        } else if (!this.__hasChildren && existingArrow) {
          // Remove collapse arrow
          existingArrow.remove();
        }
      }
    }

    // Update isProjectionRoot
    if (prevNode.__isProjectionRoot !== this.__isProjectionRoot) {
      dom.classList.toggle('node-block--projection-root', this.__isProjectionRoot);
      const bullet = dom.querySelector('.node-block-bullet') as HTMLElement | null;
      if (bullet) bullet.draggable = !this.__isProjectionRoot;
    }

    // Update color
    if (prevNode.__color !== this.__color) {
      if (this.__color) {
        dom.style.setProperty('--node-block-color', this.__color);
      } else {
        dom.style.removeProperty('--node-block-color');
      }
    }

    // Update icon
    if (prevNode.__icon !== this.__icon) {
      const bulletContainer = dom.querySelector('.node-block-bullet-container');
      if (bulletContainer) {
        // Remove old dot/icon
        const oldDot = bulletContainer.querySelector('.node-block-dot');
        const oldIcon = bulletContainer.querySelector('.node-block-icon');
        if (oldDot) oldDot.remove();
        if (oldIcon) oldIcon.remove();
        
        // Add new dot/icon
        if (this.__icon) {
          const iconSpan = document.createElement('span');
          iconSpan.className = 'node-block-icon';
          iconSpan.textContent = this.__icon;
          bulletContainer.appendChild(iconSpan);
        } else {
          const dot = document.createElement('span');
          dot.className = 'node-block-dot';
          bulletContainer.appendChild(dot);
        }
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
      isProjectionRoot: this.__isProjectionRoot,
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
      json.isProjectionRoot,
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
  isProjectionRoot: boolean = false,
): NodeBlockNode {
  return $applyNodeReplacement(
    new NodeBlockNode(blockId, depth, collapsed, nodeType, hasChildren, icon, color, blockName, isProjectionRoot),
  );
}

export function $isNodeBlockNode(
  node: LexicalNode | null | undefined,
): node is NodeBlockNode {
  return node instanceof NodeBlockNode;
}
