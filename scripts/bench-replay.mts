/**
 * bench-replay.mts — derived-store replay benchmark (the wipe-rebuild cost).
 *
 * Measures how fast a fresh @notees/store converges when the relay log is
 * replayed through it — the exact cost the server pays after a restore-epoch
 * bump (WorkspaceManager.replaySince) and the browser worker pays on
 * wipe-resync (SyncEngine catch-up). Synthetic log only: every envelope is
 * generated here from a seeded PRNG; no workspace data is read anywhere
 * (repo law — benchmarks never touch personal data).
 *
 * Synthetic log shape (a busy personal workspace): a journal (root page →
 * month pages → day pages → content blocks), scattered root pages with
 * blocks, two user classes with classed entities, tags, text/number/scoped
 * property schemas with values, mentions inside block content, moves,
 * trash + restores. Deterministic for a given --seed.
 *
 * Modes (the apply path each side takes today):
 *  - server: one store.apply() per envelope — one transaction per envelope,
 *    exactly WorkspaceManager.replaySince;
 *  - client: 1000-envelope store.applyMany pages — SyncEngine catch-up;
 *  - bulk:     the Store bulk window (beginBulk/endBulk around the replay).
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx scripts/bench-replay.mts \
 *     --mode server --envelopes 20000
 *   NODE_OPTIONS=--cpu-prof …  # drop a .cpuprofile next to the CWD
 *
 * Reports wall time, envelopes/sec, statement counts, the top SQL buckets,
 * the non-statement share (transaction commit / JS / prepare), and a
 * stateHash over every derived table — the correctness handle: a faster
 * path must converge to the SAME hash for the same seed (replay
 * determinism law).
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { newEnvelope, type Envelope, type OpPayload } from "../packages/protocol/src/index.ts";
import {
  Store,
  StoreError,
  type SqliteDB,
  type SqliteStatement,
  type StoreBackend,
} from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

// --- args ----------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}
const MODE = arg("mode", "server");
const COUNT = Number(arg("envelopes", "20000"));
const SEED = Number(arg("seed", "42"));
const CLIENT_PAGE = 1000; // SyncEngine DEFAULT_CATCH_UP_LIMIT
const SERVER_PAGE = 10_000; // RelayStorage.catchUp page used by replaySince

// --- deterministic PRNG ----------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

// --- ids / actors -----------------------------------------------------------------

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTORS = ["0192a000-0000-7000-8000-0000000000a1", "0192a000-0000-7000-8000-0000000000a2"];
let idCounter = 0;
/** Deterministic uuid-shaped id (benchmark-local; uniqueness is all that matters). */
function nextId(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `0192b000-0000-7000-8000-${hex}`;
}
let envIdCounter = 0;
/** Envelope ids: deterministic too, so two runs of the same seed replay the
 *  exact same log (uuidv7() would randomize them per run). */
function nextEnvelopeId(): string {
  envIdCounter += 1;
  const hex = envIdCounter.toString(16).padStart(12, "0");
  return `0192c000-0000-7000-8000-${hex}`;
}

// --- synthetic log ------------------------------------------------------------------

interface Pools {
  rootPages: string[];
  /** pages that receive block children (root pages + journal day pages) */
  containers: string[];
  blocks: string[];
  entities: string[];
  tags: string[];
  tagged: string[];
  trashed: string[];
  classA: string | null;
  classB: string | null;
  schemas: { text: string | null; number: string | null; scoped: string | null };
}

const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud".split(
    " ",
  );
function textTokens(n: number): Array<{ type: "text"; text: string }> {
  const out: Array<{ type: "text"; text: string }> = [];
  for (let i = 0; i < n; i += 1) out.push({ type: "text", text: `${pick(WORDS)}${rand() < 0.3 ? `-${Math.floor(rand() * 1000)}` : ""} ` });
  return out;
}

