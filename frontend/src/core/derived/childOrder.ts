import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { queryAll } from '../db/sqlite';
import { loadTreeCrdt, saveTreeCrdt } from './crdtState';
import { TreeCrdt } from '../crdt/tree';
import type { ChangeNotification } from './index';

// Tracks which parent CRDTs have already been logged as repaired per database
// so corrupt server operations don't spam the console on every catch-up sync.
const loggedRepairParents = new WeakMap<Database, Set<string>>();

// In-memory cache of clean tree CRDTs per database. Repeated corrupt server
// operations for the same parent (e.g. a journal root with duplicate daily-page
// inserts) would otherwise rebuild the tree from the derived table on every
// operation, which is O(n²) for large trees. Caching the clean state avoids the
// repeated DB reads and CRDT reconstructions.
const cleanTreeCache = new WeakMap<Database, Map<string, TreeCrdt>>();

function getLoggedSet(db: Database): Set<string> {
  let set = loggedRepairParents.get(db);
  if (!set) {
    set = new Set<string>();
    loggedRepairParents.set(db, set);
  }
  return set;
}

function getCleanCache(db: Database): Map<string, TreeCrdt> {
  let map = cleanTreeCache.get(db);
  if (!map) {
    map = new Map<string, TreeCrdt>();
    cleanTreeCache.set(db, map);
  }
  return map;
}

/**
 * Rebuild a tree CRDT from the current node_child_order derived table.
 * Used as a recovery path when the persisted CRDT state has drifted from the
 * derived table (e.g. duplicate child IDs caused by historical applier bugs).
 */
export function buildTreeCrdtFromDerived(db: Database, nodeId: string): TreeCrdt {
  const rows = queryAll<{ child_id: string }>(
    db,
    'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
    [nodeId]
  );
  const crdt = new TreeCrdt();
  for (let i = 0; i < rows.length; i++) {
    crdt.insert(rows[i].child_id, i);
  }
  return crdt;
}

function collectDuplicates(items: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) {
      duplicates.add(item);
    } else {
      seen.add(item);
    }
  }
  return Array.from(duplicates);
}

/**
 * Load a tree CRDT, repairing it from the derived table if it contains
 * duplicate child IDs. Use this before mutating a tree so local operations
 * don't carry corrupt state into the operation log.
 */
export function loadTreeCrdtClean(db: Database, nodeId: string): TreeCrdt {
  const cleanCache = getCleanCache(db);
  const logged = getLoggedSet(db);
  const cached = cleanCache.get(nodeId);
  if (cached) {
    return new TreeCrdt(cached.getState());
  }

  const tree = loadTreeCrdt(db, nodeId);
  const duplicates = collectDuplicates(tree.toArray());
  if (duplicates.length === 0) {
    cleanCache.set(nodeId, new TreeCrdt(tree.getState()));
    return tree;
  }
  if (!logged.has(nodeId)) {
    logged.add(nodeId);
    console.warn(
      `[childOrder] repairing corrupt CRDT for parent ${nodeId}, duplicates=${duplicates.join(', ')}`
    );
  }
  const clean = buildTreeCrdtFromDerived(db, nodeId);
  cleanCache.set(nodeId, new TreeCrdt(clean.getState()));
  return clean;
}

/**
 * Persist a tree CRDT and materialize it into node_child_order.
 * Shared by the treeUpdate path and the legacy positional-payload backfill.
 */
function persistTreeState(db: Database, nodeId: string, tree: TreeCrdt): ChangeNotification[] {
  const children = tree.toArray();
  saveTreeCrdt(db, nodeId, tree);
  getCleanCache(db).set(nodeId, new TreeCrdt(tree.getState()));

  db.run('DELETE FROM node_child_order WHERE parent_id = ?', [nodeId]);
  const stmt = db.prepare('INSERT INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)');
  try {
    for (let i = 0; i < children.length; i++) {
      stmt.run([nodeId, children[i], i.toString().padStart(10, '0')]);
    }
  } catch (insertErr) {
    const err = insertErr instanceof Error ? insertErr : new Error(String(insertErr));
    throw new Error(
      `Failed to insert child order for parent ${nodeId} (children=${children.length}): ${err.message}`
    );
  } finally {
    stmt.free();
  }

  return [{ scope: 'tree', nodeId, relatedIds: children }];
}

