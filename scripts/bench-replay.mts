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
 * Two deterministic mixes (--mix classic|wide|both, default both):
 *  - classic: a single clock, one synthetic device, sequential HLCs —
 *    zero out-of-order delivery, zero LWW contention (the original
 *    headline-comparable shape);
 *  - wide:    three synthetic devices with rate-skewed clocks (real
 *    out-of-order HLC windows), conflicting LWW writes to the same
 *    property/node delivered inverted vs their HLC order, tag unassign +
 *    re-add churn, and payload-invalid POISON ops. The harness rejects
 *    poison at the replay boundary exactly the way the real pipeline does
 *    at ingest (validateEnvelope — a poison envelope never reaches an
 *    applier; counted as skipped, like the server's ingest 422), so the
 *    apply paths see only valid envelopes.
 *
 * Workspace shape (both mixes): a journal (root page → month pages → day
 * pages → content blocks), scattered root pages with blocks, two user
 * classes with classed entities, tags, text/number/scoped property schemas
 * with values, mentions inside block content, moves, trash + restores.
 * Deterministic for a given --seed.
 *
 * Modes (the apply path each side takes today):
 *  - server: one store.apply() per envelope — one transaction per envelope,
 *    exactly WorkspaceManager.replaySince;
 *  - client: 1000-envelope store.applyMany pages — SyncEngine catch-up;
 *  - bulk:     the Store bulk window (beginBulk/endBulk around the replay).
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx scripts/bench-replay.mts \
 *     --mode server --envelopes 20000 [--mix classic|wide|both]
 *   NODE_OPTIONS=--cpu-prof …  # drop a .cpuprofile next to the CWD
 *
 * Reports wall time, envelopes/sec, statement counts, the top SQL buckets,
 * the non-statement share (transaction commit / JS / prepare), and a
 * stateHash over every derived table — the correctness handle: a faster
 * path must converge to the SAME hash for the same seed and mix (replay
 * determinism law).
 *
 * Generator pins: scripts/bench-replay.test.mts
 * (node --import tsx --test scripts/bench-replay.test.mts).
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { newEnvelope, type Envelope } from "../packages/protocol/src/index.ts";
import {
  Store,
  StoreError,
  validateEnvelope,
  type SqliteDB,
  type SqliteStatement,
  type StoreBackend,
} from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

// --- args (read inside main; the module is importable for the tests) --------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}
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

// The generator state is reset per generateLog call: two runs of the same
// (seed, mix) replay the exact same log.
let rand = mulberry32(42);
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
/** Envelope ids: deterministic too, so two runs of the same (seed, mix)
 *  replay the exact same log (uuidv7() would randomize them per run). */
function nextEnvelopeId(): string {
  envIdCounter += 1;
  const hex = envIdCounter.toString(16).padStart(12, "0");
  return `0192c000-0000-7000-8000-${hex}`;
}

// --- shared generator pieces --------------------------------------------------------

const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud".split(
    " ",
  );
function textTokens(n: number): Array<{ type: "text"; text: string }> {
  const out: Array<{ type: "text"; text: string }> = [];
  for (let i = 0; i < n; i += 1) out.push({ type: "text", text: `${pick(WORDS)}${rand() < 0.3 ? `-${Math.floor(rand() * 1000)}` : ""} ` });
  return out;
}

interface Pools {
  rootPages: string[];
  /** pages that receive block children (root pages + journal day pages) */
  containers: string[];
  blocks: string[];
  entities: string[];
  tags: string[];
  tagged: string[];
  trashed: string[];
  movablePages: string[];
  childPages: string[];
  classA: string | null;
  classB: string | null;
  schemas: { text: string | null; number: string | null; scoped: string | null };
}