function generateLog(total: number): Envelope[] {
  const pools: Pools & { movablePages: string[]; childPages: string[] } = {
    rootPages: [],
    containers: [],
    blocks: [],
    entities: [],
    tags: [],
    tagged: [],
    trashed: [],
    movablePages: [],
    childPages: [],
    classA: null,
    classB: null,
    schemas: { text: null, number: null, scoped: null },
  };
  const journal = { root: null as string | null, months: new Map<string, string>(), days: new Map<string, string>() };
  let clock = 1_727_000_000_000;
  const log: Envelope[] = [];

  const emit = (opType: string, payload: Record<string, unknown>): void => {
    clock += 3 + Math.floor(rand() * 9);
    const envelope = newEnvelope({
      workspaceId: WS,
      actorId: pick(ACTORS),
      deviceId: "bench-device",
      hlc: { physical: clock, logical: 0 },
      opType,
      payload,
      timestamp: new Date(clock).toISOString(),
    }) as Envelope;
    envelope.id = nextEnvelopeId();
    log.push(envelope);
  };

  const mentionToken = (): { type: "mention"; targetNodeId: string } | null => {
    const universe = pools.blocks.length + pools.rootPages.length;
    if (universe === 0 || rand() >= 0.15) return null;
    const target = rand() < 0.5 && pools.blocks.length > 0 ? pick(pools.blocks) : pick(pools.rootPages);
    return { type: "mention", targetNodeId: target };
  };

  const blockContent = (): unknown[] => {
    const tokens: unknown[] = textTokens(1 + Math.floor(rand() * 3));
    const mention = mentionToken();
    if (mention !== null) tokens.push(mention);
    return tokens;
  };

  const createBlock = (parent: string): void => {
    const id = nextId();
    emit("object.create", { objectId: id, parentId: parent, contentAst: blockContent() });
    pools.blocks.push(id);
  };

  const createRootPage = (tagId?: string): void => {
    const id = nextId();
    emit("object.create", {
      objectId: id,
      parentId: null,
      contentAst: textTokens(1),
      ...(tagId !== undefined ? { tagIds: [tagId] } : {}),
    });
    pools.rootPages.push(id);
    pools.containers.push(id);
    pools.movablePages.push(id);
    if (tagId !== undefined) pools.tagged.push(id);
  };

  // Journal: root → month → day → blocks (the daily-note shape that makes
  // ancestor/descendant derivation expensive).
  const journalDayParent = (): string => {
    const now = new Date(2024, 0, 1 + Math.floor(rand() * 700));
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const ymd = `${ym}-${String(now.getDate()).padStart(2, "0")}`;
    let monthId = journal.months.get(ym);
    if (monthId === undefined) {
      if (journal.root === null) {
        journal.root = nextId();
        emit("object.create", { objectId: journal.root, parentId: null, contentAst: textTokens(1) });
        pools.rootPages.push(journal.root);
        pools.containers.push(journal.root);
      }
      monthId = nextId();
      emit("object.create", { objectId: monthId, parentId: journal.root, contentAst: textTokens(1) });
      journal.months.set(ym, monthId);
    }
    let dayId = journal.days.get(ymd);
    if (dayId === undefined) {
      dayId = nextId();
      emit("object.create", { objectId: dayId, parentId: monthId, contentAst: textTokens(1) });
      journal.days.set(ymd, dayId);
      pools.containers.push(dayId);
    }
    return dayId;
  };

  const opCreate = (): void => {
    const r = rand();
    if (pools.tags.length < 12 && r < 0.06) {
      const id = nextId();
      emit("object.create", { objectId: id, parentId: null, contentAst: textTokens(1) });
      pools.tags.push(id);
      pools.rootPages.push(id);
      pools.containers.push(id);
      return;
    }
    const jr = rand();
    if (jr < 0.45) {
      createBlock(journalDayParent());
    } else if (jr < 0.75) {
      // containers is empty only before the first page exists — open the
      // journal instead of creating a (standalone, unparented) block.
      createBlock(pools.containers.length > 0 ? pick(pools.containers) : journalDayParent());
    } else if (jr < 0.83) {
      createRootPage(rand() < 0.08 ? pick(pools.tags) : undefined);
    } else {
      const id = nextId();
      // Every entity carries classA so the classA-scoped property schema is
      // always eligible (classB rides along on 40%).
      const classIds = rand() < 0.6 ? [pools.classA!] : [pools.classA!, pools.classB!];
      emit("object.create", { objectId: id, parentId: null, classIds, contentAst: textTokens(2) });
      pools.entities.push(id);
      pools.rootPages.push(id);
    }
  };

  const opUpdate = (): void => {
    const r = rand();
    const block = pools.blocks.length > 0 && rand() < 0.7;
    const target = block ? pick(pools.blocks) : pick(pools.rootPages);
    if (r < 0.7) {
      emit("object.update", { objectId: target, contentAst: block ? blockContent() : textTokens(1) });
    } else if (r < 0.85) {
      emit("object.update", { objectId: target, icon: "mdi:star" });
    } else {
      emit("object.update", { objectId: target, color: "sky" });
    }
  };

  const opMove = (): void => {
    if (pools.blocks.length === 0) return;
    if (rand() < 0.8 || pools.movablePages.length < 2) {
      emit("object.move", { objectId: pick(pools.blocks), parentId: pick(pools.containers) });
    } else if (pools.childPages.length > 0 && rand() < 0.5) {
      // A nested page returns to the root (never a cycle).
      const idx = Math.floor(rand() * pools.childPages.length);
      const id = pools.childPages.splice(idx, 1)[0]!;
      emit("object.move", { objectId: id, parentId: null });
      pools.movablePages.push(id);
    } else if (pools.movablePages.length >= 2) {
      // Page moves: root → under another root page (standalone child). The
      // moved page leaves the movable pool (it is no longer a root), so a
      // later move can never close a cycle through it.
      const idx = Math.floor(rand() * pools.movablePages.length);
      const id = pools.movablePages.splice(idx, 1)[0]!;
      emit("object.move", { objectId: id, parentId: pick(pools.movablePages) });
      pools.childPages.push(id);
    }
  };

  const opDelete = (): void => {
    const source = rand();
    let id: string | undefined;
    if (source < 0.6 && pools.entities.length > 0) id = pools.entities.splice(Math.floor(rand() * pools.entities.length), 1)[0];
    else if (source < 0.8 && pools.blocks.length > 0) id = pools.blocks.splice(Math.floor(rand() * pools.blocks.length), 1)[0];
    else if (pools.rootPages.length > 0) {
      id = pools.rootPages.splice(Math.floor(rand() * pools.rootPages.length), 1)[0];
      for (const list of [pools.movablePages, pools.childPages]) {
        const i = list.indexOf(id!);
        if (i >= 0) list.splice(i, 1);
      }
      const ci = pools.containers.indexOf(id!);
      if (ci >= 0) pools.containers.splice(ci, 1);
    }
    if (id === undefined) return;
    emit("object.delete", { objectId: id, permanent: false });
    pools.trashed.push(id);
  };

  const opRestore = (): void => {
    if (pools.trashed.length === 0) return;
    const id = pools.trashed.pop()!;
    emit("object.restore", { objectId: id });
  };

  const opClassCreate = (): void => {
    const id = nextId();
    emit("class.create", { classId: id, contentAst: [{ type: "text", text: `Class ${idCounter}` }] });
    if (pools.classA === null) pools.classA = id;
    else if (pools.classB === null) pools.classB = id;
  };

  const opSchemaCreate = (): void => {
    const id = nextId();
    const kind = pools.schemas.text === null ? "text" : pools.schemas.number === null ? "number" : "scoped";
    if (kind === "text" && pools.schemas.text === null) {
      emit("propertySchema.create", { propertySchemaId: id, name: "Note", type: "text" });
      pools.schemas.text = id;
    } else if (kind === "number" && pools.schemas.number === null) {
      emit("propertySchema.create", { propertySchemaId: id, name: "Pages", type: "number" });
      pools.schemas.number = id;
    } else if (pools.schemas.scoped === null) {
      emit("propertySchema.create", {
        propertySchemaId: id,
        name: "Genre",
        type: "text",
        scopeClassIds: [pools.classA!],
      });
      pools.schemas.scoped = id;
    }
    // Later fires are no-ops: three schemas are all the mix references.
  };

  const opPropertySet = (): void => {
    const universe = [...pools.blocks, ...pools.entities, ...pools.rootPages];
    if (universe.length === 0) return;
    const target = pick(universe);
    const r = rand();
    if (r < 0.5 && pools.schemas.scoped !== null && pools.entities.length > 0) {
      emit("property.set", {
        objectId: pick(pools.entities),
        propertySchemaId: pools.schemas.scoped,
        value: `genre-${Math.floor(rand() * 50)}`,
      });
    } else if (r < 0.8 && pools.schemas.text !== null) {
      emit("property.set", { objectId: target, propertySchemaId: pools.schemas.text, value: `note ${Math.floor(rand() * 1000)}` });
    } else if (pools.schemas.number !== null) {
      emit("property.set", { objectId: target, propertySchemaId: pools.schemas.number, value: Math.floor(rand() * 500) });
    }
  };

  const opPropertyAssign = (): void => {
    const universe = [...pools.blocks, ...pools.rootPages];
    if (universe.length === 0 || pools.schemas.text === null) return;
    emit("property.assign", { objectId: pick(universe), propertySchemaId: pools.schemas.text });
  };

  const opClassPropertySet = (): void => {
    if (pools.classA === null || pools.schemas.text === null) return;
    emit("class.property.set", { classId: pools.classA, propertySchemaId: pools.schemas.text, pinned: rand() < 0.3 });
  };

  const opTagUnassign = (): void => {
    if (pools.tagged.length === 0) return;
    const node = pick(pools.tagged);
    emit("tag.unassign", { objectId: node, tagId: pick(pools.tags) });
  };

  const opFeatureSet = (): void => {
    emit("workspace.feature.set", { feature: "journal", enabled: rand() < 0.95 });
  };

  type WeightedOp = [number, () => void];
  const table: WeightedOp[] = [
    [58, opCreate],
    [14, opUpdate],
    [8, opMove],
    [4, opDelete],
    [2, opRestore],
    [0.8, opClassCreate],
    [1, opClassPropertySet],
    [0.2, opSchemaCreate],
    [6, opPropertySet],
    [1.5, opPropertyAssign],
    [0.5, opTagUnassign],
    [0.05, opFeatureSet],
  ];
  const totalWeight = table.reduce((s, [w]) => s + w, 0);

  // Bootstrap: classes + schemas exist before the mix references them.
  opClassCreate();
  opClassCreate();
  opSchemaCreate();
  opSchemaCreate();
  opSchemaCreate();

  while (log.length < total) {
    let roll = rand() * totalWeight;
    for (const [weight, fn] of table) {
      roll -= weight;
      if (roll <= 0) {
        fn();
        break;
      }
    }
  }
  return log;
}

