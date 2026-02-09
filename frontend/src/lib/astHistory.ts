/**
 * AST-level undo/redo history.
 *
 * Stores snapshots of {ast, cursorOffset} on a stack.
 * The editor pushes a snapshot before each meaningful mutation
 * (typing a word, formatting, link insertion, paste).
 *
 * This is intentionally simple — snapshot-based, not OT/CRDT.
 */

import type { ASTDocument } from '@/types/ast';

export interface HistoryEntry {
  readonly ast: ASTDocument;
  readonly cursorOffset: number;
}

const MAX_HISTORY = 200;

export class ASTHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private lastPushTime = 0;

  /**
   * Push a snapshot onto the undo stack.
   * Clears the redo stack (new edit branch).
   *
   * The `debounceMs` parameter controls how close pushes can be.
   * If called within debounceMs of the last push, the previous
   * entry is replaced instead of adding a new one (for typing).
   */
  push(entry: HistoryEntry, debounceMs = 0): void {
    const now = Date.now();
    if (debounceMs > 0 && this.undoStack.length > 0 && now - this.lastPushTime < debounceMs) {
      // Replace the last entry (debounce rapid typing)
      this.undoStack[this.undoStack.length - 1] = entry;
    } else {
      this.undoStack.push(entry);
      if (this.undoStack.length > MAX_HISTORY) {
        this.undoStack.shift();
      }
    }
    this.redoStack = [];
    this.lastPushTime = now;
  }

  /**
   * Undo: pop from undo stack, push current state to redo stack.
   * Returns the state to restore, or null if nothing to undo.
   */
  undo(current: HistoryEntry): HistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(current);
    return entry;
  }

  /**
   * Redo: pop from redo stack, push current state to undo stack.
   * Returns the state to restore, or null if nothing to redo.
   */
  redo(current: HistoryEntry): HistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(current);
    return entry;
  }

  /** Whether undo is available. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether redo is available. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Clear all history. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
