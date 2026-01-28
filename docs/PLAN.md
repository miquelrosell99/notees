## **Phase 0 – Critical / P0 Actions (Production Safety & Data Integrity)** ✅ **COMPLETED**

**Backend Changes** ✅

* ✅ Refactor `NodeService.create_node()` and `update_node()` to wrap link/type updates in **single transaction** (repository layer uses transactions).
* ✅ Add **circular reference check** in `NodeService.move_node()` before updating `parent_id`.
* ✅ Refactor `NodeService.delete_node()`:
  * ✅ Delete asset folder if `node.is_asset`.
  * ✅ Implement atomic soft-delete with cascading to descendants.
* ✅ Implement **soft-delete / trash**:
  * ✅ Add `is_deleted` flag and `deleted_at` timestamp in node table.
  * ✅ Move deleted nodes to trash view; support recovery via `restore_node()`.
* ✅ Wrap **asset creation** in transaction (AssetService already implements atomic operations).

**Frontend Changes** ✅

* ✅ Implement **undo/redo stack** in `historyStore` (already existed, comprehensive).
* ✅ Add **Trash view** to recover deleted nodes/assets.
* ⚠️ Add **unsaved changes indicators** during debounced saves (deferred - TanStack Query provides `isPending` state).

**DB Changes** ✅

* ✅ Add `is_deleted` flag and `deleted_at` timestamp to nodes table.
* ✅ Add index on `is_deleted` for efficient trash queries.
* ✅ All repository queries filter `is_deleted = FALSE` by default.

**Background / Maintenance Tasks** 🔄

* 🔄 Automated **database backup** via pg_dump cron (DevOps/Infrastructure task).
* 🔄 Periodic **orphan detection** (scheduled job, separate implementation).

**Tests / Validation** ✅

* ✅ Node creation + link update atomicity.
* ✅ Node + asset deletion lifecycle.
* ✅ Undo/redo metadata preservation.
* ✅ Circular reference prevention in hierarchy moves.
* ✅ Soft-delete and restoration tests.
* ✅ Query filtering validation.
 
**See PHASE_0_IMPLEMENTATION.md for complete details.**

---

## **Phase 1 – High / P1 Actions (Service Hardening, UX, Query Performance)** ✅ **COMPLETED**

**Backend Changes** ✅

* ✅ Added input validation for all node create/update endpoints (name max 50KB, icon max 100 chars, control char detection, color format validation).
* ✅ Added **max hierarchy depth check** (MAX_HIERARCHY_DEPTH=100) in move operations to prevent pathological trees.
* ✅ Link parsing already wrapped in transactions (Phase 0).
* ✅ Optimistic locking support: `expected_version` parameter in update endpoints, returns 409 on conflict.

**Frontend Changes** ✅

* ✅ Added **conflict detection indicators** - handles 409 errors, invalidates stale queries.
* ✅ HTML sanitization for pasted content using **DOMPurify** in BlockEditor.
* ✅ Undo/redo already handles multi-step operations (Phase 0).

**DB Changes** ✅

* ✅ Added cascade delete triggers for critical relationships (links, properties, views).
* ✅ Max hierarchy depth enforced in application layer (closure table-based calculation).

**Background / Maintenance Tasks** ✅

* ✅ **Pagination support** added to `get_all_pages()` with limit/offset parameters.
* 🔄 Query result caching (deferred - optimization task for later).

**Tests / Validation** ✅

* ✅ Concurrent edit conflict detection tests.
* ✅ Max depth enforcement tests.
* ✅ HTML content sanitization (DOMPurify integration).
* ✅ Pagination and input validation correctness tests.

**See PHASE_1_IMPLEMENTATION.md for complete details.**

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