// --- instrumented backend -----------------------------------------------------------

interface Bucket {
  count: number;
  totalMs: number;
}
interface Instrumentation {
  buckets: Map<string, Bucket>;
  statementCalls: number;
  prepareCalls: number;
}

function normalizeSql(sql: string): string {
  const head = sql.trim().split(/\s+/).slice(0, 4).join(" ");
  return head.length > 48 ? head.slice(0, 48) : head;
}

function instrumentedBackend(base: StoreBackend, instr: Instrumentation): StoreBackend {
  const wrapDb = (db: SqliteDB): SqliteDB => {
    const wrapStmt = (sql: string, stmt: SqliteStatement): SqliteStatement => ({
      run(...params: unknown[]) {
        instr.statementCalls += 1;
        const t0 = performance.now();
        const out = stmt.run(...params);
        const dt = performance.now() - t0;
        const key = normalizeSql(sql);
        const b = instr.buckets.get(key) ?? { count: 0, totalMs: 0 };
        b.count += 1;
        b.totalMs += dt;
        instr.buckets.set(key, b);
        return out;
      },
      get(...params: unknown[]) {
        instr.statementCalls += 1;
        const t0 = performance.now();
        const out = stmt.get(...params);
        const dt = performance.now() - t0;
        const key = normalizeSql(sql);
        const b = instr.buckets.get(key) ?? { count: 0, totalMs: 0 };
        b.count += 1;
        b.totalMs += dt;
        instr.buckets.set(key, b);
        return out;
      },
      all(...params: unknown[]) {
        instr.statementCalls += 1;
        const t0 = performance.now();
        const out = stmt.all(...params);
        const dt = performance.now() - t0;
        const key = normalizeSql(sql);
        const b = instr.buckets.get(key) ?? { count: 0, totalMs: 0 };
        b.count += 1;
        b.totalMs += dt;
        instr.buckets.set(key, b);
        return out;
      },
    });
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        instr.prepareCalls += 1;
        return wrapStmt(sql, db.prepare(sql));
      },
      pragma: (source, options) => db.pragma(source, options),
      transaction: (fn) => db.transaction(fn),
      serialize: db.serialize?.bind(db),
      close: db.close?.bind(db),
    };
  };
  return {
    ftsModule: base.ftsModule,
    open: () => wrapDb(base.open()),
    restore: (bytes) => wrapDb(base.restore(bytes)),
    restoreAsync: base.restoreAsync !== undefined ? async (bytes) => wrapDb(await base.restoreAsync!(bytes)) : undefined,
    snapshotStream: base.snapshotStream?.bind(base),
    reset: () => wrapDb(base.reset()),
  };
}

