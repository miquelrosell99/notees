/**
 * inlineEditorModel — pure functions for mutating the custom inline editor's
 * AST and selection.
 *
 * The model works with a flat "unit" representation derived from ContentAST:
 *   - text units carry a stack of active marks
 *   - atomic units represent pills, math, date ranges, hard breaks, etc.
 *
 * All mutation functions return a new InlineEditorState.
 */

import type { ASTDocument as ContentAST } from '@/types/ast';
import type { ASTInlineNode } from '@/types/ast';
import {
  type InlineEditorState,
  type InlineSelection,
  type InlineUnit,
  type TextUnit,
  type Position,
  type MarkType,
  MARK_ORDER,
} from './types';

// ─── AST <-> units ────────────────────────────────────────────────

const MARK_NODE_TYPES = new Set<ASTInlineNode['type']>([
  'strong',
  'em',
  'strikethrough',
  'underline',
  'highlight',
]);

const ATOMIC_TYPES = new Set<ASTInlineNode['type']>([
  'hard_break',
  'math',
  'node_link',
  'broken_link',
  'date_range',
  'external_link',
]);

function isMarkNode(node: ASTInlineNode): node is Extract<ASTInlineNode, { children: ASTInlineNode[] }> {
  return MARK_NODE_TYPES.has(node.type);
}

function isAtomicNode(node: ASTInlineNode): boolean {
  return ATOMIC_TYPES.has(node.type);
}

export function astToUnits(nodes: ASTInlineNode[]): InlineUnit[] {
  const units: InlineUnit[] = [];

  function walk(children: ASTInlineNode[], marks: MarkType[]) {
    for (const child of children) {
      if (child.type === 'text') {
        units.push({ type: 'text', text: child.text, marks });
      } else if (child.type === 'code') {
        units.push({ type: 'text', text: child.text, marks: [...marks, 'code'] });
      } else if (isAtomicNode(child)) {
        units.push({ type: 'atomic', node: child });
      } else if (isMarkNode(child)) {
        walk(child.children, [...marks, child.type as Exclude<MarkType, 'code'>]);
      }
    }
  }

  walk(nodes, []);
  return units;
}

