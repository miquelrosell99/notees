/**
 * One-off migration harness: replay the legacy-format relay operation log
 * through the REAL derived appliers plus a harness-only legacy-rank patch,
 * then emit corrective relay envelopes as a SQL file.
 *
 * NEVER touches any real database. Outputs:
 *   - data/backups/migration_corrective_20260914.sql
 *   - data/backups/migration_validation_20260914.md
 *
 * Run from the repo root:
 *   node frontend/scripts/run_migration.mjs
 * (vite-node is not installed in this repo — vitest 4 no longer ships it —
 * so run_migration.mjs executes this module through Vite's ssrLoadModule,
 * which gives the same TS + `@/` alias resolution.)
 */

import initSqlJs, { type Database } from 'sql.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createSchema } from '../src/core/db/schema';
import { createOperation, type Operation } from '../src/core/types/operation';
import { applyOperation } from '../src/core/derived/index';
import { applyChildOrderOperation, loadTreeCrdtClean } from '../src/core/derived/childOrder';
import { loadTreeCrdt } from '../src/core/derived/crdtState';
import { extractTextContent } from '../src/core/derived/textContent';
import { queryAll, queryOne } from '../src/core/db/sqlite';
import { TextCrdt } from '../src/core/crdt/text';
import { TreeCrdt } from '../src/core/crdt/tree';
import { bytesToBase64 } from '../src/utils/base64';
import { uuidv7 } from '../src/core/uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DUMP_PATH = process.env.MIGRATION_DUMP ?? path.join(REPO_ROOT, 'data/backups/relay_dump_hlc_ordered_20260914.jsonl');
const SQL_OUT_PATH = process.env.MIGRATION_SQL_OUT ?? path.join(REPO_ROOT, 'data/backups/migration_corrective_20260914.sql');
const REPORT_OUT_PATH = process.env.MIGRATION_REPORT_OUT ?? path.join(REPO_ROOT, 'data/backups/migration_validation_20260914.md');

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
const LEGACY_PAGE_CLASS = '00000000-0000-0000-0001-000000000002';
const COCINA_PAGE = '67ceae9b-7b39-49d9-9f7f-715a06c1d8dc';
const TREEUPDATE_JSON_LIMIT = 500_000;

// ---------------------------------------------------------------------------
// Dump parsing. 30,190 lines of the dump are double-escaped inside payload
// strings (`\\"` where JSON needs `\"`) — the dump pipeline over-escaped
// nested serialized ASTs. Strict parse first; on failure apply the targeted
// repair (verified: all 30,190 failing lines parse cleanly after it, and
// well-formed lines never reach the repair path).
// ---------------------------------------------------------------------------

function parseDumpLine(line: string, stats: { repaired: number }): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    stats.repaired += 1;
    return JSON.parse(line.replace(/\\\\"/g, '\\"')) as Record<string, unknown>;
  }
}

// ---------------------------------------------------------------------------
// Harness-only legacy-rank patch. childOrder.ts is NOT modified; this patch
// lives entirely here. Per parent we keep childId -> rank key
// (rank = parseFloat of the legacy positional index; ties broken by op HLC
// then op id, matching global replay order semantics).
// ---------------------------------------------------------------------------

interface RankKey {
  rank: number;
  physical: number;
  logical: number;
  opId: string;
}

const rankMaps = new Map<string, Map<string, RankKey>>();

function rankMapFor(parentId: string): Map<string, RankKey> {
  let m = rankMaps.get(parentId);
  if (!m) {
    m = new Map();
    rankMaps.set(parentId, m);
  }
  return m;
}

function compareRankKeys(a: RankKey, b: RankKey): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.physical !== b.physical) return a.physical - b.physical;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;
}

/** Persist a harness-mutated tree through the REAL applier (synthetic
 * full-state treeUpdate op), so persistTreeState semantics AND childOrder's
 * clean-tree cache stay exactly coherent with production behavior. */