// --- state hash (correctness handle) -----------------------------------------------------

const TABLES = [
  "node",
  "node_child_order",
  "class_member_set",
  "tag_member_set",
  "class",
  "class_extends",
  "class_hierarchy",
  "property_schema",
  "class_property",
  "property_value",
  "property_value_element_tombstone",
  "property_value_tombstone",
  "node_property",
  "edge",
  "node_link",
  "node_stats",
  "trash",
  "collection_member",
  "external_ref",
  "workspace_feature",
  "card_review",
  "applied_envelope",
  "sync_state",
  "quarantined_envelope",
  "local_op_log",
  "app_meta",
  "search_index_docid",
];

/** Bookkeeping tables that legitimately differ across replay modes by design
 * (server skip-and-retry vs client quarantine-and-advance) — excluded from
 * the SEMANTIC hash used for cross-mode convergence comparison. */
const BOOKKEEPING = new Set(["applied_envelope", "sync_state", "quarantined_envelope", "local_op_log", "app_meta"]);

function stateHash(db: SqliteDB, excludeBookkeeping = false): string {
  const hash = createHash("sha256");
  for (const table of TABLES) {
    if (excludeBookkeeping && BOOKKEEPING.has(table)) continue;
    hash.update(`\n## ${table}\n`);
    hash.update(tableHash(db, table));
  }
  return hash.digest("hex").slice(0, 24);
}

