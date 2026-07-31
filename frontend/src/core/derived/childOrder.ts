import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { queryAll } from '../db/sqlite';
import { loadTreeCrdt, saveTreeCrdt } from './crdtState';
import { TreeCrdt } from '../crdt/tree';
import type { ChangeNotification } from './index';

// Tracks which parent CRDTs have already been logged as repaired this session
// so corrupt server operations don't spam the console on every catch-up sync.
const loggedRepairParents = new Set<string>();

// In-memory cache of clean tree CRDTs for the current session. Repeated corrupt
// server operations for the same parent (e.g. a journal root with duplicate
// daily-page inserts) would otherwise rebuild the tree from the derived table on
// every operation, which is O(n²) for large trees. Caching the clean state avoids
// the repeated DB reads and CRDT reconstructions.
const cleanTreeCache = new Map<string, TreeCrdt>();

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
  const cached = cleanTreeCache.get(nodeId);
  if (cached) {
    return new TreeCrdt(cached.getState());
  }

  const tree = loadTreeCrdt(db, nodeId);
  const duplicates = collectDuplicates(tree.toArray());
  if (duplicates.length === 0) {
    cleanTreeCache.set(nodeId, new TreeCrdt(tree.getState()));
    return tree;
  }
  if (!loggedRepairParents.has(nodeId)) {
    loggedRepairParents.add(nodeId);
    console.warn(
      `[childOrder] repairing corrupt CRDT for parent ${nodeId}, duplicates=${duplicates.join(', ')}`
    );
  }
  const clean = buildTreeCrdtFromDerived(db, nodeId);
  cleanTreeCache.set(nodeId, new TreeCrdt(clean.getState()));
  return clean;
}

export function applyChildOrderOperation(db: Database, op: Operation): ChangeNotification[] {
  const payload = op.payload as Record<string, unknown>;
  if (!payload.treeUpdate) return [];

  const treeUpdate = Array.isArray(payload.treeUpdate)
    ? new Uint8Array(payload.treeUpdate as number[])
    : (payload.treeUpdate as Uint8Array);

  const nodeId = payload.nodeId as string;
  // Start from a clean tree. If this parent was already repaired this session,
  // the cached copy avoids a DB read and a full CRDT rebuild.
  let tree = loadTreeCrdtClean(db, nodeId);
  tree.applyUpdate(treeUpdate);

  let children = tree.toArray();
  const duplicates = collectDuplicates(children);
  if (duplicates.length > 0) {
    // The persisted CRDT state has duplicates that the derived table does not.
    // Rebuild the CRDT from the clean derived table and replay the update.
    if (!loggedRepairParents.has(nodeId)) {
      loggedRepairParents.add(nodeId);
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
      if (!loggedRepairParents.has(nodeId)) {
        loggedRepairParents.add(nodeId);
        console.error(
          `[childOrder] update still produces duplicates for parent ${nodeId} (${remainingDuplicates.join(', ')}); rebuilding clean CRDT`
        );
      }
      tree = buildTreeCrdtFromDerived(db, nodeId);
      children = tree.toArray();
    }
  }
  saveTreeCrdt(db, nodeId, tree);
  cleanTreeCache.set(nodeId, new TreeCrdt(tree.getState()));

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
