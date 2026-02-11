/**
 * NodeBlockTableCellNode — Lexical node for individual table cells.
 *
 * Each cell is a mini-editor that can contain inline content.
 * The table view uses one Lexical instance per editable cell.
 */

import {
  type LexicalNode,
  type NodeKey,
  type EditorConfig,
  $applyNodeReplacement,
} from 'lexical';
import { NodeBlockNode, type SerializedNodeBlockNode } from './NodeBlockNode';

export class NodeBlockTableCellNode extends NodeBlockNode {
  __rowIndex: number;
  __colIndex: number;
  __isHeader: boolean;

  static getType(): string {
    return 'node-block-table-cell';
  }

  static clone(node: NodeBlockTableCellNode): NodeBlockTableCellNode {
    return new NodeBlockTableCellNode(
      node.__blockId,
      node.__rowIndex,
      node.__colIndex,
      node.__isHeader,
      node.__key,
    );
  }

  constructor(
    blockId: string,
    rowIndex: number = 0,
    colIndex: number = 0,
    isHeader: boolean = false,
    key?: NodeKey,
  ) {
    super(blockId, 0, false, 'block', false, null, null, '', key);
    this.__rowIndex = rowIndex;
    this.__colIndex = colIndex;
    this.__isHeader = isHeader;
  }

  getRowIndex(): number {
    return this.__rowIndex;
  }

  getColIndex(): number {
    return this.__colIndex;
  }

  getIsHeader(): boolean {
    return this.__isHeader;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const tag = this.__isHeader ? 'th' : 'td';
    const dom = document.createElement(tag);
    dom.classList.add('node-block-table-cell');
    dom.dataset.blockId = this.__blockId;
    dom.dataset.row = String(this.__rowIndex);
    dom.dataset.col = String(this.__colIndex);
    return dom;
  }

  updateDOM(prevNode: NodeBlockNode, _dom: HTMLElement, _config: EditorConfig): boolean {
    if (!(prevNode instanceof NodeBlockTableCellNode)) return true;
    return (prevNode as NodeBlockTableCellNode).__isHeader !== this.__isHeader; // Recreate on th↔td change
  }

  exportJSON(): SerializedNodeBlockNode & { type: 'node-block-table-cell'; rowIndex: number; colIndex: number; isHeader: boolean } {
    return {
      ...super.exportJSON(),
      type: 'node-block-table-cell' as unknown as 'node-block',
      rowIndex: this.__rowIndex,
      colIndex: this.__colIndex,
      isHeader: this.__isHeader,
    } as SerializedNodeBlockNode & { type: 'node-block-table-cell'; rowIndex: number; colIndex: number; isHeader: boolean };
  }

  static importJSON(json: SerializedNodeBlockNode & { rowIndex?: number; colIndex?: number; isHeader?: boolean }): NodeBlockTableCellNode {
    return $createNodeBlockTableCellNode(
      json.blockId,
      json.rowIndex ?? 0,
      json.colIndex ?? 0,
      json.isHeader ?? false,
    );
  }
}

export function $createNodeBlockTableCellNode(
  blockId: string,
  rowIndex: number,
  colIndex: number,
  isHeader: boolean = false,
): NodeBlockTableCellNode {
  return $applyNodeReplacement(
    new NodeBlockTableCellNode(blockId, rowIndex, colIndex, isHeader),
  );
}

export function $isNodeBlockTableCellNode(
  node: LexicalNode | null | undefined,
): node is NodeBlockTableCellNode {
  return node instanceof NodeBlockTableCellNode;
}
