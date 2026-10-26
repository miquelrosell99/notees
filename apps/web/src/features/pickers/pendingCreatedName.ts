/**
 * Display-name fallback for a just-created node the read cache has not
 * materialized yet: the create RPC resolves before the change notification
 * drains, so the worker client's reads answer undefined for the fresh id
 * during the window. The create row knows the title it created
 * (title-is-content — the title IS the content), so a mention pill can
 * render the honest label immediately instead of falling back to the raw
 * id. Entries are shadowed the moment the real node resolves — BlockTextEditor's
 * resolveMentionName clears them lazily then; a never-resolved entry is
 * inert. Module-level: the writer (NodeSelector) and the reader
 * (BlockTextEditor) mount in the same tab, and ids are UUIDv7-unique.
 */

const pending = new Map<string, string>();

export function registerPendingCreatedName(id: string, name: string): void {
  pending.set(id, name);
}

export function pendingCreatedName(id: string): string | null {
  return pending.get(id) ?? null;
}

export function clearPendingCreatedName(id: string): void {
  pending.delete(id);
}