function freshPools(): Pools {
  return {
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
}

/**
 * The shared pool-aware op closures, parameterized by the emit function so
 * both mixes (single-device sequential, multi-device skewed) generate the
 * same op vocabulary. `emit` stamps whatever device/clock the mix wants.
 */
function makeOps(emit: (opType: string, payload: Record<string, unknown>) => void, pools: Pools) {
  const journal = {
    root: null as string | null,
    months: new Map<string, string>(),
    days: new Map<string, string>(),
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
        const i = list.indexOf(id);
        if (i >= 0) list.splice(i, 1);
      }
      const ci = pools.containers.indexOf(id);
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

  return {
    opCreate,
    opUpdate,
    opMove,
    opDelete,
    opRestore,
    opClassCreate,
    opSchemaCreate,
    opPropertySet,
    opPropertyAssign,
    opClassPropertySet,
    opTagUnassign,
    opFeatureSet,
  };
}

// --- the classic mix: one device, one clock, sequential HLCs -----------------------

function generateClassicLog(total: number): Envelope[] {
  const pools = freshPools();
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

  const ops = makeOps(emit, pools);
  const table: Array<[number, () => void]> = [
    [58, ops.opCreate],
    [14, ops.opUpdate],
    [8, ops.opMove],
    [4, ops.opDelete],
    [2, ops.opRestore],
    [0.8, ops.opClassCreate],
    [1, ops.opClassPropertySet],
    [0.2, ops.opSchemaCreate],
    [6, ops.opPropertySet],
    [1.5, ops.opPropertyAssign],
    [0.5, ops.opTagUnassign],
    [0.05, ops.opFeatureSet],
  ];
  const totalWeight = table.reduce((s, [w]) => s + w, 0);

  // Bootstrap: classes + schemas exist before the mix references them.
  ops.opClassCreate();
  ops.opClassCreate();
  ops.opSchemaCreate();
  ops.opSchemaCreate();
  ops.opSchemaCreate();

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

// --- the wide mix: three devices, out-of-order HLCs, contention, poison ------------

/** Rate-skewed per-device clocks: device 1 jumps fastest, device 0 slowest —
 *  interleaving their ops produces real out-of-order HLC windows. */
const WIDE_DEVICES = [
  { deviceId: "bench-dev-a", minStep: 2, maxStep: 5 },
  { deviceId: "bench-dev-b", minStep: 9, maxStep: 17 },
  { deviceId: "bench-dev-c", minStep: 4, maxStep: 8 },
] as const;

function generateWideLog(total: number): Envelope[] {
  const pools = freshPools();
  const clocks = WIDE_DEVICES.map(() => 1_727_000_000_000);
  const log: Envelope[] = [];
  let episode = 0;

  const emitOn = (di: number, opType: string, payload: Record<string, unknown>): void => {
    const dev = WIDE_DEVICES[di]!;
    clocks[di] = clocks[di]! + dev.minStep + Math.floor(rand() * (dev.maxStep - dev.minStep + 1));
    const physical = clocks[di]!;
    const envelope = newEnvelope({
      workspaceId: WS,
      actorId: ACTORS[di % ACTORS.length]!,
      deviceId: dev.deviceId,
      hlc: { physical, logical: 0 },
      opType,
      payload,
      timestamp: new Date(physical).toISOString(),
    }) as Envelope;
    envelope.id = nextEnvelopeId();
    log.push(envelope);
  };

  const ops = makeOps((opType, payload) => emitOn(Math.floor(rand() * WIDE_DEVICES.length), opType, payload), pools);

  /**
   * LWW contention: two devices write the SAME (node, property-schema) pair
   * with the higher-HLC write delivered BEFORE the lower-HLC one — replay
   * order (log order) is inverted vs causality, so the LWW read path decides
   * the winner. A final re-read of the winner's value by a third device makes
   * the contention observable in the derived state.
   */
  const contentionEpisode = (): void => {
    if (pools.entities.length === 0 || pools.schemas.scoped === null) return;
    episode += 1;
    const node = pick(pools.entities);
    const schema = pools.schemas.scoped;
    // Device 1 (fast clock) wins the HLC; device 0 (slow clock) loses — but
    // the LOSING op is delivered AFTER the winning one.
    emitOn(1, "property.set", { objectId: node, propertySchemaId: schema, value: `contention-winner-${episode}` });
    emitOn(0, "property.set", { objectId: node, propertySchemaId: schema, value: `contention-loser-${episode}` });
    // A node-field LWW pair as well (icon on a block).
    if (pools.blocks.length > 0) {
      const block = pick(pools.blocks);
      emitOn(2, "object.update", { objectId: block, icon: "mdi:alpha" });
      emitOn(0, "object.update", { objectId: block, icon: "mdi:beta" });
    }
  };

  /** Tag churn: unassign then re-add the same tag via the re-issued-create
   *  OR-Set add carrier (from a different device, out of order). */
  const tagChurnEpisode = (): void => {
    if (pools.tagged.length === 0) return;
    const node = pick(pools.tagged);
    const tag = pick(pools.tags);
    emitOn(1, "tag.unassign", { objectId: node, tagId: tag });
    emitOn(0, "object.create", { objectId: node, parentId: null, tagIds: [tag], contentAst: textTokens(1) });
  };

  /** A payload-invalid op the ingest boundary rejects (never applied). */
  const poisonOp = (): void => {
    episode += 1;
    emitOn(Math.floor(rand() * WIDE_DEVICES.length), "object.create", {
      objectId: `not-a-uuid-${episode}`,
      parentId: null,
      contentAst: [],
    });
  };

  const table: Array<[number, () => void]> = [
    [58, ops.opCreate],
    [14, ops.opUpdate],
    [8, ops.opMove],
    [4, ops.opDelete],
    [2, ops.opRestore],
    [0.8, ops.opClassCreate],
    [1, ops.opClassPropertySet],
    [0.2, ops.opSchemaCreate],
    [6, ops.opPropertySet],
    [1.5, ops.opPropertyAssign],
    [1.5, ops.opTagUnassign], // churn-heavier than classic
    [0.05, ops.opFeatureSet],
  ];
  const totalWeight = table.reduce((s, [w]) => s + w, 0);

  // Bootstrap on device 0: classes, schemas, tags, the journal skeleton, and
  // a seed pool of pages/blocks the mixed phase can reference from any device.
  ops.opClassCreate();
  ops.opClassCreate();
  ops.opSchemaCreate();
  ops.opSchemaCreate();
  ops.opSchemaCreate();
  while (pools.tags.length < 12) {
    const id = nextId();
    emitOn(0, "object.create", { objectId: id, parentId: null, contentAst: textTokens(1) });
    pools.tags.push(id);
    pools.rootPages.push(id);
    pools.containers.push(id);
  }
  for (let i = 0; i < 30; i += 1) {
    ops.opCreate();
    if (pools.rootPages.length >= 12 && pools.blocks.length >= 80) break;
  }
  while (pools.blocks.length < 80 || pools.rootPages.length < 12) ops.opCreate();

  while (log.length < total) {
    // Episode cadence: contention ~every 37 ops, tag churn ~every 53,
    // poison ~every 97 — all counted toward the total.
    const n = log.length;
    if (n % 37 === 20) {
      contentionEpisode();
      continue;
    }
    if (n % 53 === 11) {
      tagChurnEpisode();
      continue;
    }
    if (n % 97 === 5) {
      poisonOp();
      continue;
    }
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

// --- generator API (imported by the pins) -------------------------------------------

export type BenchMix = "classic" | "wide";

/**
 * Generate the synthetic log. Resets the PRNG and id counters first, so two
 * calls with the same (total, seed, mix) produce byte-identical logs.
 */
export function generateLog(total: number, seed: number, mix: BenchMix): Envelope[] {
  rand = mulberry32(seed);
  idCounter = 0;
  envIdCounter = 0;
  return mix === "wide" ? generateWideLog(total) : generateClassicLog(total);
}

/**
 * The ingest boundary: envelopes the strict protocol schemas reject are
 * dropped BEFORE any applier sees them — exactly the real pipeline's
 * behavior (the server's ingest validates before persisting; a poison
 * envelope is a 422, never an apply). The wide mix's poison ops land here.
 */
export function partitionValid(log: Envelope[]): { valid: Envelope[]; rejected: Envelope[] } {
  const valid: Envelope[] = [];
  const rejected: Envelope[] = [];
  for (const envelope of log) {
    try {
      validateEnvelope(envelope);
      valid.push(envelope);
    } catch {
      rejected.push(envelope);
    }
  }
  return { valid, rejected };
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

function replay(
  log: Envelope[],
  store: Store,
  mode: string,
): { skipped: number; skipReasons: Map<string, number> } {
  let skipped = 0;
  const skipReasons = new Map<string, number>();
  const noteSkip = (label: string): void => {
    skipped += 1;
    skipReasons.set(label, (skipReasons.get(label) ?? 0) + 1);
  };
  if (mode === "server") {
    for (const env of log) {
      try {
        store.apply(env);
      } catch (error) {
        if (error instanceof StoreError === false) throw error;
        if (process.env.BENCH_DEBUG_SKIPS) {
          console.error("SKIP", JSON.stringify(env.payload), String((error as Error).message).slice(0, 300));
        }
        noteSkip(`${(error as Error).name}: ${(error as Error).message.slice(0, 120)}`);
        continue;
      }
    }
  } else if (mode === "client") {
    for (let i = 0; i < log.length; i += CLIENT_PAGE) {
      const page = log.slice(i, i + CLIENT_PAGE);
      const summaries = store.applyMany(page, { quarantinePoisonOps: true });
      skipped += summaries.filter((s) => s.quarantined === true).length;
    }
  } else if (mode === "bulk") {
    store.beginBulk();
    try {
      for (let i = 0; i < log.length; i += SERVER_PAGE) {
        const page = log.slice(i, i + SERVER_PAGE);
        const summaries = store.applyMany(page, { quarantinePoisonOps: true });
        skipped += summaries.filter((s) => s.quarantined === true).length;
      }
    } finally {
      store.endBulk();
    }
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  return { skipped, skipReasons };
}

// --- main --------------------------------------------------------------------------------

function runBench(mix: BenchMix, mode: string, count: number, seed: number): void {
  const log = generateLog(count, seed, mix);
  const opHistogram = new Map<string, number>();
  for (const env of log) opHistogram.set(env.opType, (opHistogram.get(env.opType) ?? 0) + 1);

  const dir = mkdtempSync(join(tmpdir(), "notees-bench-replay-"));
  const dbPath = join(dir, "derived.db");
  const instr: Instrumentation = { buckets: new Map(), statementCalls: 0, prepareCalls: 0 };

  const t0 = performance.now();
  const store = new Store(instrumentedBackend(betterSqlite3Backend(dbPath), instr));
  const openMs = performance.now() - t0;

  // The ingest boundary: poison ops (wide mix) are rejected before any
  // applier sees them, exactly like the real pipeline's ingest validation.
  const { valid, rejected } = partitionValid(log);

  const r0 = performance.now();
  const { skipped, skipReasons } = replay(valid, store, mode);
  if (rejected.length > 0) {
    skipReasons.set("ingest-rejected (invalid envelope)", rejected.length);
  }
  const replayMs = performance.now() - r0;
  const totalSkipped = skipped + rejected.length;

  const hash = stateHash(store.database);
  const semanticHash = stateHash(store.database, true);

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

  // Clean-restart measurement: a reopen with no marker and no new envelopes
  // must not pay the maintenance tail. Runs after the hash/dump blocks;
  // tracked here for the RESULT line.
  let reopenMs: number | null = null;
  let reopenStatements: number | null = null;
  const measureReopen = (): void => {
    store.close();
    const instr2: Instrumentation = { buckets: new Map(), statementCalls: 0, prepareCalls: 0 };
    const tR = performance.now();
    const reopened = new Store(instrumentedBackend(betterSqlite3Backend(dbPath), instr2));
    reopenMs = performance.now() - tR;
    reopenStatements = instr2.statementCalls;
    reopened.close();
  };

  console.log(`mix=${mix} mode=${mode} envelopes=${log.length} seed=${seed}`);
  console.log(`op mix: ${[...opHistogram.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`replay wall: ${replayMs.toFixed(0)} ms  (${(log.length / (replayMs / 1000)).toFixed(0)} envelopes/sec)`);
  console.log(`open (schema): ${openMs.toFixed(0)} ms`);
  console.log(
    `skipped/quarantined: ${totalSkipped}${skipReasons.size > 0 ? ` (${[...skipReasons.entries()].map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}`,
  );
  console.log(`statement calls: ${instr.statementCalls}  prepare calls: ${instr.prepareCalls}`);
  console.log(`sql inside statements: ${sqlTotalMs.toFixed(0)} ms  non-statement (commit/JS/prepare): ${nonSqlMs.toFixed(0)} ms`);
  console.log(`rows: nodes=${counts.nodes} edges=${counts.edges} stats=${counts.stats} applied=${counts.applied} propValues=${counts.propValues}`);
  console.log(`stateHash: ${hash}`);
  console.log(`semanticHash: ${semanticHash}`);
  console.log("top SQL buckets (total ms / count):");
  for (const [key, b] of top) {
    console.log(`  ${b.totalMs.toFixed(0).padStart(8)} ms  ${String(b.count).padStart(8)}  ${key}`);
  }

  if (mode === "bulk") {
    measureReopen();
    console.log(`clean reopen: ${reopenMs!.toFixed(1)} ms, ${reopenStatements} statements (no tail work)`);
  } else {
    store.close();
  }
  rmSync(dir, { recursive: true, force: true });

  // Machine-readable tail line for scripts collecting numbers.
  console.log(
    `RESULT ${JSON.stringify({
      mix,
      mode,
      envelopes: log.length,
      seed,
      replayMs: Math.round(replayMs),
      envelopesPerSec: Math.round(log.length / (replayMs / 1000)),
      sqlMs: Math.round(sqlTotalMs),
      nonSqlMs: Math.round(nonSqlMs),
      statementCalls: instr.statementCalls,
      skipped: totalSkipped,
      ingestRejected: rejected.length,
      nodes: counts.nodes,
      edges: counts.edges,
      stateHash: hash,
      semanticHash,
      reopenMs: reopenMs === null ? undefined : Math.round(reopenMs),
      reopenStatements: reopenStatements ?? undefined,
    })}`,
  );
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mode = arg("mode", "server");
  const count = Number(arg("envelopes", "20000"));
  const seed = Number(arg("seed", "42"));
  const mixArg = arg("mix", "both");
  const mixes: BenchMix[] =
    mixArg === "classic" ? ["classic"] : mixArg === "wide" ? ["wide"] : ["classic", "wide"];
  for (const mix of mixes) {
    runBench(mix, mode, count, seed);
  }
}
