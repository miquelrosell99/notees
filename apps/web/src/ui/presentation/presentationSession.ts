/**
 * Presentation resume state (owner decision): the last slide
 * index per object, session-local like the collapse set (the
 * session-only decision) — held in module memory, never persisted, never on
 * the wire. Closing and reopening a deck within the session resumes where
 * the reader left off; `pagehide` ends the session (the map dies with the
 * page), which is exactly the "nothing persisted" contract.
 */

const resumeIndexes = new Map<string, number>();

/** The remembered slide index for an object (0 when none). */
export function resumeIndexOf(nodeId: string): number {
  return resumeIndexes.get(nodeId) ?? 0;
}

/** Remember the slide index for an object (clamped at 0). */
export function rememberResumeIndex(nodeId: string, index: number): void {
  resumeIndexes.set(nodeId, Math.max(0, index));
}

/** Forget an object's resume index (deck finished / explicitly restarted). */
export function clearResumeIndex(nodeId: string): void {
  resumeIndexes.delete(nodeId);
}

/** Test hook + session boundary: drop every remembered index. */
export function clearAllResumeIndexes(): void {
  resumeIndexes.clear();
}