function sortMarks(marks: MarkType[]): MarkType[] {
  return [...marks].sort((a, b) => {
    const ai = MARK_ORDER.indexOf(a);
    const bi = MARK_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

export function unitsToAst(units: InlineUnit[]): ASTInlineNode[] {
  const nodes: ASTInlineNode[] = [];
  let pendingText = '';
  let pendingMarks: MarkType[] = [];

  function flushText() {
    if (pendingText === '' && pendingMarks.length === 0) return;

    if (pendingMarks.includes('code')) {
      nodes.push({ type: 'code', text: pendingText });
    } else {
      let node: ASTInlineNode = { type: 'text', text: pendingText };
      for (let i = pendingMarks.length - 1; i >= 0; i--) {
        const markType = pendingMarks[i] as Exclude<MarkType, 'code'>;
        node = { type: markType, children: [node] };
      }
      nodes.push(node);
    }

    pendingText = '';
    pendingMarks = [];
  }

  for (const unit of units) {
    if (unit.type === 'atomic') {
      flushText();
      nodes.push(unit.node);
    } else {
      const sorted = sortMarks(unit.marks);
      if (JSON.stringify(sorted) !== JSON.stringify(pendingMarks)) {
        flushText();
        pendingMarks = sorted;
      }
      pendingText += unit.text;
    }
  }

  flushText();
  return nodes;
}

// ─── Offset helpers ───────────────────────────────────────────────

export function getUnitLogicalSize(unit: InlineUnit): number {
  return unit.type === 'text' ? unit.text.length : 1;
}

export function getLogicalLength(units: InlineUnit[]): number {
  return units.reduce((sum, unit) => sum + getUnitLogicalSize(unit), 0);
}

export function offsetToPosition(units: InlineUnit[], offset: number): Position {
  let current = 0;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const size = getUnitLogicalSize(unit);

    if (offset < current + size) {
      if (unit.type === 'atomic') {
        return { unitIndex: i, innerOffset: 0 };
      }
      return { unitIndex: i, innerOffset: offset - current };
    }

    current += size;
  }

  return { unitIndex: units.length, innerOffset: 0 };
}

export function positionToOffset(units: InlineUnit[], position: Position): number {
  let offset = 0;

  for (let i = 0; i < position.unitIndex && i < units.length; i++) {
    offset += getUnitLogicalSize(units[i]);
  }

  const unit = units[position.unitIndex];
  if (unit && unit.type === 'text') {
    offset += Math.max(0, Math.min(position.innerOffset, unit.text.length));
  }

  return offset;
}

export function getSelectionOffsets(selection: InlineSelection): { start: number; end: number } {
  switch (selection.type) {
    case 'collapsed':
      return { start: selection.offset, end: selection.offset };
    case 'range':
      return {
        start: Math.min(selection.anchor, selection.focus),
        end: Math.max(selection.anchor, selection.focus),
      };
    case 'node':
      return { start: selection.nodeIndex, end: selection.nodeIndex + 1 };
  }
}

// ─── State construction ───────────────────────────────────────────

export function createState(ast: ContentAST, selection?: InlineSelection): InlineEditorState {
  const inlineChildren = getInlineChildren(ast);
  const length = getLogicalLength(astToUnits(inlineChildren));
  const safeOffset = Math.max(0, Math.min(selection?.type === 'collapsed' ? selection.offset : 0, length));

  return {
    ast,
    selection: selection ?? { type: 'collapsed', offset: safeOffset },
  };
}

export function getInlineChildren(ast: ContentAST): ASTInlineNode[] {
  const first = ast[0];
  if (!first) return [];
  if (first.type === 'paragraph' || first.type === 'heading') {
    return first.children ?? [];
  }
  return [];
}

export function setInlineChildren(ast: ContentAST, children: ASTInlineNode[]): ContentAST {
  const first = ast[0];
  if (!first) {
    return [{ type: 'paragraph', children }];
  }
  if (first.type === 'paragraph' || first.type === 'heading') {
    return [{ ...first, children }];
  }
  // Non-editable first block (whiteboard/query): keep as-is and prepend a paragraph
  return [{ type: 'paragraph', children }, first];
}

export function unitsFromState(state: InlineEditorState): InlineUnit[] {
  return astToUnits(getInlineChildren(state.ast));
}

function stateWithUnits(
  state: InlineEditorState,
  units: InlineUnit[],
  selection: InlineSelection,
): InlineEditorState {
  const children = unitsToAst(units);
  const ast = setInlineChildren(state.ast, children);
  return { ast, selection };
}

function normalizeUnits(units: InlineUnit[]): InlineUnit[] {
  const out: InlineUnit[] = [];

  for (const unit of units) {
    if (unit.type === 'atomic') {
      out.push(unit);
      continue;
    }

    if (unit.text === '') continue;

    const last = out[out.length - 1];
    if (last && last.type === 'text' && JSON.stringify(sortMarks(last.marks)) === JSON.stringify(sortMarks(unit.marks))) {
      out[out.length - 1] = { type: 'text', text: last.text + unit.text, marks: sortMarks(last.marks) };
    } else {
      out.push({ type: 'text', text: unit.text, marks: sortMarks(unit.marks) });
    }
  }

  if (out.length === 0) {
    out.push({ type: 'text', text: '', marks: [] });
  }

  return out;
}

// ─── Mutations ────────────────────────────────────────────────────

export function insertText(state: InlineEditorState, text: string): InlineEditorState {
  const { start, end } = getSelectionOffsets(state.selection);
  const units = deleteRangeRaw(unitsFromState(state), start, end);
  const pos = offsetToPosition(units, start);
  const newUnits: InlineUnit[] = [...units];

  if (pos.unitIndex === units.length) {
    const last = units[units.length - 1];
    if (last && last.type === 'text') {
      newUnits[newUnits.length - 1] = { ...last, text: last.text + text };
    } else {
      newUnits.push({ type: 'text', text, marks: [] });
    }
  } else if (units[pos.unitIndex].type === 'text') {
    const unit = units[pos.unitIndex] as TextUnit;
    const newText = unit.text.slice(0, pos.innerOffset) + text + unit.text.slice(pos.innerOffset);
    newUnits[pos.unitIndex] = { ...unit, text: newText };
  } else {
    newUnits.splice(pos.unitIndex, 0, { type: 'text', text, marks: [] });
  }

  const normalized = normalizeUnits(newUnits);
  return stateWithUnits(state, normalized, { type: 'collapsed', offset: start + text.length });
}

function deleteRangeRaw(units: InlineUnit[], start: number, end: number): InlineUnit[] {
  if (start >= end) return units;

  const startPos = offsetToPosition(units, start);
  const endPos = offsetToPosition(units, end);

  const newUnits: InlineUnit[] = [];

  for (let i = 0; i < startPos.unitIndex; i++) {
    newUnits.push(units[i]);
  }

  const startUnit = units[startPos.unitIndex];
  const endUnit = units[endPos.unitIndex];

  // If the range is fully inside a single text unit, keep the surviving text.
  if (startUnit && endUnit && startUnit.type === 'text' && endUnit.type === 'text' && startPos.unitIndex === endPos.unitIndex) {
    const kept = startUnit.text.slice(0, startPos.innerOffset) + startUnit.text.slice(endPos.innerOffset);
    if (kept) {
      newUnits.push({ type: 'text', text: kept, marks: startUnit.marks });
    }
  } else {
    if (startUnit) {
      if (startUnit.type === 'text') {
        const kept = startUnit.text.slice(0, startPos.innerOffset);
        if (kept) {
          newUnits.push({ type: 'text', text: kept, marks: startUnit.marks });
        }
      } else if (startPos.innerOffset === 0) {
        // Cursor is before the atomic node; keep it.
        newUnits.push(startUnit);
      }
    }

    if (endUnit && endPos.unitIndex > startPos.unitIndex) {
      if (endUnit.type === 'text') {
        const kept = endUnit.text.slice(endPos.innerOffset);
        if (kept) {
          newUnits.push({ type: 'text', text: kept, marks: endUnit.marks });
        }
      } else if (endPos.innerOffset === 1) {
        // Cursor is after the atomic node; keep it.
        newUnits.push(endUnit);
      }
    }
  }

  for (let i = endPos.unitIndex + 1; i < units.length; i++) {
    newUnits.push(units[i]);
  }

  return normalizeUnits(newUnits);
}

export function deleteRange(state: InlineEditorState, start: number, end: number): InlineEditorState {
  const units = deleteRangeRaw(unitsFromState(state), start, end);
  return stateWithUnits(state, units, { type: 'collapsed', offset: start });
}

export function deleteBackward(state: InlineEditorState): InlineEditorState {
  const { start, end } = getSelectionOffsets(state.selection);
  if (start !== end) {
    return deleteRange(state, start, end);
  }
  if (start === 0) return state;
  return deleteRange(state, start - 1, start);
}

export function deleteForward(state: InlineEditorState): InlineEditorState {
  const { start, end } = getSelectionOffsets(state.selection);
  if (start !== end) {
    return deleteRange(state, start, end);
  }
  const length = getLogicalLength(unitsFromState(state));
  if (start >= length) return state;
  return deleteRange(state, start, start + 1);
}

export function insertAtomicNode(
  state: InlineEditorState,
  node: ASTInlineNode,
): InlineEditorState {
  const { start, end } = getSelectionOffsets(state.selection);
  const units = deleteRangeRaw(unitsFromState(state), start, end);
  const pos = offsetToPosition(units, start);
  const newUnits: InlineUnit[] = [...units];

  if (pos.unitIndex === units.length) {
    newUnits.push({ type: 'atomic', node });
  } else if (units[pos.unitIndex].type === 'text') {
    const unit = units[pos.unitIndex] as TextUnit;
    const before = unit.text.slice(0, pos.innerOffset);
    const after = unit.text.slice(pos.innerOffset);
    newUnits.splice(
      pos.unitIndex,
      1,
      { type: 'text', text: before, marks: unit.marks },
      { type: 'atomic', node },
      { type: 'text', text: after, marks: unit.marks },
    );
  } else {
    newUnits.splice(pos.unitIndex, 0, { type: 'atomic', node });
  }

  return stateWithUnits(state, normalizeUnits(newUnits), { type: 'collapsed', offset: start + 1 });
}

export function insertHardBreak(state: InlineEditorState): InlineEditorState {
  return insertAtomicNode(state, { type: 'hard_break' });
}

export function toggleMark(state: InlineEditorState, mark: MarkType): InlineEditorState {
  const { start, end } = getSelectionOffsets(state.selection);
  if (start === end) return state;

  const units = unitsFromState(state);
  const newUnits: InlineUnit[] = [];
  let current = 0;

  for (const unit of units) {
    const size = getUnitLogicalSize(unit);
    const unitStart = current;
    const unitEnd = current + size;

    if (unit.type === 'atomic') {
      newUnits.push(unit);
      current += size;
      continue;
    }

    const overlapStart = Math.max(start, unitStart);
    const overlapEnd = Math.min(end, unitEnd);

    if (overlapStart >= overlapEnd) {
      // No overlap
      newUnits.push(unit);
      current += size;
      continue;
    }

    // Split the text unit into up to three parts: before, overlapping, after.
    const beforeLen = overlapStart - unitStart;
    const overlapLen = overlapEnd - overlapStart;

    const beforeText = unit.text.slice(0, beforeLen);
    const overlapText = unit.text.slice(beforeLen, beforeLen + overlapLen);
    const afterText = unit.text.slice(beforeLen + overlapLen);

    if (beforeText) {
      newUnits.push({ type: 'text', text: beforeText, marks: unit.marks });
    }

    const hasMark = unit.marks.includes(mark);
    const newMarks = hasMark ? unit.marks.filter((m) => m !== mark) : [...unit.marks, mark];
    newUnits.push({ type: 'text', text: overlapText, marks: newMarks });

    if (afterText) {
      newUnits.push({ type: 'text', text: afterText, marks: unit.marks });
    }

    current += size;
  }

  return stateWithUnits(state, normalizeUnits(newUnits), state.selection);
}

export function splitAtCursor(state: InlineEditorState): { before: ContentAST; after: ContentAST } {
  const { start } = getSelectionOffsets(state.selection);
  const units = unitsFromState(state);
  const pos = offsetToPosition(units, start);

  const beforeUnits: InlineUnit[] = [];
  const afterUnits: InlineUnit[] = [];

  for (let i = 0; i < pos.unitIndex; i++) {
    beforeUnits.push(units[i]);
  }

  const unit = units[pos.unitIndex];
  if (unit && unit.type === 'text') {
    const beforeText = unit.text.slice(0, pos.innerOffset);
    const afterText = unit.text.slice(pos.innerOffset);
    if (beforeText) {
      beforeUnits.push({ type: 'text', text: beforeText, marks: unit.marks });
    }
    if (afterText) {
      afterUnits.push({ type: 'text', text: afterText, marks: unit.marks });
    }
  } else if (unit && unit.type === 'atomic') {
    if (pos.innerOffset === 0) {
      afterUnits.push(unit);
    } else {
      beforeUnits.push(unit);
    }
  }

  for (let i = pos.unitIndex + 1; i < units.length; i++) {
    afterUnits.push(units[i]);
  }

  const beforeAst = setInlineChildren(state.ast, unitsToAst(normalizeUnits(beforeUnits)));
  const afterAst = setInlineChildren(state.ast, unitsToAst(normalizeUnits(afterUnits)));

  return { before: beforeAst, after: afterAst };
}

export function setSelection(
  state: InlineEditorState,
  selection: InlineSelection,
): InlineEditorState {
  return { ...state, selection };
}

export function moveCursor(state: InlineEditorState, delta: number): InlineEditorState {
  const length = getLogicalLength(unitsFromState(state));
  let offset = 0;

  if (state.selection.type === 'collapsed') {
    offset = state.selection.offset;
  } else if (state.selection.type === 'range') {
    offset = delta > 0 ? Math.max(state.selection.anchor, state.selection.focus) : Math.min(state.selection.anchor, state.selection.focus);
  } else {
    offset = state.selection.nodeIndex;
  }

  offset = Math.max(0, Math.min(offset + delta, length));
  return setSelection(state, { type: 'collapsed', offset });
}

export function extendSelection(state: InlineEditorState, delta: number): InlineEditorState {
  if (state.selection.type === 'collapsed') {
    const focus = Math.max(0, Math.min(state.selection.offset + delta, getLogicalLength(unitsFromState(state))));
    return setSelection(state, { type: 'range', anchor: state.selection.offset, focus });
  }

  if (state.selection.type === 'range') {
    const focus = Math.max(0, Math.min(state.selection.focus + delta, getLogicalLength(unitsFromState(state))));
    return setSelection(state, { type: 'range', anchor: state.selection.anchor, focus });
  }

  return state;
}

export function setCollapsedOffset(state: InlineEditorState, offset: number): InlineEditorState {
  const length = getLogicalLength(unitsFromState(state));
  return setSelection(state, { type: 'collapsed', offset: Math.max(0, Math.min(offset, length)) });
}

// ─── Link-specific helpers (used by the inline link context menu) ────────

function getLinkId(node: ASTInlineNode): string | null {
  if (node.type === 'node_link' || node.type === 'broken_link') return node.link_id;
  if (node.type === 'external_link') return node.url;
  return null;
}

function findLinkUnitIndex(units: InlineUnit[], linkId: string): number {
  return units.findIndex(
    (unit) => unit.type === 'atomic' && getLinkId(unit.node) === linkId,
  );
}

function linkOffset(units: InlineUnit[], unitIndex: number): number {
  let offset = 0;
  for (let i = 0; i < unitIndex && i < units.length; i++) {
    offset += getUnitLogicalSize(units[i]);
  }
  return offset;
}

/** Remove the link (or URL pill) identified by linkId from the inline stream. */
export function removeLinkById(
  state: InlineEditorState,
  linkId: string,
): InlineEditorState {
  const units = unitsFromState(state);
  const index = findLinkUnitIndex(units, linkId);
  if (index === -1) return state;

  const offset = linkOffset(units, index);
  return deleteRange(state, offset, offset + 1);
}

/**
 * Replace the link identified by linkId with plain text (its visible label).
 * Adjacent text units are merged by normalization; the caret lands after the
 * inserted text.
 */
export function unlinkLinkById(
  state: InlineEditorState,
  linkId: string,
  text: string,
): InlineEditorState {
  const units = unitsFromState(state);
  const index = findLinkUnitIndex(units, linkId);
  if (index === -1) return state;

  const offset = linkOffset(units, index);
  const newUnits: InlineUnit[] = [
    ...units.slice(0, index),
    { type: 'text', text, marks: [] },
    ...units.slice(index + 1),
  ];

  return stateWithUnits(
    state,
    normalizeUnits(newUnits),
    { type: 'collapsed', offset: offset + text.length },
  );
}

/** Replace the link identified by linkId with a new inline node. */
export function replaceLinkById(
  state: InlineEditorState,
  linkId: string,
  newNode: ASTInlineNode,
): InlineEditorState {
  const units = unitsFromState(state);
  const index = findLinkUnitIndex(units, linkId);
  if (index === -1) return state;

  const offset = linkOffset(units, index);
  const afterDelete = deleteRangeRaw(units, offset, offset + 1);
  const pos = offsetToPosition(afterDelete, offset);
  const newUnits: InlineUnit[] = [...afterDelete];

  if (pos.unitIndex === newUnits.length) {
    newUnits.push({ type: 'atomic', node: newNode });
  } else if (newUnits[pos.unitIndex].type === 'text') {
    const unit = newUnits[pos.unitIndex] as TextUnit;
    const before = unit.text.slice(0, pos.innerOffset);
    const after = unit.text.slice(pos.innerOffset);
    newUnits.splice(
      pos.unitIndex,
      1,
      { type: 'text', text: before, marks: unit.marks },
      { type: 'atomic', node: newNode },
      { type: 'text', text: after, marks: unit.marks },
    );
  } else {
    newUnits.splice(pos.unitIndex, 0, { type: 'atomic', node: newNode });
  }

  return stateWithUnits(
    state,
    normalizeUnits(newUnits),
    { type: 'collapsed', offset: offset + 1 },
  );
}

/** Toggle a node_link between 'node' and 'class' ref_type. */
export function toggleLinkClassById(
  state: InlineEditorState,
  linkId: string,
): InlineEditorState {
  const units = unitsFromState(state);
  const index = findLinkUnitIndex(units, linkId);
  if (index === -1) return state;

  const unit = units[index];
  if (unit.type !== 'atomic' || unit.node.type !== 'node_link') return state;

  const newNode: ASTInlineNode = {
    ...unit.node,
    ref_type: unit.node.ref_type === 'class' ? 'node' : 'class',
  };

  const newUnits: InlineUnit[] = [
    ...units.slice(0, index),
    { type: 'atomic', node: newNode },
    ...units.slice(index + 1),
  ];

  return stateWithUnits(state, newUnits, state.selection);
}
