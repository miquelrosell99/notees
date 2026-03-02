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
 * so it can contain children (TextNode, InlineLinkNode, etc.)
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
import { createIconElement } from '@/utils/iconDom';

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
  isHeading: boolean;
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
  __isHeading: boolean;

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
      node.__isHeading,
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
    isHeading: boolean = false,
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
    this.__isHeading = isHeading;
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

  getIsHeading(): boolean {
    return this.getLatest().__isHeading;
  }

  setIsHeading(isHeading: boolean): this {
    const writable = this.getWritable();
    writable.__isHeading = isHeading;
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
    if (this.__isHeading) {
      dom.classList.add('node-block--heading');
      const level = Math.min(this.__depth + 1, 6);
      dom.classList.add(`node-block--heading-${level}`);
      dom.dataset.headingLevel = String(level);
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
    
    // Collapse arrow (create if has children OR is collapsed — so collapsed
    // blocks always have an expand affordance even before children are loaded)
    if (this.__hasChildren || this.__collapsed) {
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
      bulletContainer.appendChild(createIconElement(this.__icon));
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
      if (target.closest('.bullet-wrapper')) return;
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

    // Query toolbar container — React portal target for QueryBlockPlugin
    // to render filter/view controls inline with class pills
    if (this.__nodeType === 'query') {
      const queryToolbar = document.createElement('div');
      queryToolbar.className = 'node-block-query-toolbar';
      afterContentUI.appendChild(queryToolbar);
    }

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

    // ── Table preview container ────────────────────────────────
    // Non-editable portal target for TableBlockPlugin to render
    // table element with rows and cells.
    if (this.__nodeType === 'table') {
      const tablePreview = document.createElement('div');
      tablePreview.className = 'node-block-table-preview';
      tablePreview.contentEditable = 'false';
      setDOMUnmanaged(tablePreview);
      dom.appendChild(tablePreview);
    }

    // ── Query preview container ────────────────────────────────
    // Non-editable portal target for QueryBlockPlugin to render
    // query results below the block content.
    if (this.__nodeType === 'query') {
      const queryPreview = document.createElement('div');
      queryPreview.className = 'node-block-query-preview';
      queryPreview.contentEditable = 'false';
      setDOMUnmanaged(queryPreview);
      dom.appendChild(queryPreview);
    }
    // ── Code gutter container ──────────────────────────────────
    // Non-editable portal target for BlockCodePlugin to render
    // line numbers beside the code content.
    if (this.__nodeType === 'code') {
      const codeGutter = document.createElement('div');
      codeGutter.className = 'node-block-code-gutter';
      codeGutter.contentEditable = 'false';
      setDOMUnmanaged(codeGutter);
      dom.appendChild(codeGutter);
    }

    // ── Properties preview container ───────────────────────────
    // Non-editable portal target for BlockPropertiesPlugin to render
    // inline property rows below the block content (before child blocks).
    const propertiesPreview = document.createElement('div');
    propertiesPreview.className = 'node-block-properties-preview';
    propertiesPreview.contentEditable = 'false';
    setDOMUnmanaged(propertiesPreview);
    dom.appendChild(propertiesPreview);

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
        // Remove arrow when un-collapsing if there are no children to toggle
        if (!this.__collapsed && !this.__hasChildren) {
          collapseArrow.remove();
        }
      } else if (this.__collapsed && bullet) {
        // Block just became collapsed but arrow doesn't exist yet — create it
        const newArrow = document.createElement('button');
        newArrow.className = 'bullet-collapse-arrow';
        newArrow.setAttribute('aria-label', 'Expand');
        newArrow.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>';
        bullet.insertBefore(newArrow, bullet.firstChild);
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

      // Add/remove table preview container when type changes
      const existingTable = dom.querySelector('.node-block-table-preview');
      if (this.__nodeType === 'table' && !existingTable) {
        const tablePreview = document.createElement('div');
        tablePreview.className = 'node-block-table-preview';
        tablePreview.contentEditable = 'false';
        setDOMUnmanaged(tablePreview);
        dom.appendChild(tablePreview);
      } else if (this.__nodeType !== 'table' && existingTable) {
        existingTable.remove();
      }

      // Add/remove query preview container when type changes
      const existingQuery = dom.querySelector('.node-block-query-preview');
      if (this.__nodeType === 'query' && !existingQuery) {
        const queryPreview = document.createElement('div');
        queryPreview.className = 'node-block-query-preview';
        queryPreview.contentEditable = 'false';
        setDOMUnmanaged(queryPreview);
        dom.appendChild(queryPreview);
      } else if (this.__nodeType !== 'query' && existingQuery) {
        existingQuery.remove();
      }

      // Add/remove query toolbar container in after-content area when type changes
      const afterContent = dom.querySelector('.block-ui--after-content');
      const existingQueryToolbar = afterContent?.querySelector('.node-block-query-toolbar');
      if (this.__nodeType === 'query' && !existingQueryToolbar && afterContent) {
        const propIcons = afterContent.querySelector('.node-block-prop-icons--before-content');
        const queryToolbar = document.createElement('div');
        queryToolbar.className = 'node-block-query-toolbar';
        // Insert before property icons to keep pills → toolbar → prop-icons order
        if (propIcons) {
          afterContent.insertBefore(queryToolbar, propIcons);
        } else {
          afterContent.appendChild(queryToolbar);
        }
      } else if (this.__nodeType !== 'query' && existingQueryToolbar) {
        existingQueryToolbar.remove();
      }

      // Add/remove code gutter container when type changes
      const existingGutter = dom.querySelector('.node-block-code-gutter');
      if (this.__nodeType === 'code' && !existingGutter) {
        const codeGutter = document.createElement('div');
        codeGutter.className = 'node-block-code-gutter';
        codeGutter.contentEditable = 'false';
        setDOMUnmanaged(codeGutter);
        dom.appendChild(codeGutter);
      } else if (this.__nodeType !== 'code' && existingGutter) {
        existingGutter.remove();
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
        } else if (!this.__hasChildren && existingArrow && !this.__collapsed) {
          // Only remove the arrow if there are no children AND the block is not collapsed.
          // Keep it when collapsed so the user can always expand a collapsed block.
          existingArrow.remove();
        }
      }
    }

    // Projection root
    if (prevNode.__isProjectionRoot !== this.__isProjectionRoot) {
      dom.classList.toggle('node-block--projection-root', this.__isProjectionRoot);
    }

    // Heading — update CSS classes and data attribute when heading state or depth changes
    if (prevNode.__isHeading !== this.__isHeading || (this.__isHeading && prevNode.__depth !== this.__depth)) {
      dom.classList.toggle('node-block--heading', this.__isHeading);
      // Remove old level class
      for (let i = 1; i <= 6; i++) {
        dom.classList.remove(`node-block--heading-${i}`);
      }
      if (this.__isHeading) {
        const level = Math.min(this.__depth + 1, 6);
        dom.classList.add(`node-block--heading-${level}`);
        dom.dataset.headingLevel = String(level);
      } else {
        delete dom.dataset.headingLevel;
      }
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
          bulletContainer.appendChild(createIconElement(this.__icon));
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
      isHeading: this.__isHeading,
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
      json.isHeading ?? false,
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
  isHeading: boolean = false,
): BlockNode {
  return $applyNodeReplacement(
    new BlockNode(blockId, depth, collapsed, nodeType, hasChildren, icon, color, blockName, isProjectionRoot, classIds, isHeading),
  );
}

export function $isBlockNode(
  node: LexicalNode | null | undefined,
): node is BlockNode {
  return node instanceof BlockNode;
}