export function applyChildOrderOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;

  // Legacy positional payloads (pre-treeUpdate ops and migration-era writers).
  // Without this backfill, replaying an old operation log reconstructs almost
  // no child order at all (the 121k-op production replay collapsed 25,531
  // rows to 76) — and any hard rebuild was structure-destroying.
  //
  // node.create { parentId, index }: insert into the parent's tree.
  // Runs AFTER the node applier; the parent id comes from the payload.
  if (opType === 'node.create') {
    const parentId = (payload.parentId as string | null) ?? null;
    const index = payload.index;
    if (!parentId || typeof index !== 'number') return [];
    const tree = loadTreeCrdtClean(db, parentId);
    tree.insert(payload.nodeId as string, Math.min(Math.max(index, 0), tree.toArray().length));
    return persistTreeState(db, parentId, tree);
  }

  // node.move { newParentId, newIndex }: cross-parent move or reorder. Runs
  // BEFORE the node applier (see derived/index.ts) so the old parent id is
  // still available for cleaning the old tree. Current-era moves carry no
  // newIndex (their treeUpdates do the work), so there is no double-apply.
  if (opType === 'node.move') {
    const newParentId = (payload.newParentId as string | null) ?? null;
    const newIndex = payload.newIndex;
    if (typeof newIndex !== 'number') return [];
    const nodeId = payload.nodeId as string;
    const notifications: ChangeNotification[] = [];
    const oldParentRow = queryAll<{ parent_id: string | null }>(
      db,
      'SELECT parent_id FROM node WHERE id = ?',
      [nodeId]
    );
    const oldParentId = oldParentRow[0]?.parent_id ?? null;
    if (oldParentId && oldParentId !== newParentId) {
      const oldTree = loadTreeCrdtClean(db, oldParentId);
      oldTree.delete(nodeId);
      notifications.push(...persistTreeState(db, oldParentId, oldTree));
    }
    if (newParentId) {
      const newTree = loadTreeCrdtClean(db, newParentId);
      // insert() would duplicate a child already present (same-parent reorder).
      newTree.delete(nodeId);
      newTree.insert(nodeId, Math.min(Math.max(newIndex, 0), newTree.toArray().length));
      notifications.push(...persistTreeState(db, newParentId, newTree));
    }
    return notifications;
  }

  if (!payload.treeUpdate) return [];

  const treeUpdate = Array.isArray(payload.treeUpdate)
    ? new Uint8Array(payload.treeUpdate as number[])
    : (payload.treeUpdate as Uint8Array);

  const nodeId = payload.nodeId as string;
  const logged = getLoggedSet(db);
  // Start from a clean tree. If this parent was already repaired this session,
  // the cached copy avoids a DB read and a full CRDT rebuild.
  let tree = loadTreeCrdtClean(db, nodeId);
  tree.applyUpdate(treeUpdate);

  let children = tree.toArray();
  const duplicates = collectDuplicates(children);
  if (duplicates.length > 0) {
    // The persisted CRDT state has duplicates that the derived table does not.
    // Rebuild the CRDT from the clean derived table and replay the update.
    if (!logged.has(nodeId)) {
      logged.add(nodeId);
      console.warn(
        `[childOrder] repairing corrupt CRDT for parent ${nodeId}, duplicates=${duplicates.join(', ')}`
      );
    }
    tree = buildTreeCrdtFromDerived(db, nodeId);
    tree.applyUpdate(treeUpdate);
    children = tree.toArray();
    const remainingDuplicates = collectDuplicates(children);
    if (remainingDuplicates.length > 0) {
      // The update itself introduces duplicates (should not happen). Rebuild
      // the CRDT from the deduplicated derived state so the persisted tree is
      // clean and future operations start from a valid baseline.
      if (!logged.has(nodeId)) {
        logged.add(nodeId);
        console.error(
          `[childOrder] update still produces duplicates for parent ${nodeId} (${remainingDuplicates.join(', ')}); rebuilding clean CRDT`
        );
      }
      tree = buildTreeCrdtFromDerived(db, nodeId);
      children = tree.toArray();
    }
  }
  return persistTreeState(db, nodeId, tree);
}