function persistTreeViaRealApplier(
  db: Database,
  parentId: string,
  tree: ReturnType<typeof loadTreeCrdtClean>,
  hlc: { physical: number; logical: number },
  workspaceId: string,
  opId: string
): void {
  const synthetic = createOperation(
    {
      id: `${opId}:harness-tree`, // never persisted anywhere; applier ignores it
      workspaceId,
      actorId: SYSTEM_ACTOR,
      hlc,
      affectedNodeIds: [parentId],
      opType: 'node.updateContent',
    },
    { nodeId: parentId, treeUpdate: Array.from(tree.getState()) }
  );
  applyChildOrderOperation(db, synthetic);
}

const harnessStats = {
  legacyCreateInserts: 0,
  legacyMoveOps: 0,
  treeUpdateResets: 0,
  rankMapResyncs: 0,
};

/** Insert childId into parent's tree at the rank-sorted position
 * (binary search; delete-then-insert on re-insert, mirroring the numeric
 * move path in childOrder.ts). */
function harnessInsertAtRank(
  db: Database,
  parentId: string,
  childId: string,
  key: RankKey,
  workspaceId: string
): void {
  const map = rankMapFor(parentId);
  const tree = loadTreeCrdtClean(db, parentId);
  // Re-insert semantics: delete first so same-parent reorders don't duplicate.
  tree.delete(childId);
  const children = tree.toArray();
  // Defensive: any child present in the tree but missing from the rank map
  // (e.g. added by a treeUpdate merge between resets) gets a resynced key.
  let resynced = false;
  for (let i = 0; i < children.length; i++) {
    if (children[i] !== childId && !map.has(children[i])) {
      resyncRankMapFromTree(parentId, children, { physical: 0, logical: 0 }, '');
      resynced = true;
      break;
    }
  }
  if (resynced) harnessStats.rankMapResyncs += 1;
  const finalChildren = tree.toArray();
  let lo = 0;
  let hi = finalChildren.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midKey = map.get(finalChildren[mid])!;
    if (compareRankKeys(midKey, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  tree.insert(childId, lo);
  map.set(childId, key);
  persistTreeViaRealApplier(db, parentId, tree, key, workspaceId, key.opId);
}

function harnessRemoveFromParent(
  db: Database,
  parentId: string,
  childId: string,
  hlc: { physical: number; logical: number },
  workspaceId: string,
  opId: string
): void {
  const tree = loadTreeCrdtClean(db, parentId);
  if (!tree.toArray().includes(childId)) {
    rankMaps.get(parentId)?.delete(childId);
    return;
  }
  tree.delete(childId);
  rankMaps.get(parentId)?.delete(childId);
  persistTreeViaRealApplier(db, parentId, tree, hlc, workspaceId, opId);
}

/** Reset a parent's rank map to the tree's current order (ranks 0..n-1) after
 * a full-state treeUpdate merged — later positional ops weave in correctly. */
function resyncRankMapFromTree(
  parentId: string,
  children: string[],
  hlc: { physical: number; logical: number },
  opId: string
): void {
  const map = new Map<string, RankKey>();
  for (let i = 0; i < children.length; i++) {
    map.set(children[i], { rank: i, physical: hlc.physical, logical: hlc.logical, opId });
  }
  rankMaps.set(parentId, map);
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface ReplayStats {
  totalLines: number;
  repairedLines: number;
  applied: number;
  applyErrors: number;
  applyErrorSamples: string[];
  maxPhysical: number;
  workspaces: Map<string, number>;
}

async function replay(db: Database): Promise<ReplayStats> {
  const stats: ReplayStats = {
    totalLines: 0,
    repairedLines: 0,
    applied: 0,
    applyErrors: 0,
    applyErrorSamples: [],
    maxPhysical: 0,
    workspaces: new Map(),
  };
  const parseStats = { repaired: 0 };
  const startedAt = Date.now();

  const rl = readline.createInterface({
    input: fs.createReadStream(DUMP_PATH, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    stats.totalLines += 1;
    const env = parseDumpLine(line, parseStats);
    const opType = env.op_type as string;
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    const hlc = { physical: env.physical as number, logical: env.logical as number };
    if (hlc.physical > stats.maxPhysical) stats.maxPhysical = hlc.physical;
    const workspaceId = env.workspace_id as string;
    stats.workspaces.set(workspaceId, (stats.workspaces.get(workspaceId) ?? 0) + 1);

    const op: Operation = createOperation(
      {
        id: env.id as string,
        workspaceId,
        actorId: env.actor_id as string,
        hlc,
        affectedNodeIds: (env.affected_node_ids as string[]) ?? [],
        opType,
      },
      payload
    );

    // Legacy node.move: capture the old parent BEFORE the node applier's LWW
    // update overwrites it (mirrors applyOperation's move ordering).
    const isLegacyMove = opType === 'node.move' && typeof payload.newIndex === 'string';
    let oldParentId: string | null = null;
    if (isLegacyMove) {
      oldParentId =
        queryOne<{ parent_id: string | null }>(db, 'SELECT parent_id FROM node WHERE id = ?', [
          payload.nodeId as string,
        ])?.parent_id ?? null;
    }

    try {
      applyOperation(db, op);
      stats.applied += 1;
    } catch (err) {
      stats.applyErrors += 1;
      if (stats.applyErrorSamples.length < 10) {
        stats.applyErrorSamples.push(
          `seq~${stats.totalLines} ${opType} ${env.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      continue;
    }

    // --- harness-only legacy-rank patch (runs AFTER the real appliers) ---
    if (opType === 'node.create' && typeof payload.index === 'string' && payload.parentId) {
      const parentId = payload.parentId as string;
      harnessInsertAtRank(
        db,
        parentId,
        payload.nodeId as string,
        { rank: parseFloat(payload.index), physical: hlc.physical, logical: hlc.logical, opId: env.id as string },
        workspaceId
      );
      harnessStats.legacyCreateInserts += 1;
    } else if (isLegacyMove) {
      const newParentId = (payload.newParentId as string | null) ?? null;
      const nodeId = payload.nodeId as string;
      if (oldParentId && oldParentId !== newParentId) {
        harnessRemoveFromParent(db, oldParentId, nodeId, hlc, workspaceId, env.id as string);
      }
      if (newParentId) {
        harnessInsertAtRank(
          db,
          newParentId,
          nodeId,
          {
            rank: parseFloat(payload.newIndex as string),
            physical: hlc.physical,
            logical: hlc.logical,
            opId: env.id as string,
          },
          workspaceId
        );
      }
      harnessStats.legacyMoveOps += 1;
    } else if (
      opType === 'node.updateContent' &&
      (payload.treeUpdate !== undefined || payload.treeUpdateB64 !== undefined)
    ) {
      // A full-state (or delta) tree update merged through the real applier:
      // reset the rank map to the tree's current order so later positional
      // ops weave in correctly.
      const parentId = payload.nodeId as string;
      const children = loadTreeCrdtClean(db, parentId).toArray();
      resyncRankMapFromTree(parentId, children, hlc, env.id as string);
      harnessStats.treeUpdateResets += 1;
    }

    if (stats.totalLines % 10000 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.error(`[replay] ${stats.totalLines} ops (${elapsed}s)`);
    }
  }

  stats.repairedLines = parseStats.repaired;
  return stats;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Mirror of unwrapCrdtContentAst (frontend/src/lib/astBuilder.ts), kept local
 * so the harness stays self-contained. */
function unwrapContentAst(ast: unknown[]): unknown[] {
  if (ast.length !== 1) return ast;
  const block = ast[0] as Record<string, unknown>;
  let wrappedText: string | undefined;
  if (block && block.type === 'text' && typeof block.text === 'string') {
    wrappedText = block.text;
  } else if (
    block &&
    block.type === 'paragraph' &&
    Array.isArray(block.children) &&
    (block.children as unknown[]).length === 1
  ) {
    const child = (block.children as Record<string, unknown>[])[0];
    if (child && child.type === 'text' && typeof child.text === 'string') {
      wrappedText = child.text;
    }
  }
  if (!wrappedText) return ast;
  try {
    const inner = JSON.parse(wrappedText) as unknown;
    if (
      Array.isArray(inner) &&
      inner.length > 0 &&
      inner.every((item) => item !== null && typeof item === 'object' && 'type' in (item as object))
    ) {
      return inner as unknown[];
    }
  } catch {
    // not JSON — bare plaintext
  }
  return ast;
}

function nodeDisplayName(content: string | null): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const unwrapped = unwrapContentAst(arr);
    const text = extractTextContent(JSON.stringify(unwrapped)) ?? '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 80);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// SQL emission
// ---------------------------------------------------------------------------

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface CorrectiveOp {
  workspaceId: string;
  affectedNodeIds: string[];
  opType: string;
  payload: Record<string, unknown>;
}

function writeSqlFile(ops: CorrectiveOp[], startPhysical: number, timestampIso: string): Promise<void> {
  const out = fs.createWriteStream(SQL_OUT_PATH, { encoding: 'utf-8' });
  out.write('-- Corrective relay envelopes for the legacy-format operation log.\n');
  out.write('-- Generated by frontend/scripts/migrate_legacy_structure.ts. Apply with psql.\n');
  out.write('BEGIN;\n');
  let physical = startPhysical;
  for (const op of ops) {
    const id = uuidv7();
    const payloadJson = JSON.stringify(op.payload);
    const affectedJson = JSON.stringify(op.affectedNodeIds);
    out.write(
      `INSERT INTO relay_envelope (id, workspace_id, actor_id, physical, logical, affected_node_ids, op_type, payload, timestamp, protocol_version) VALUES (` +
        `${sqlString(id)}, ${sqlString(op.workspaceId)}, ${sqlString(SYSTEM_ACTOR)}, ${physical}, 0, ` +
        `${sqlString(affectedJson)}::jsonb, ${sqlString(op.opType)}, ${sqlString(payloadJson)}::jsonb, ` +
        `${sqlString(timestampIso)}, 1) ON CONFLICT (id) DO NOTHING;\n`
    );
    physical += 1;
  }
  out.write('COMMIT;\n');
  out.end();
  return new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const require = createRequire(path.join(REPO_ROOT, 'frontend', 'package.json'));
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database();
  createSchema(db);

  console.error('[phase 1] replaying', DUMP_PATH);
  const replayStats = await replay(db);
  console.error(`[phase 1] done: ${replayStats.applied} applied, ${replayStats.applyErrors} errors`);

  // ---- Phase 2: validation data ----
  const childOrderRows = queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM node_child_order')!.c;
  const nodeCount = queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM node')!.c;

  const topParents = queryAll<{ parent_id: string; c: number }>(
    db,
    'SELECT parent_id, COUNT(*) AS c FROM node_child_order GROUP BY parent_id ORDER BY c DESC LIMIT 20'
  );

  const cocinaChildren = queryAll<{ child_id: string }>(
    db,
    'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
    [COCINA_PAGE]
  );
  const cocinaRow = queryOne<{ content: string | null }>(db, 'SELECT content FROM node WHERE id = ?', [
    COCINA_PAGE,
  ]);

  const contentCandidates = queryAll<{ id: string; content: string; workspace_id: string }>(
    db,
    `SELECT id, content, workspace_id FROM node
     WHERE content IS NOT NULL AND content != '[]'
       AND NOT EXISTS (SELECT 1 FROM crdt_state c WHERE c.node_id = node.id AND c.text_state IS NOT NULL)
     ORDER BY id`
  );

  const legacyPageClassNodes = queryAll<{ id: string; class_ids: string; workspace_id: string }>(
    db,
    'SELECT id, class_ids, workspace_id FROM node'
  ).filter((row) => {
    try {
      return (JSON.parse(row.class_ids) as string[]).includes(LEGACY_PAGE_CLASS);
    } catch {
      return false;
    }
  });

  const nameById = new Map<string, string>();
  const nameRows = queryAll<{ id: string; content: string | null }>(db, 'SELECT id, content FROM node');
  for (const row of nameRows) nameById.set(row.id, nodeDisplayName(row.content));

  // Spot-check: 3 pages with >20 children.
  const bigPages = queryAll<{ parent_id: string; c: number }>(
    db,
    `SELECT nco.parent_id, COUNT(*) AS c FROM node_child_order nco
     JOIN node n ON n.id = nco.parent_id
     WHERE n.kind = 'page'
     GROUP BY nco.parent_id HAVING c > 20 ORDER BY c DESC LIMIT 3`
  );
  const spotChecks: string[] = [];
  for (const page of bigPages) {
    const children = queryAll<{ child_id: string }>(
      db,
      'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
      [page.parent_id]
    ).map((r) => r.child_id);
    const names = children.map((id) => nameById.get(id) ?? '');
    const first = names.slice(0, 3);
    const last = names.slice(-3);
    spotChecks.push(
      `- ${page.parent_id} ("${nameById.get(page.parent_id) ?? ''}", ${children.length} children)\n` +
        `  first: ${JSON.stringify(first)}\n  last: ${JSON.stringify(last)}`
    );
  }

  // Rank monotonicity check across all parents.
  let nonMonotonic = 0;
  const nonMonotonicSamples: string[] = [];
  for (const [parentId, map] of rankMaps) {
    const order = loadTreeCrdt(db, parentId).toArray();
    let prev: RankKey | null = null;
    let bad = false;
    for (const child of order) {
      const key = map.get(child);
      if (!key) continue;
      if (prev && compareRankKeys(prev, key) > 0) {
        bad = true;
        break;
      }
      prev = key;
    }
    if (bad) {
      nonMonotonic += 1;
      if (nonMonotonicSamples.length < 5) nonMonotonicSamples.push(parentId);
    }
  }

  // ---- Phase 3: corrective ops ----
  console.error('[phase 3] generating corrective ops');
  const ops: CorrectiveOp[] = [];
  const treeUpdateB64Parents: string[] = [];
  const staleFiltered: { parent: string; child: string; reason: string }[] = [];
  let treeSelfCheckFailures = 0;

  // 1. Child order — one full-state treeUpdate per parent with >= 1 child.
  const parents = queryAll<{ parent_id: string }>(
    db,
    'SELECT DISTINCT parent_id FROM node_child_order ORDER BY parent_id'
  );
  let dominantWorkspace = '';
  let dominantCount = 0;
  for (const [ws, count] of replayStats.workspaces) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantWorkspace = ws;
    }
  }
  const workspaceOfNode = new Map<string, string>();
  for (const row of queryAll<{ id: string; workspace_id: string }>(db, 'SELECT id, workspace_id FROM node')) {
    workspaceOfNode.set(row.id, row.workspace_id);
  }

  for (const { parent_id: parentId } of parents) {
    // Read the parent's final TreeCrdt from persisted crdt_state (source of
    // truth; the clean cache is coherent but the DB is authoritative here).
    const tree = loadTreeCrdt(db, parentId);
    const children = tree.toArray();
    const kept: string[] = [];
    for (const child of children) {
      const nodeRow = queryOne<{ parent_id: string | null }>(
        db,
        'SELECT parent_id FROM node WHERE id = ?',
        [child]
      );
      if (!nodeRow) {
        staleFiltered.push({ parent: parentId, child, reason: 'node deleted' });
        tree.delete(child);
      } else if (nodeRow.parent_id !== parentId) {
        staleFiltered.push({ parent: parentId, child, reason: `parent_id now ${nodeRow.parent_id}` });
        tree.delete(child);
      } else {
        kept.push(child);
      }
    }
    if (kept.length === 0) continue;
    const state = tree.getState();
    const asArray = Array.from(state);
    let payload: Record<string, unknown> = { nodeId: parentId, treeUpdate: asArray };
    if (JSON.stringify(payload).length > TREEUPDATE_JSON_LIMIT) {
      payload = { nodeId: parentId, treeUpdateB64: bytesToBase64(state) };
      treeUpdateB64Parents.push(parentId);
    }
    // Self-check: the emitted full state must decode to exactly the emitted
    // child list (this is what receivers will materialize).
    const decoded = new TreeCrdt(state).toArray();
    if (JSON.stringify(decoded) !== JSON.stringify(kept)) {
      treeSelfCheckFailures += 1;
      if (treeSelfCheckFailures <= 5) {
        console.error(`[self-check] tree mismatch for parent ${parentId}`);
      }
    }
    ops.push({
      workspaceId: workspaceOfNode.get(parentId) ?? dominantWorkspace,
      affectedNodeIds: [parentId],
      opType: 'node.updateContent',
      payload,
    });
  }

  // 2. Content normalization — fresh Yjs doc per node, current wire format.
  //    Convention (from store.ts applyTextUpdate + coding-standards): the Yjs
  //    text holds the real AST serialized to a JSON string (or bare plaintext
  //    for name-only nodes); the `content` mirror is exactly that same string
  //    (text.toPlaintext()). Server stores a JSON-parseable mirror verbatim.
  let contentSkippedEmpty = 0;
  let nulBytePayloads = 0;
  for (const row of contentCandidates) {
    let textString: string;
    try {
      const parsed = JSON.parse(row.content) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const unwrapped = unwrapContentAst(arr);
      if (unwrapped !== arr) {
        // Wrapper form: reuse the inner string verbatim (real AST JSON or
        // bare plaintext), exactly what the editor would have in the CRDT.
        const block = arr[0] as Record<string, unknown>;
        textString =
          block.type === 'text'
            ? (block.text as string)
            : ((block.children as Record<string, unknown>[])[0].text as string);
      } else if (
        arr.length === 1 &&
        (arr[0] as Record<string, unknown>)?.type === 'text' &&
        typeof (arr[0] as Record<string, unknown>).text === 'string'
      ) {
        // Single plain-text node: current client stores bare plaintext.
        textString = (arr[0] as Record<string, unknown>).text as string;
      } else {
        // Real AST: the inline editor serializes it to JSON into the text CRDT.
        textString = JSON.stringify(unwrapped);
      }
    } catch {
      textString = row.content;
    }
    if (textString === '') {
      contentSkippedEmpty += 1;
      continue;
    }
    const text = new TextCrdt();
    text.insert(0, textString);
    const payload: Record<string, unknown> = {
      nodeId: row.id,
      textUpdateB64: bytesToBase64(text.getState()),
      content: textString,
    };
    if (JSON.stringify(payload).includes('\\u0000')) nulBytePayloads += 1;
    ops.push({
      workspaceId: row.workspace_id,
      affectedNodeIds: [row.id],
      opType: 'node.updateContent',
      payload,
    });
  }

  // 3. Legacy "page" class removal. The class id is a fixed well-known UUID
  //    that can exist in several workspaces' derived DBs — unassign per node
  //    (each in its own workspace) and delete the class once per affected
  //    workspace.
  const pageClassByWorkspace = new Map<string, number>();
  for (const row of legacyPageClassNodes) {
    pageClassByWorkspace.set(row.workspace_id, (pageClassByWorkspace.get(row.workspace_id) ?? 0) + 1);
    ops.push({
      workspaceId: row.workspace_id,
      affectedNodeIds: [row.id],
      opType: 'class.unassign',
      payload: { nodeId: row.id, classId: LEGACY_PAGE_CLASS },
    });
  }
  for (const ws of [...pageClassByWorkspace.keys()].sort()) {
    ops.push({
      workspaceId: ws,
      affectedNodeIds: [LEGACY_PAGE_CLASS],
      opType: 'class.delete',
      payload: { classId: LEGACY_PAGE_CLASS },
    });
  }

  // Orphan check: nodes whose final parent_id is set but that have no
  // node_child_order row (e.g. children of the 253 no-index creates and 131
  // no-newIndex moves, which neither the TS applier nor the harness patch can
  // order — the legacy log carries no position for them).
  const orphanRows = queryAll<{ id: string; parent_id: string; workspace_id: string }>(
    db,
    `SELECT id, parent_id, workspace_id FROM node
     WHERE parent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM node_child_order nco WHERE nco.parent_id = node.parent_id AND nco.child_id = node.id)
     ORDER BY id`
  );

  const startPhysical = Math.max(Date.now(), replayStats.maxPhysical + 1);
  const timestampIso = new Date().toISOString();
  await writeSqlFile(ops, startPhysical, timestampIso);
  const sqlSize = fs.statSync(SQL_OUT_PATH).size;

  // ---- Validation report ----
  const emittedChildOrder = ops.filter((o) => o.opType === 'node.updateContent' && (o.payload.treeUpdate || o.payload.treeUpdateB64)).length;
  const emittedContent = ops.filter((o) => o.payload.textUpdateB64).length;
  const emittedUnassign = ops.filter((o) => o.opType === 'class.unassign').length;

  const lines: string[] = [];
  lines.push('# Migration validation — 2026-09-14 legacy relay log');
  lines.push('');
  lines.push(`Generated: ${timestampIso} by frontend/scripts/migrate_legacy_structure.ts`);
  lines.push('');
  lines.push('## Phase 1 — Replay');
  lines.push('');
  lines.push(`- Input: \`${path.relative(REPO_ROOT, DUMP_PATH)}\``);
  lines.push(`- Total envelopes: ${replayStats.totalLines}`);
  lines.push(`- Applied through real appliers: ${replayStats.applied}`);
  lines.push(`- Apply errors (skipped): ${replayStats.applyErrors}`);
  if (replayStats.applyErrorSamples.length > 0) {
    lines.push('  - samples:');
    for (const s of replayStats.applyErrorSamples) lines.push(`    - \`${s}\``);
  }
  lines.push(`- Double-escaped dump lines repaired during parse: ${replayStats.repairedLines}`);
  lines.push(`- Max physical HLC in dump: ${replayStats.maxPhysical}`);
  lines.push('');
  lines.push(`### Workspaces (${replayStats.workspaces.size} — assert: more than one)`);
  lines.push('');
  const sortedWs = [...replayStats.workspaces.entries()].sort((a, b) => b[1] - a[1]);
  for (const [ws, count] of sortedWs) lines.push(`- ${ws}: ${count} ops`);
  lines.push('');
  lines.push('### Harness legacy-rank patch activity');
  lines.push('');
  lines.push(`- node.create string-index inserts: ${harnessStats.legacyCreateInserts}`);
  lines.push(`- node.move string-newIndex ops: ${harnessStats.legacyMoveOps}`);
  lines.push(`- treeUpdate rank-map resets: ${harnessStats.treeUpdateResets}`);
  lines.push(`- defensive rank-map resyncs: ${harnessStats.rankMapResyncs}`);
  lines.push('');
  lines.push('## Phase 2 — Validation gate');
  lines.push('');
  lines.push(`- node rows: ${nodeCount}`);
  lines.push(`- **node_child_order rows: ${childOrderRows}** (known-good ~25,531; 76 = the bug)`);
  lines.push('');
  lines.push('### Top 20 parents by child count');
  lines.push('');
  for (const p of topParents) {
    lines.push(`- ${p.parent_id} ("${nameById.get(p.parent_id) ?? ''}"): ${p.c} children`);
  }
  lines.push('');
  lines.push(`### Page ${COCINA_PAGE} ("cocina")`);
  lines.push('');
  lines.push(`- node exists: ${cocinaRow ? 'yes' : 'NO'}; name: "${nodeDisplayName(cocinaRow?.content ?? null)}"`);
  lines.push(`- children (${cocinaChildren.length}):`);
  for (const c of cocinaChildren) {
    lines.push(`  - ${c.child_id} "${nameById.get(c.child_id) ?? ''}"`);
  }
  lines.push('');
  lines.push('### Content normalization candidates');
  lines.push('');
  lines.push(`- nodes with non-empty content and no crdt_state.text_state: ${contentCandidates.length}`);
  lines.push(`- of those skipped as effectively empty text: ${contentSkippedEmpty}`);
  lines.push(`- nodes with legacy "page" class ${LEGACY_PAGE_CLASS}: ${legacyPageClassNodes.length}`);
  lines.push('');
  lines.push('### Spot checks (pages with >20 children)');
  lines.push('');
  lines.push(...spotChecks);
  lines.push('');
  lines.push(`- parents with non-monotonic rank order: ${nonMonotonic}`);
  for (const s of nonMonotonicSamples) lines.push(`  - ${s}`);
  lines.push('');
  lines.push('### Orphan nodes (parent_id set, no child-order row)');
  lines.push('');
  lines.push(`- count: ${orphanRows.length} — children of the 253 no-index node.create and 131 no-newIndex`);
  lines.push('  node.move ops carry no position anywhere in the legacy log, so neither the TS applier');
  lines.push('  nor the harness rank patch can order them. They are NOT in the emitted trees.');
  for (const o of orphanRows.slice(0, 10)) {
    lines.push(`  - ${o.id} ("${nameById.get(o.id) ?? ''}") parent ${o.parent_id} ("${nameById.get(o.parent_id) ?? ''}")`);
  }
  lines.push('');
  lines.push('## Phase 3 — Corrective envelopes');
  lines.push('');
  lines.push(`- Output: \`${path.relative(REPO_ROOT, SQL_OUT_PATH)}\` (${(sqlSize / 1024 / 1024).toFixed(1)} MiB)`);
  lines.push(`- HLC start: physical=${startPhysical} (max(now_ms, dump max+1)), logical=0, +1 per op`);
  lines.push(`- actor_id: ${SYSTEM_ACTOR}; protocol_version: 1; timestamp: ${timestampIso}`);
  lines.push('');
  lines.push(`1. Child order (node.updateContent with treeUpdate full state): ${emittedChildOrder} ops`);
  lines.push(`   - emit self-check failures (decoded state != emitted child list): ${treeSelfCheckFailures}`);
  lines.push(`   - parents needing treeUpdateB64 fallback (>500 KB JSON): ${treeUpdateB64Parents.length}`);
  for (const p of treeUpdateB64Parents) lines.push(`     - ${p} ("${nameById.get(p) ?? ''}")`);
  lines.push(`   - stale tree children filtered at emit (deleted node or parent_id mismatch): ${staleFiltered.length}`);
  const staleSamples = staleFiltered.slice(0, 10);
  for (const s of staleSamples) lines.push(`     - parent ${s.parent} child ${s.child}: ${s.reason}`);
  lines.push(`2. Content normalization (node.updateContent with textUpdateB64 + content mirror): ${emittedContent} ops`);
  lines.push('   - convention used: Yjs text = real content AST serialized to a JSON string');
  lines.push('     (or bare plaintext for single-text-node content); `content` mirror = exactly that');
  lines.push('     string, matching `applyTextUpdate` in frontend/src/core/store.ts. The server stores');
  lines.push('     a JSON-parseable mirror verbatim (app/core/derived/node.py), so node.content becomes');
  lines.push('     the unwrapped AST.');
  lines.push(`   - payloads containing \\u0000 escapes (jsonb would reject): ${nulBytePayloads}`);
  lines.push(`3. Legacy "page" class removal: ${emittedUnassign} class.unassign + ${pageClassByWorkspace.size} class.delete (one per affected workspace)`);
  for (const [ws, count] of [...pageClassByWorkspace.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`   - workspace ${ws}: ${count} unassigns`);
  }
  lines.push('');
  lines.push(`- Total corrective ops: ${ops.length}`);
  lines.push('');

  fs.writeFileSync(REPORT_OUT_PATH, lines.join('\n'), 'utf-8');
  console.error('[done] report:', REPORT_OUT_PATH);
  console.error('[done] sql:', SQL_OUT_PATH, `${(sqlSize / 1024 / 1024).toFixed(1)} MiB`, `${ops.length} ops`);
  console.log(
    JSON.stringify({
      applied: replayStats.applied,
      applyErrors: replayStats.applyErrors,
      repairedLines: replayStats.repairedLines,
      workspaces: replayStats.workspaces.size,
      nodeCount,
      childOrderRows,
      cocinaChildren: cocinaChildren.length,
      contentCandidates: contentCandidates.length,
      legacyPageClassNodes: legacyPageClassNodes.length,
      emittedChildOrder,
      emittedContent,
      emittedUnassign,
      treeUpdateB64Parents: treeUpdateB64Parents.length,
      staleFiltered: staleFiltered.length,
      treeSelfCheckFailures,
      orphanNodes: orphanRows.length,
      pageClassWorkspaces: pageClassByWorkspace.size,
      nonMonotonic,
      totalCorrectiveOps: ops.length,
      sqlSizeBytes: sqlSize,
    })
  );
}

await main();
