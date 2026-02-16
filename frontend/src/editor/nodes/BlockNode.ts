/**
 * BlockNode — Custom Lexical ElementNode representing a single node/block
 * in the Notees graph.
 *
 * This is NOT an editor-level block. It's a projection of a GraphNode from
 * the NodeGraphRuntime into the Lexical tree. Each BlockNode contains:
 * - blockId: links back to the runtime's GraphNode
 * - depth: indentation level from the projection
 * - collapsed: whether children are hidden
 * - nodeType: page, block, card, etc.
 *
 * The inline content is rendered as standard Lexical text/inline nodes
 * WITHIN this BlockNode. The BlockNode itself is an ElementNode
 * so it can contain children (TextNode, PillNode, etc.)
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
  setDOMUnmanaged,
} from 'lexical';

import type { GraphNodeType } from '../../runtime/types';
import { parseColorToRgb } from '@/utils/color';

// ─── Serialized form ──────────────────────────────────────────────

export interface SerializedBlockNode extends SerializedElementNode {
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
  classIds: string[];
}

// ─── Node class ───────────────────────────────────────────────────

export class BlockNode extends ElementNode {
  __blockId: string;
  __depth: number;
  __collapsed: boolean;
  __nodeType: GraphNodeType;
  __hasChildren: boolean;
  __icon: string | null;
  __color: string | null;
  __blockName: string;
  __isProjectionRoot: boolean;
  __classIds: string[];

  static getType(): string {
    return 'node-block';
  }

  static clone(node: BlockNode): BlockNode {
    return new BlockNode(
      node.__blockId,
      node.__depth,
      node.__collapsed,
      node.__nodeType,
      node.__hasChildren,
      node.__icon,
      node.__color,
      node.__blockName,
      node.__isProjectionRoot,
      node.__classIds,
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
    classIds: string[] = [],
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
    this.__classIds = classIds;
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

  getClassIds(): string[] {
    return this.getLatest().__classIds;
  }

  setClassIds(classIds: string[]): this {
    const writable = this.getWritable();
    writable.__classIds = classIds;
    return this;
  }

  // ─── DOM ──────────────────────────────────────────────────────

  /**
   * Tell Lexical to insert managed children into the content wrapper.
   * This keeps them flowing as inline text rather than becoming
   * separate flex items of the outer .node-block flex container.
   */
  getDOMSlot(element: HTMLElement) {
    const contentSlot = element.querySelector('.node-block-content');
    return contentSlot
      ? super.getDOMSlot(element).withElement(contentSlot as HTMLElement)
      : super.getDOMSlot(element);
  }

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
      const rgb = parseColorToRgb(this.__color);
      if (rgb) {
        dom.style.setProperty('--node-color-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
      }
    }
    if (this.__hasChildren) {
      dom.classList.add('node-block--has-children');
    }
    if (this.__isProjectionRoot) {
      dom.classList.add('node-block--projection-root');
    }

    // ── Block UI container ─────────────────────────────────────
    // Non-editable area for bullet, property icons, class pills.
    // Consolidated portal target that prevents mouse events from
    // interfering with Lexical's contentEditable selection engine.
    const blockUI = document.createElement('div');
    blockUI.className = 'block-ui';
    blockUI.contentEditable = 'false';
    setDOMUnmanaged(blockUI);
    // Prevent mousedown from stealing focus/selection from editor
    blockUI.addEventListener('mousedown', (e: MouseEvent) => {
      // Allow clicks on buttons/interactive elements within block-ui
      const target = e.target as HTMLElement;
      if (target.closest('button, a, [role="button"], .block-prop-icon-btn')) return;
      e.preventDefault();
    });

    // Create bullet wrapper - uses shared bullet-* classes from Bullet component
    const bullet = document.createElement('div');
    bullet.className = 'bullet-wrapper bullet-sm bullet-interactive';
    if (this.__hasChildren) bullet.classList.add('bullet-has-children');
    if (this.__collapsed) bullet.classList.add('bullet-collapsed');
    bullet.dataset.blockId = this.__blockId;
    bullet.draggable = !this.__isProjectionRoot;
    
    // Collapse arrow (only create if has children)
    if (this.__hasChildren) {
      const collapseArrow = document.createElement('button');
      collapseArrow.className = 'bullet-collapse-arrow';
      collapseArrow.setAttribute('aria-label', this.__collapsed ? 'Expand' : 'Collapse');
      collapseArrow.innerHTML = this.__collapsed
        ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>';
      bullet.appendChild(collapseArrow);
    }

    // Bullet container
    const bulletContainer = document.createElement('span');
    bulletContainer.className = 'bullet-container';
    
    // Outer ring (for collapsed state or hover)
    const outerRing = document.createElement('span');
    outerRing.className = 'bullet-outer-ring';
    bulletContainer.appendChild(outerRing);
    
    // Bullet dot or icon
    if (this.__icon) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'bullet-icon';
      iconSpan.textContent = this.__icon;
      bulletContainer.appendChild(iconSpan);
    } else {
      const dot = document.createElement('span');
      dot.className = 'bullet-dot';
      bulletContainer.appendChild(dot);
    }
    
    bullet.appendChild(bulletContainer);
    blockUI.appendChild(bullet);

    // Property icons container (after_bullet position) — React portal target
    const propIconsAfterBullet = document.createElement('div');
    propIconsAfterBullet.className = 'node-block-prop-icons node-block-prop-icons--after-bullet';
    blockUI.appendChild(propIconsAfterBullet);

    dom.appendChild(blockUI);

    // ── Block content ──────────────────────────────────────────
    // Lexical inserts managed (text) children here.
    // This keeps inline spans flowing as text rather than flex items.
    const content = document.createElement('div');
    content.className = 'node-block-content';
    dom.appendChild(content);

    // ── After-content UI ───────────────────────────────────────
    // Non-editable containers for class pills and trailing property icons.
    const afterContentUI = document.createElement('div');
    afterContentUI.className = 'block-ui block-ui--after-content';
    afterContentUI.contentEditable = 'false';
    setDOMUnmanaged(afterContentUI);
    afterContentUI.addEventListener('mousedown', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button, a, [role="button"], .block-prop-icon-btn')) return;
      e.preventDefault();
    });

    // Class pills container — React portal target for BlockClassPillsPlugin
    const classPills = document.createElement('div');
    classPills.className = 'node-block-class-pills';
    // Hide if no classes
    if (this.__classIds.length === 0) {
      classPills.style.display = 'none';
    }
    afterContentUI.appendChild(classPills);

    // Property icons container (before_content position = after text) — React portal target
    const propIconsBeforeContent = document.createElement('div');
    propIconsBeforeContent.className = 'node-block-prop-icons node-block-prop-icons--before-content';
    afterContentUI.appendChild(propIconsBeforeContent);

    dom.appendChild(afterContentUI);

    // ── Asset preview container ────────────────────────────────
    // Non-editable portal target for AssetBlockPlugin to render
    // image/audio/file previews below the block content.
    if (this.__nodeType === 'asset') {
      const assetPreview = document.createElement('div');
      assetPreview.className = 'node-block-asset-preview';
      assetPreview.contentEditable = 'false';
      setDOMUnmanaged(assetPreview);
      dom.appendChild(assetPreview);
    }

    return dom;
  }

  updateDOM(prevNode: BlockNode, dom: HTMLElement, _config: EditorConfig): boolean {
    // ── Shallow updates only — never return true ──────────────
    // Each check mutates the existing DOM in-place. We never recreate
    // the wrapper, preserving referential equality for child nodes,
    // IntersectionObserver entries, and React portal mount points.

    // Depth (CSS custom property + data attribute)
    if (prevNode.__depth !== this.__depth) {
      dom.dataset.depth = String(this.__depth);
      dom.style.setProperty('--node-block-depth', String(this.__depth));
    }

    // Collapsed
    if (prevNode.__collapsed !== this.__collapsed) {
      dom.classList.toggle('node-block--collapsed', this.__collapsed);
      const bullet = dom.querySelector('.bullet-wrapper');
      if (bullet) bullet.classList.toggle('bullet-collapsed', this.__collapsed);
      const collapseArrow = dom.querySelector('.bullet-collapse-arrow');
      if (collapseArrow) {
        collapseArrow.setAttribute('aria-label', this.__collapsed ? 'Expand' : 'Collapse');
        collapseArrow.innerHTML = this.__collapsed
          ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>'
          : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>';
      }
    }

    // Node type
    if (prevNode.__nodeType !== this.__nodeType) {
      dom.classList.remove(`node-block--${prevNode.__nodeType}`);
      dom.classList.add(`node-block--${this.__nodeType}`);

      // Add/remove asset preview container when type changes
      const existingPreview = dom.querySelector('.node-block-asset-preview');
      if (this.__nodeType === 'asset' && !existingPreview) {
        const assetPreview = document.createElement('div');
        assetPreview.className = 'node-block-asset-preview';
        assetPreview.contentEditable = 'false';
        setDOMUnmanaged(assetPreview);
        dom.appendChild(assetPreview);
      } else if (this.__nodeType !== 'asset' && existingPreview) {
        existingPreview.remove();
      }
    }

    // Has children (bullet + collapse arrow)
    if (prevNode.__hasChildren !== this.__hasChildren) {
      dom.classList.toggle('node-block--has-children', this.__hasChildren);
      
      const bullet = dom.querySelector('.bullet-wrapper');
      if (bullet) {
        bullet.classList.toggle('bullet-has-children', this.__hasChildren);
        const existingArrow = bullet.querySelector('.bullet-collapse-arrow');
        
        if (this.__hasChildren && !existingArrow) {
          const collapseArrow = document.createElement('button');
          collapseArrow.className = 'bullet-collapse-arrow';
          collapseArrow.setAttribute('aria-label', this.__collapsed ? 'Expand' : 'Collapse');
          collapseArrow.innerHTML = this.__collapsed
            ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>';
          bullet.insertBefore(collapseArrow, bullet.firstChild);
        } else if (!this.__hasChildren && existingArrow) {
          existingArrow.remove();
        }
      }
    }

    // Projection root
    if (prevNode.__isProjectionRoot !== this.__isProjectionRoot) {
      dom.classList.toggle('node-block--projection-root', this.__isProjectionRoot);
      const bullet = dom.querySelector('.bullet-wrapper') as HTMLElement | null;
      if (bullet) bullet.draggable = !this.__isProjectionRoot;
    }

    // Color (CSS custom properties only — no reflow)
    if (prevNode.__color !== this.__color) {
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

    // Icon (swap dot/icon inside bullet-container)
    if (prevNode.__icon !== this.__icon) {
      const bulletContainer = dom.querySelector('.bullet-container');
      if (bulletContainer) {
        const oldDot = bulletContainer.querySelector('.bullet-dot');
        const oldIcon = bulletContainer.querySelector('.bullet-icon');
        if (oldDot) oldDot.remove();
        if (oldIcon) oldIcon.remove();
        
        if (this.__icon) {
          const iconSpan = document.createElement('span');
          iconSpan.className = 'bullet-icon';
          iconSpan.textContent = this.__icon;
          bulletContainer.appendChild(iconSpan);
        } else {
          const dot = document.createElement('span');
          dot.className = 'bullet-dot';
          bulletContainer.appendChild(dot);
        }
      }
    }

    // Class IDs — toggle pills container visibility
    if (prevNode.__classIds.join(',') !== this.__classIds.join(',')) {
      const classPills = dom.querySelector('.node-block-class-pills') as HTMLElement | null;
      if (classPills) {
        classPills.style.display = this.__classIds.length === 0 ? 'none' : '';
      }
    }

    // NEVER return true — DOM structure is stable, only attributes/classes change
    return false;
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

  exportJSON(): SerializedBlockNode {
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
      classIds: this.__classIds,
    };
  }

  static importJSON(json: SerializedBlockNode): BlockNode {
    return $createBlockNode(
      json.blockId,
      json.depth,
      json.collapsed,
      json.nodeType,
      json.hasChildren,
      json.icon,
      json.color,
      json.blockName,
      json.isProjectionRoot,
      json.classIds ?? [],
    );
  }

  // ─── Behavior ─────────────────────────────────────────────────

  /** BlockNodes can contain inline content */
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

export function $createBlockNode(
  blockId: string,
  depth: number = 0,
  collapsed: boolean = false,
  nodeType: GraphNodeType = 'block',
  hasChildren: boolean = false,
  icon: string | null = null,
  color: string | null = null,
  blockName: string = '',
  isProjectionRoot: boolean = false,
  classIds: string[] = [],
): BlockNode {
  return $applyNodeReplacement(
    new BlockNode(blockId, depth, collapsed, nodeType, hasChildren, icon, color, blockName, isProjectionRoot, classIds),
  );
}

export function $isBlockNode(
  node: LexicalNode | null | undefined,
): node is BlockNode {
  return node instanceof BlockNode;
}