function tableHash(db: SqliteDB, table: string): string {
  const hash = createHash("sha256");
  // Canonicalization for the two bulk-window divergences (by design,
  // unobservable — see stats.ts / the bulk window docs):
  //  - node_stats: the online path's incremental maintenance can leave a
  //    stale updated_at (icon/color-only updates skip the stats rebuild) and
  //    never writes class-node rows; the bulk tail rebuilds rows for every
  //    node with the final updated_at. Compare the COUNT columns for
  //    non-class nodes only.
  //  - search_index_docid: docid numbering is path-dependent in both
  //    directions (last_insert_rowid); compare the node → indexed-content
  //    mapping instead.
  let sql: string;
  if (table === "node_stats") {
    sql = `SELECT ns.node_id, ns.child_count, ns.backlink_count, ns.reference_count, ns.descendant_count
           FROM node_stats ns JOIN node n ON n.id = ns.node_id
           WHERE n.is_class = 0 ORDER BY ns.node_id`;
  } else if (table === "search_index_docid") {
    sql = `SELECT d.node_id, s.content
           FROM search_index_docid d JOIN search_index s ON s.rowid = d.docid
           ORDER BY d.node_id`;
  } else {
    sql = `SELECT * FROM ${table} ORDER BY rowid`;
  }
  let rows: unknown[];
  try {
    rows = db.prepare(sql).all();
  } catch {
    return "(absent)";
  }
  hash.update(JSON.stringify(rows));
  return hash.digest("hex").slice(0, 16);
}

