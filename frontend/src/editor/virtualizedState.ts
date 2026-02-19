/**
 * Shared virtualization state — module-level pub/sub.
 *
 * VirtualizationPlugin writes visibility changes here.
 * BlockPlugin reads visible IDs and subscribes to populate/depopulate
 * block content based on viewport intersection.
 *
 * This avoids React context threading between sibling components
 * and provides synchronous access during Lexical editor.update() calls.
 *
 * ── Debounce strategy ─────────────────────────────────────────
 * IntersectionObserver may fire many entries in rapid succession
 * during fast scrolling.  Rather than emitting a listener callback
 * per IO batch, we accumulate pending visible/hidden IDs and flush
 * them once after a configurable delay (default 50 ms).  This
 * ensures BlockPlugin performs a single editor.update() per scroll
 * frame instead of one per IO entry.
 */

type VisibilityChangeCallback = (
  newlyVisible: string[],
  newlyHidden: string[],
) => void;

let _visibleBlockIds: ReadonlySet<string> = new Set<string>();
let _enabled = false;
const _populatedBlockIds = new Set<string>();
const _listeners = new Set<VisibilityChangeCallback>();

// ── Debounce state ────────────────────────────────────────────
const DEBOUNCE_MS = 30;
let _pendingVisible = new Set<string>();
let _pendingHidden  = new Set<string>();
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Visible block IDs (written by VirtualizationPlugin) ─────────

export function getVisibleBlockIds(): ReadonlySet<string> {
  return _visibleBlockIds;
}

export function isVirtualizationEnabled(): boolean {
  return _enabled;
}

export function setVirtualizationEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/**
 * Flush accumulated pending visible/hidden IDs to listeners.
 * Called after the debounce timer expires.
 */
function flushPending(): void {
  _flushTimer = null;

  if (_pendingVisible.size === 0 && _pendingHidden.size === 0) return;

  const vis = Array.from(_pendingVisible);
  const hid = Array.from(_pendingHidden);
  _pendingVisible = new Set();
  _pendingHidden  = new Set();

  for (const listener of _listeners) {
    listener(vis, hid);
  }
}

/**
 * Update the set of visible block IDs.
 *
 * Changes are accumulated into a pending buffer and flushed to
 * listeners after DEBOUNCE_MS.  If called again before the timer fires,
 * new changes merge into the pending buffer — a block that becomes
 * visible then hidden (or vice-versa) within the window cancels out.
 *
 * Called by VirtualizationPlugin when IntersectionObserver fires.
 */
export function updateVisibleBlockIds(newIds: Set<string>): void {
  const prevIds = _visibleBlockIds;

  for (const id of newIds) {
    if (!prevIds.has(id)) {
      // Newly visible — if it was pending-hidden, cancel out
      if (_pendingHidden.has(id)) {
        _pendingHidden.delete(id);
      } else {
        _pendingVisible.add(id);
      }
    }
  }
  for (const id of prevIds) {
    if (!newIds.has(id)) {
      // Newly hidden — if it was pending-visible, cancel out
      if (_pendingVisible.has(id)) {
        _pendingVisible.delete(id);
      } else {
        _pendingHidden.add(id);
      }
    }
  }

  _visibleBlockIds = newIds;

  // ── Orphan recovery ─────────────────────────────────────────
  // After cancel-out, any block that is visible but not yet populated
  // and not already queued must be force-added to _pendingVisible.
  // This catches blocks stranded by rapid visible→hidden→visible
  // oscillations within the debounce window, or any state-machine
  // edge case where a block was depopulated but never re-queued.
  for (const id of newIds) {
    if (!_populatedBlockIds.has(id) && !_pendingVisible.has(id)) {
      _pendingVisible.add(id);
    }
  }

  // Schedule flush (or let existing timer handle it)
  if (_flushTimer === null && (_pendingVisible.size > 0 || _pendingHidden.size > 0)) {
    _flushTimer = setTimeout(flushPending, DEBOUNCE_MS);
  }
}

/**
 * Force-flush any pending visibility changes immediately.
 * Useful when the editor needs to guarantee content is populated
 * (e.g. before focusing a block).
 */
export function flushVisibilityChanges(): void {
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  flushPending();
}

export function subscribeToVisibilityChange(
  callback: VisibilityChangeCallback,
): () => void {
  _listeners.add(callback);
  return () => { _listeners.delete(callback); };
}

// ─── Content population tracking ─────────────────────────────────

export function isBlockPopulated(blockId: string): boolean {
  return _populatedBlockIds.has(blockId);
}

export function markPopulated(blockId: string): void {
  _populatedBlockIds.add(blockId);
}

export function markDepopulated(blockId: string): void {
  _populatedBlockIds.delete(blockId);
}

export function clearPopulatedState(): void {
  _populatedBlockIds.clear();
}

/**
 * Remove tracking for blocks that no longer exist in the Lexical tree.
 * Prevents stale entries from accumulating across page navigations.
 */
export function prunePopulatedState(activeBlockIds: Set<string>): void {
  for (const id of _populatedBlockIds) {
    if (!activeBlockIds.has(id)) {
      _populatedBlockIds.delete(id);
    }
  }
}

/**
 * Reset all shared state. Called when the editor unmounts or changes root.
 */
export function resetVirtualizedState(): void {
  // Cancel any pending flush
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _pendingVisible.clear();
  _pendingHidden.clear();
  _visibleBlockIds = new Set<string>();
  _enabled = false;
  _populatedBlockIds.clear();
  _listeners.clear();
}
