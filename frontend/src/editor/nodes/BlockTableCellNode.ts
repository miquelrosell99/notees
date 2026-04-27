/**
 * BlockTableCellNode — Lexical node for individual table cells.
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
import { BlockNode, type SerializedBlockNode } from './BlockNode';

export class BlockTableCellNode extends BlockNode {
  __rowIndex: number;
  __colIndex: number;
  __isHeader: boolean;

  static getType(): string {
    return 'node-block-table-cell';
  }

  static clone(node: BlockTableCellNode): BlockTableCellNode {
    return new BlockTableCellNode(
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
    super(blockId, 0, false, 'block', false, null, null, '', false, [], false, key);
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

  updateDOM(prevNode: BlockNode, _dom: HTMLElement, _config: EditorConfig): boolean {
    if (!(prevNode instanceof BlockTableCellNode)) return true;
    return (prevNode as BlockTableCellNode).__isHeader !== this.__isHeader; // Recreate on th↔td change
  }

  exportJSON(): SerializedBlockNode & { type: 'node-block-table-cell'; rowIndex: number; colIndex: number; isHeader: boolean } {
    return {
      ...super.exportJSON(),
      type: 'node-block-table-cell' as unknown as 'node-block',
      rowIndex: this.__rowIndex,
      colIndex: this.__colIndex,
      isHeader: this.__isHeader,
    } as SerializedBlockNode & { type: 'node-block-table-cell'; rowIndex: number; colIndex: number; isHeader: boolean };
  }

  static importJSON(json: SerializedBlockNode & { rowIndex?: number; colIndex?: number; isHeader?: boolean }): BlockTableCellNode {
    return $createBlockTableCellNode(
      json.blockId,
      json.rowIndex ?? 0,
      json.colIndex ?? 0,
      json.isHeader ?? false,
    );
  }
}

export function $createBlockTableCellNode(
  blockId: string,
  rowIndex: number,
  colIndex: number,
  isHeader: boolean = false,
): BlockTableCellNode {
  return $applyNodeReplacement(
    new BlockTableCellNode(blockId, rowIndex, colIndex, isHeader),
  );
}

export function $isBlockTableCellNode(
  node: LexicalNode | null | undefined,
): node is BlockTableCellNode {
  return node instanceof BlockTableCellNode;
}