// --- replay ---------------------------------------------------------------------------

function replay(log: Envelope[], store: Store): { skipped: number; skipReasons: Map<string, number> } {
  let skipped = 0;
  const skipReasons = new Map<string, number>();
  const noteSkip = (error: unknown): void => {
    skipped += 1;
    const msg = `${error instanceof StoreError ? error.name : "Error"}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
    skipReasons.set(msg, (skipReasons.get(msg) ?? 0) + 1);
  };
  if (MODE === "server") {
    for (const env of log) {
      try {
        store.apply(env);
      } catch (error) {
        if (error instanceof StoreError) {
          if (process.env.BENCH_DEBUG_SKIPS) {
            console.error("SKIP", JSON.stringify(env.payload), String(error.message).slice(0, 300));
          }
          noteSkip(error);
          continue;
        }
        throw error;
      }
    }
  } else if (MODE === "client") {
    for (let i = 0; i < log.length; i += CLIENT_PAGE) {
      const page = log.slice(i, i + CLIENT_PAGE);
      const summaries = store.applyMany(page, { quarantinePoisonOps: true });
      skipped += summaries.filter((s) => s.quarantined === true).length;
    }
  } else if (MODE === "bulk") {
    const anyStore = store as Store & { beginBulk?: () => void; endBulk?: () => void };
    if (typeof anyStore.beginBulk !== "function" || typeof anyStore.endBulk !== "function") {
      throw new Error("mode=bulk requires Store.beginBulk()/endBulk() (not implemented yet)");
    }
    anyStore.beginBulk();
    try {
      for (let i = 0; i < log.length; i += SERVER_PAGE) {
        const page = log.slice(i, i + SERVER_PAGE);
        const summaries = store.applyMany(page, { quarantinePoisonOps: true });
        skipped += summaries.filter((s) => s.quarantined === true).length;
      }
    } finally {
      anyStore.endBulk();
    }
  } else {
    throw new Error(`unknown mode: ${MODE}`);
  }
  return { skipped, skipReasons };
}

// --- main --------------------------------------------------------------------------------

const log = generateLog(COUNT);
if (process.env.BENCH_DUMP_LOG) {
  for (const env of log) {
    const payload = env.payload as Record<string, unknown>;
    if (JSON.stringify(payload).includes("000000000032")) {
      console.log("LOG", env.opType, JSON.stringify(payload));
    }
  }
}
const opHistogram = new Map<string, number>();
for (const env of log) opHistogram.set(env.opType, (opHistogram.get(env.opType) ?? 0) + 1);

const dir = mkdtempSync(join(tmpdir(), "notees-bench-replay-"));
const dbPath = join(dir, "derived.db");
const instr: Instrumentation = { buckets: new Map(), statementCalls: 0, prepareCalls: 0 };

const t0 = performance.now();
const store = new Store(instrumentedBackend(betterSqlite3Backend(dbPath), instr));
const openMs = performance.now() - t0;

const genT0 = performance.now();
// generation is already done above (log); keep the timer honest by measuring replay only.
void genT0;

const r0 = performance.now();
const { skipped, skipReasons } = replay(log, store);
const replayMs = performance.now() - r0;

const hash = stateHash(store.database);
const semanticHash = stateHash(store.database, true);

// Finding-2 skip measurement: a clean restart (no marker, no new envelopes)
// must not pay the maintenance tail at open. Reopen the converged file and
// count the statements the open takes — schema probes only, no rebuild. Runs
// after the hash/dump blocks below; tracked here for the RESULT line.
let reopenMs: number | null = null;
let reopenStatements: number | null = null;
function measureReopen(): void {
  store.close();
  const instr2: Instrumentation = { buckets: new Map(), statementCalls: 0, prepareCalls: 0 };
  const tR = performance.now();
  const reopened = new Store(instrumentedBackend(betterSqlite3Backend(dbPath), instr2));
  reopenMs = performance.now() - tR;
  reopenStatements = instr2.statementCalls;
  reopened.close();
}
if (process.env.BENCH_TABLE_HASHES) {
  for (const table of TABLES) {
    console.log(`TABLE ${table} ${tableHash(store.database, table)}`);
  }
}
if (process.env.BENCH_DUMP_TABLE) {
  const table = process.env.BENCH_DUMP_TABLE;
  const rows =
    table === "@searchpairs"
      ? store.database
          .prepare(
            `SELECT d.node_id, s.content FROM search_index_docid d
             LEFT JOIN search_index s ON s.rowid = d.docid ORDER BY d.node_id`,
          )
          .all()
      : store.database.prepare(`SELECT * FROM ${table}`).all();
  console.log(`DUMP ${table}`);
  for (const row of rows) {
    console.log(JSON.stringify(row));
  }
}
const counts = (() => {
  const row = store.database
    .prepare(
      `SELECT (SELECT COUNT(*) FROM node) AS nodes,
              (SELECT COUNT(*) FROM edge) AS edges,
              (SELECT COUNT(*) FROM node_stats) AS stats,
              (SELECT COUNT(*) FROM applied_envelope) AS applied,
              (SELECT COUNT(*) FROM property_value) AS propValues`,
    )
    .get() as { nodes: number; edges: number; stats: number; applied: number; propValues: number };
  return row;
})();

const top = [...instr.buckets.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 12);
const sqlTotalMs = [...instr.buckets.values()].reduce((s, b) => s + b.totalMs, 0);
const nonSqlMs = replayMs - sqlTotalMs;

console.log(`mode=${MODE} envelopes=${log.length} seed=${SEED}`);
console.log(`op mix: ${[...opHistogram.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`replay wall: ${replayMs.toFixed(0)} ms  (${(log.length / (replayMs / 1000)).toFixed(0)} envelopes/sec)`);
console.log(`open (schema): ${openMs.toFixed(0)} ms`);
console.log(`skipped/quarantined: ${skipped}${skipReasons.size > 0 ? ` (${[...skipReasons.entries()].map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}`);
console.log(`statement calls: ${instr.statementCalls}  prepare calls: ${instr.prepareCalls}`);
console.log(`sql inside statements: ${sqlTotalMs.toFixed(0)} ms  non-statement (commit/JS/prepare): ${nonSqlMs.toFixed(0)} ms`);
console.log(`rows: nodes=${counts.nodes} edges=${counts.edges} stats=${counts.stats} applied=${counts.applied} propValues=${counts.propValues}`);
console.log(`stateHash: ${hash}`);
console.log(`semanticHash: ${semanticHash}`);
if (reopenMs !== null) {
  console.log(`clean reopen: ${reopenMs.toFixed(1)} ms, ${reopenStatements} statements (no tail work)`);
}
console.log("top SQL buckets (total ms / count):");
for (const [key, b] of top) {
  console.log(`  ${b.totalMs.toFixed(0).padStart(8)} ms  ${String(b.count).padStart(8)}  ${key}`);
}

if (MODE === "bulk") measureReopen();
else store.close();
rmSync(dir, { recursive: true, force: true });

// Machine-readable tail line for scripts collecting numbers.
console.log(
  `RESULT ${JSON.stringify({
    mode: MODE,
    envelopes: log.length,
    seed: SEED,
    replayMs: Math.round(replayMs),
    envelopesPerSec: Math.round(log.length / (replayMs / 1000)),
    sqlMs: Math.round(sqlTotalMs),
    nonSqlMs: Math.round(nonSqlMs),
    statementCalls: instr.statementCalls,
    skipped,
    nodes: counts.nodes,
    edges: counts.edges,
    stateHash: hash,
    semanticHash,
    reopenMs: reopenMs === null ? undefined : Math.round(reopenMs),
    reopenStatements: reopenStatements ?? undefined,
  })}`,
);
