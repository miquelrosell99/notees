## **Phase 0 – Critical / P0 Actions (Production Safety & Data Integrity)**

**Backend Changes**

* Refactor `NodeService.create_node()` and `update_node()` to wrap link/type updates in **single transaction**.
* Add **circular reference check** in `NodeService.move_node()` before updating `parent_id`.
* Refactor `NodeService.delete_node()`:

  * Delete asset folder if `node.is_asset`.
  * Implement atomic deletion order: Node → Asset Folder.
* Implement **soft-delete / trash**:

  * Add `is_deleted` flag and `deleted_at` timestamp in node table.
  * Move deleted nodes to trash view; support recovery.
* Wrap **asset creation** in transaction:

  * Write file to temp → commit node → rename temp to final filename.
  * Rollback file if node creation fails.

**Frontend Changes**

* Implement **undo/redo stack** in `historyStore`:

  * Integrate server-side undo log for consistency with multi-user edits.
* Add **Trash view** to recover deleted nodes/assets.
* Add **unsaved changes indicators** during debounced saves.

**DB Changes**

* Add `trash` table or `is_deleted` flag for nodes.
* Add foreign key constraints / indexes to enforce:

  * Node → Asset Folder → Source File invariants.
* Ensure closure table (`node_path`) stays consistent on soft-delete.

**Background / Maintenance Tasks**

* Automated **database backup** via pg_dump cron.
* Periodic **orphan detection**: nodes with missing parents, broken links, orphan asset folders.

**Tests / Validation**

* Node creation + link update atomicity.
* Node + asset deletion lifecycle.
* Undo/redo correctness with server sync.
* Asset folder invariants (one file per folder).
* Circular reference prevention in hierarchy moves.

---

## **Phase 1 – High / P1 Actions (Service Hardening, UX, Query Performance)**

**Backend Changes**

* Refactor services to use **request-scoped dependency injection**, remove shared `_pool` / `_graph_id`.
* Add **max hierarchy depth check** in move operations.
* Wrap link parsing for updates and bulk operations in transaction.
* Add input validation for all endpoints: node name length, icon string, control characters.

**Frontend Changes**

* Add **conflict detection indicators** for concurrent edits (use `version` field).
* HTML sanitization for pasted content (`DOMPurify`) in editor.
* Undo/redo improvements to handle multi-step operations.

**DB Changes**

* Add cascade delete triggers for critical relationships (links, properties, views).
* Add constraints for max hierarchy depth if feasible.

**Background / Maintenance Tasks**

* Add **query result caching** for expensive dynamic queries.
* Implement **pagination / virtual scrolling** for large node collections (default LIMIT).

**Tests / Validation**

* Concurrent edit conflict detection.
* Max depth enforcement tests.
* HTML content sanitization tests.
* Pagination and caching correctness for large queries.

---

## **Phase 2 – Medium / P2 Actions (Collaboration, CQRS, Orphan Cleanup, Observability)**

**Backend Changes**

* Implement **collaboration support** (CRDT / operational transform) or document-level locking.
* Create **server-side undo log table** for multi-user undo/redo.
* Implement **orphan cleanup background job** for asset folders and broken links.
* Implement **CQRS pattern** for read-heavy queries (materialized views or separate read models).

**Frontend Changes**

* Add **offline queue / PWA support** (optional phase for multi-device consistency).
* Show conflict indicators for edits if server rejects operation.

**DB Changes**

* Add audit tables for undo log and sensitive operations.
* Materialized views / read tables for heavy query views.

**Background / Maintenance Tasks**

* Scheduled jobs:

  * Orphan node detection
  * Asset folder integrity verification
  * Slow query logging (>100ms)
* Optional real-time collaboration job management.

**Tests / Validation**

* Orphan cleanup correctness.
* Undo log consistency for multi-user scenarios.
* CQRS / read model data correctness.
* Offline queue behavior under intermittent connectivity.

---

## **Phase 3 – Low / P3 Actions (Nice-to-Have UX, Versioning, Extensibility)**

**Backend Changes**

* Implement **versioning / diff view** for node content.
* Optional: **block-level change tracking** for audit/blame.
* Introduce **plugin architecture** for extensible block types.
* Add content-addressed deduplication for repeated assets.

**Frontend Changes**

* Version history UI (diff/blame view).
* Plugin registration system for custom block renderers.
* Offline-first enhancements for asset edits.

**DB Changes**

* WAL mode for consistent backups.
* Optional `.created` timestamp in asset folder for orphan detection.

**Background / Maintenance Tasks**

* Deduplication scans for repeated asset content.
* Periodic WAL backup and verification.

**Tests / Validation**

* Versioning/diff correctness.
* Plugin system registration / rendering tests.
* Deduplication correctness.
* Offline-first behavior tests with asset edits.

---

✅ **Monitoring / Invariants (All Phases)**

* System type UUIDs immutable
* Node → page_id consistency
* Closure table consistency
* Asset folder exists for `is_asset=true`
* No circular parent references
* Property values reference existing nodes
