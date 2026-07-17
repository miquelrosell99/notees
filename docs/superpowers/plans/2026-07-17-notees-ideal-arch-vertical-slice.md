# Notees Ideal Architecture — Vertical Slice Prototype

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable TypeScript prototype that validates the core mechanics of the ideal Notees architecture: local SQLite derived state, operation log with HLC, CRDT tree/text merging, snapshots, compaction, encrypted sync envelopes, and offline→online convergence.

**Architecture:** A small Bun/TypeScript process runs a local SQLite database and an in-memory sync relay. User actions become immutable operations ordered by Hybrid Logical Clocks. Tree and text mutations are carried as Yjs update blobs. Derived tables (`node`, `property_value`, `node_child_order`, `edge`) are eagerly updated in the same transaction that appends the operation. Snapshots serialize the derived state up to an HLC; compaction segments mark operation ranges that can be archived. Sync exchanges encrypted envelopes whose routing metadata includes `affectedNodeIds`.

**Tech Stack:** Bun runtime, `bun:sqlite`, TypeScript 5.x, `yjs` for CRDT text/tree, `uuidv7` package, Web Crypto API for AES-GCM envelope encryption.

## Global Constraints

- Every addressable entity uses UUIDv7.
- No integer IDs anywhere.
- Operations are immutable and carry HLC `{ physical: number; logical: number }`.
- Workspace-private payloads are encrypted; envelope routing metadata is unencrypted.
- Derived tables are eagerly maintained but rebuildable from the operation log.
- All code is tested with Bun's built-in test runner (`bun test`).
- Frequent commits; each task ends with a passing test.

---

## File Structure

```
prototypes/notees-ideal-arch/
├── package.json
├── tsconfig.json
├── src/
│   ├── clock.ts              # HLC implementation
│   ├── uuid.ts               # UUIDv7 helpers
│   ├── crypto.ts             # envelope encryption / decryption
│   ├── operation.ts          # operation types and validation
│   ├── db.ts                 # SQLite schema and connection
│   ├── derived/
│   │   ├── node.ts           # node table projection
│   │   ├── childOrder.ts     # node_child_order projection
│   │   ├── property.ts       # property_value projection
│   │   ├── edge.ts           # edge table projection
│   │   └── crdtState.ts      # crdt_state persistence helpers
│   ├── crdt/
│   │   ├── tree.ts           # Yjs Y.Array wrapper for child ordering
│   │   └── text.ts           # Yjs Y.Text wrapper for inline content
│   ├── snapshot.ts           # snapshot create / load / validate
│   ├── compaction.ts         # compaction segment tracking
│   ├── store.ts              # high-level workspace store
│   └── relay.ts              # mock in-memory sync relay
├── tests/
│   ├── smoke.test.ts
│   ├── clock.test.ts
│   ├── uuid.test.ts
│   ├── operation.test.ts
│   ├── crdt/
│   │   ├── tree.test.ts
│   │   └── text.test.ts
│   ├── derived/
│   │   ├── node.test.ts
│   │   ├── childOrder.test.ts
│   │   ├── content.test.ts
│   │   ├── property.test.ts
│   │   └── edge.test.ts
│   ├── store.test.ts
│   ├── snapshot.test.ts
│   ├── compaction.test.ts
│   ├── crypto.test.ts
│   ├── relay.test.ts
│   ├── sync.test.ts
│   └── integration.test.ts
└── README.md
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `prototypes/notees-ideal-arch/package.json`
- Create: `prototypes/notees-ideal-arch/tsconfig.json`
- Create: `prototypes/notees-ideal-arch/README.md`
- Test: `prototypes/notees-ideal-arch/tests/smoke.test.ts`

**Interfaces:**
- Produces: runnable Bun project with TypeScript and test harness.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/smoke.test.ts
import { expect, test } from "bun:test";

test("project smoke test", () => {
  expect(1 + 1).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/smoke.test.ts`
Expected: FAIL with expected 3, received 2

- [ ] **Step 3: Write project files**

```json
// prototypes/notees-ideal-arch/package.json
{
  "name": "notees-ideal-arch-prototype",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "bun test",
    "dev": "bun run src/main.ts"
  },
  "dependencies": {
    "uuidv7": "^1.0.0",
    "yjs": "^13.6.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.5.0"
  }
}
```

```json
// prototypes/notees-ideal-arch/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

```markdown
# Notees Ideal Architecture Prototype

Run tests with `bun test`.
Run the CLI with `bun run src/main.ts`.
```

- [ ] **Step 4: Fix the smoke test**

Change `toBe(3)` to `toBe(2)`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun install && bun test tests/smoke.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add prototypes/notees-ideal-arch/
git commit -m "chore(proto): scaffold notees ideal architecture prototype"
```

---

### Task 2: Hybrid Logical Clock

**Files:**
- Create: `prototypes/notees-ideal-arch/src/clock.ts`
- Test: `prototypes/notees-ideal-arch/tests/clock.test.ts`

**Interfaces:**
- Produces: `Hlc = { physical: number; logical: number }`, `compareHlc(a, b): number`, `maxHlc(a, b): Hlc`, `Clock.advance(physicalTime): Hlc`, `Clock.update(received): Hlc`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/clock.test.ts
import { expect, test } from "bun:test";
import { Clock, compareHlc } from "../src/clock";

test("clock advances and orders events", () => {
  const clock = new Clock("device-a");
  const t1 = clock.advance(1000);
  const t2 = clock.advance(1000);
  expect(compareHlc(t1, t2)).toBe(-1);
  expect(t2.logical).toBeGreaterThan(t1.logical);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/clock.test.ts`
Expected: FAIL "Clock is not defined"

- [ ] **Step 3: Implement the clock**

```typescript
// prototypes/notees-ideal-arch/src/clock.ts
export interface Hlc {
  physical: number;
  logical: number;
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical - b.physical;
  return a.logical - b.logical;
}

export function maxHlc(a: Hlc, b: Hlc): Hlc {
  const cmp = compareHlc(a, b);
  return cmp >= 0 ? a : b;
}

export class Clock {
  private last: Hlc;

  constructor(private readonly deviceId: string) {
    this.last = { physical: 0, logical: 0 };
  }

  advance(physicalTime: number): Hlc {
    if (physicalTime > this.last.physical) {
      this.last = { physical: physicalTime, logical: 0 };
    } else if (physicalTime === this.last.physical) {
      this.last = { physical: this.last.physical, logical: this.last.logical + 1 };
    } else {
      this.last = { physical: this.last.physical, logical: this.last.logical + 1 };
    }
    return { ...this.last };
  }

  update(received: Hlc, physicalTime: number): Hlc {
    if (physicalTime > this.last.physical && physicalTime > received.physical) {
      this.last = { physical: physicalTime, logical: 0 };
    } else {
      const maxPhysical = Math.max(this.last.physical, received.physical);
      let logical = 0;
      if (maxPhysical === this.last.physical && maxPhysical === received.physical) {
        logical = Math.max(this.last.logical, received.logical) + 1;
      } else if (maxPhysical === this.last.physical) {
        logical = this.last.logical + 1;
      } else {
        logical = received.logical + 1;
      }
      this.last = { physical: maxPhysical, logical };
    }
    return { ...this.last };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/clock.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/clock.ts prototypes/notees-ideal-arch/tests/clock.test.ts
git commit -m "feat(proto): add hybrid logical clock"
```

---

### Task 3: UUIDv7 Helpers

**Files:**
- Create: `prototypes/notees-ideal-arch/src/uuid.ts`
- Test: `prototypes/notees-ideal-arch/tests/uuid.test.ts`

**Interfaces:**
- Produces: `uuidv7(): string` re-exported from `uuidv7` package.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/uuid.test.ts
import { expect, test } from "bun:test";
import { uuidv7 } from "../src/uuid";

test("generates uuidv7 strings", () => {
  const id = uuidv7();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/uuid.test.ts`
Expected: FAIL "uuidv7 is not defined"

- [ ] **Step 3: Implement the helper**

```typescript
// prototypes/notees-ideal-arch/src/uuid.ts
import { uuidv7 as generate } from "uuidv7";

export function uuidv7(): string {
  return generate();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/uuid.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/uuid.ts prototypes/notees-ideal-arch/tests/uuid.test.ts
git commit -m "feat(proto): add uuidv7 helper"
```

---

### Task 4: Operation Schema and Validation

**Files:**
- Create: `prototypes/notees-ideal-arch/src/operation.ts`
- Test: `prototypes/notees-ideal-arch/tests/operation.test.ts`

**Interfaces:**
- Produces: `Operation` type, `createOperation(envelope, payload): Operation`, `validateOperation(op): boolean`.
- Consumes: `Hlc` from `clock.ts`, `uuidv7` from `uuid.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/operation.test.ts
import { expect, test } from "bun:test";
import { createOperation, validateOperation } from "../src/operation";

test("creates and validates a node.create operation", () => {
  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: [],
      opType: "node.create",
    },
    { nodeId: "node-1", kind: "page", parentId: null }
  );
  expect(validateOperation(op)).toBe(true);
  expect(op.envelope.opType).toBe("node.create");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/operation.test.ts`
Expected: FAIL "createOperation is not defined"

- [ ] **Step 3: Implement operation schema**

```typescript
// prototypes/notees-ideal-arch/src/operation.ts
import type { Hlc } from "./clock";
import { uuidv7 } from "./uuid";

export interface OperationEnvelope {
  id: string;
  workspaceId: string;
  actorId: string;
  hlc: Hlc;
  affectedNodeIds: string[];
  opType: string;
}

export interface Operation {
  envelope: OperationEnvelope;
  payload: unknown;
}

const OP_TYPES = new Set([
  "node.create",
  "node.delete",
  "node.move",
  "node.updateContent",
  "class.assign",
  "class.unassign",
  "property.set",
  "property.unset",
  "propertySchema.create",
  "propertySchema.update",
  "class.create",
  "class.update",
]);

export function createOperation(
  partial: Omit<OperationEnvelope, "id">,
  payload: unknown
): Operation {
  return {
    envelope: {
      id: uuidv7(),
      ...partial,
    },
    payload,
  };
}

export function validateOperation(op: Operation): boolean {
  if (!op?.envelope || !op?.payload) return false;
  const env = op.envelope;
  if (!env.id || !env.workspaceId || !env.actorId) return false;
  if (typeof env.hlc?.physical !== "number" || typeof env.hlc?.logical !== "number") return false;
  if (!Array.isArray(env.affectedNodeIds)) return false;
  if (!OP_TYPES.has(env.opType)) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/operation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/operation.ts prototypes/notees-ideal-arch/tests/operation.test.ts
git commit -m "feat(proto): add operation schema and validation"
```

---

### Task 5: SQLite Schema and Connection

**Files:**
- Create: `prototypes/notees-ideal-arch/src/db.ts`
- Test: `prototypes/notees-ideal-arch/tests/db.test.ts`

**Interfaces:**
- Produces: `openDb(path): Database`, `createSchema(db): void`, tables: `operation`, `snapshot`, `compacted_operation_segment`, `node`, `node_child_order`, `property_value`, `edge`, `search_index`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/db.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../src/db";

test("schema creates all required tables", () => {
  const db = new Database(":memory:");
  createSchema(db);
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("operation");
  expect(names).toContain("node");
  expect(names).toContain("node_child_order");
  expect(names).toContain("property_value");
  expect(names).toContain("edge");
  expect(names).toContain("snapshot");
  expect(names).toContain("compacted_operation_segment");
  expect(names).toContain("crdt_state");
  expect(names).toContain("search_index");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/db.test.ts`
Expected: FAIL "createSchema is not defined"

- [ ] **Step 3: Implement schema creation**

```typescript
// prototypes/notees-ideal-arch/src/db.ts
import { Database } from "bun:sqlite";

export function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      hlc_physical INTEGER NOT NULL,
      hlc_logical INTEGER NOT NULL,
      affected_node_ids TEXT NOT NULL,
      op_type TEXT NOT NULL,
      payload BLOB NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_operation_workspace_hlc
    ON operation (workspace_id, hlc_physical, hlc_logical);

    CREATE TABLE IF NOT EXISTS snapshot (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      hlc_physical INTEGER NOT NULL,
      hlc_logical INTEGER NOT NULL,
      state_hash TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS compacted_operation_segment (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      from_hlc_physical INTEGER NOT NULL,
      from_hlc_logical INTEGER NOT NULL,
      to_hlc_physical INTEGER NOT NULL,
      to_hlc_logical INTEGER NOT NULL,
      snapshot_id TEXT NOT NULL,
      operation_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('page', 'block', 'class')),
      class_ids TEXT NOT NULL DEFAULT '[]',
      parent_id TEXT,
      content TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      updated_at TEXT,
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS node_child_order (
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      position TEXT NOT NULL,
      PRIMARY KEY (parent_id, child_id)
    );

    CREATE TABLE IF NOT EXISTS property_value (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      property_schema_id TEXT NOT NULL,
      value TEXT NOT NULL,
      idx INTEGER NOT NULL DEFAULT 0,
      UNIQUE(node_id, property_schema_id, idx)
    );

    CREATE TABLE IF NOT EXISTS edge (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      property_schema_id TEXT,
      metadata TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS crdt_state (
      node_id TEXT PRIMARY KEY,
      text_state BLOB,
      tree_state BLOB
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      node_id UNINDEXED,
      content,
      tokenize='porter unicode61'
    );
  `);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/db.ts prototypes/notees-ideal-arch/tests/db.test.ts
git commit -m "feat(proto): add sqlite schema"
```

---

### Task 6: Derived Node Projection

**Files:**
- Create: `prototypes/notees-ideal-arch/src/derived/node.ts`
- Test: `prototypes/notees-ideal-arch/tests/derived/node.test.ts`

**Interfaces:**
- Produces: `applyNodeOperation(db, op): void` handling `node.create`, `node.delete`, `node.move`, `class.assign`, `class.unassign`.
- Consumes: `Operation` from `operation.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/derived/node.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { applyNodeOperation } from "../../src/derived/node";
import { createOperation } from "../../src/operation";

test("node.create inserts a node row", () => {
  const db = new Database(":memory:");
  createSchema(db);
  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "node.create",
    },
    { nodeId: "node-1", kind: "page", parentId: null, classIds: [] }
  );
  applyNodeOperation(db, op);
  const row = db.query("SELECT kind FROM node WHERE id = ?").get("node-1") as { kind: string };
  expect(row.kind).toBe("page");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/node.test.ts`
Expected: FAIL "applyNodeOperation is not defined"

- [ ] **Step 3: Implement node projection**

```typescript
// prototypes/notees-ideal-arch/src/derived/node.ts
import { Database } from "bun:sqlite";
import type { Operation } from "../operation";

export function applyNodeOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;
  const payload = op.payload as any;

  if (opType === "node.create") {
    db.run(
      `INSERT INTO node (id, workspace_id, kind, class_ids, parent_id, content, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.nodeId,
        op.envelope.workspaceId,
        payload.kind,
        JSON.stringify(payload.classIds ?? []),
        payload.parentId ?? null,
        JSON.stringify(payload.initialContent ?? []),
        new Date().toISOString(),
        new Date().toISOString(),
        op.envelope.actorId,
        op.envelope.actorId,
      ]
    );
  } else if (opType === "node.delete") {
    db.run("DELETE FROM node WHERE id = ?", [payload.nodeId]);
  } else if (opType === "node.move") {
    db.run("UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
      payload.newParentId ?? null,
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId,
    ]);
  } else if (opType === "class.assign") {
    const row = db.query("SELECT class_ids FROM node WHERE id = ?").get(payload.nodeId) as
      | { class_ids: string }
      | undefined;
    if (!row) return;
    const ids = new Set(JSON.parse(row.class_ids));
    ids.add(payload.classId);
    db.run("UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
      JSON.stringify(Array.from(ids)),
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId,
    ]);
  } else if (opType === "class.unassign") {
    const row = db.query("SELECT class_ids FROM node WHERE id = ?").get(payload.nodeId) as
      | { class_ids: string }
      | undefined;
    if (!row) return;
    const ids = new Set(JSON.parse(row.class_ids));
    ids.delete(payload.classId);
    db.run("UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
      JSON.stringify(Array.from(ids)),
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId,
    ]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/node.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/derived/node.ts prototypes/notees-ideal-arch/tests/derived/node.test.ts
git commit -m "feat(proto): add derived node projection"
```

---

### Task 7: CRDT Tree Ordering

**Files:**
- Create: `prototypes/notees-ideal-arch/src/crdt/tree.ts`
- Test: `prototypes/notees-ideal-arch/tests/crdt/tree.test.ts`

**Interfaces:**
- Produces: `TreeCrdt` class with `insert(childId, index)`, `move(childId, index)`, `delete(childId)`, `getState(): Uint8Array`, `applyUpdate(update): void`, `toArray(): string[]`.
- Produces: `treeOperationPayload(parentId, update): object`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/crdt/tree.test.ts
import { expect, test } from "bun:test";
import { TreeCrdt } from "../../src/crdt/tree";

test("tree crdt converges concurrent inserts", () => {
  const t1 = new TreeCrdt();
  t1.insert("a", 0);

  const t2 = new TreeCrdt();
  t2.applyUpdate(t1.getState());
  t2.insert("b", 0);

  t1.applyUpdate(t2.getState());
  expect(t1.toArray()).toContain("a");
  expect(t1.toArray()).toContain("b");
  expect(t1.toArray().length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/crdt/tree.test.ts`
Expected: FAIL "TreeCrdt is not defined"

- [ ] **Step 3: Implement tree CRDT wrapper**

```typescript
// prototypes/notees-ideal-arch/src/crdt/tree.ts
import * as Y from "yjs";

export class TreeCrdt {
  private doc: Y.Doc;
  private arr: Y.Array<string>;

  constructor(state?: Uint8Array) {
    this.doc = new Y.Doc();
    this.arr = this.doc.getArray<string>("children");
    if (state) {
      Y.applyUpdate(this.doc, state);
    }
  }

  insert(childId: string, index: number): void {
    this.arr.insert(index, [childId]);
  }

  move(childId: string, index: number): void {
    const current = this.arr.toArray();
    const oldIndex = current.indexOf(childId);
    if (oldIndex === -1) return;
    this.doc.transact(() => {
      this.arr.delete(oldIndex);
      const newIndex = index > oldIndex ? index - 1 : index;
      this.arr.insert(newIndex, [childId]);
    });
  }

  delete(childId: string): void {
    const current = this.arr.toArray();
    const index = current.indexOf(childId);
    if (index !== -1) this.arr.delete(index);
  }

  toArray(): string[] {
    return this.arr.toArray();
  }

  getState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/crdt/tree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/crdt/tree.ts prototypes/notees-ideal-arch/tests/crdt/tree.test.ts
git commit -m "feat(proto): add yjs-based tree ordering crdt"
```

---

### Task 8: CRDT State Persistence and Derived Child-Order Projection

**Files:**
- Create: `prototypes/notees-ideal-arch/src/derived/crdtState.ts`
- Create: `prototypes/notees-ideal-arch/src/derived/childOrder.ts`
- Test: `prototypes/notees-ideal-arch/tests/derived/childOrder.test.ts`

**Interfaces:**
- Produces: `loadTreeCrdt(db, nodeId): TreeCrdt`, `saveTreeCrdt(db, nodeId, crdt): void`, `loadTextCrdt(db, nodeId): TextCrdt`, `saveTextCrdt(db, nodeId, crdt): void`.
- Produces: `applyChildOrderOperation(db, op): void` handling `node.move` and `node.updateContent` when payload has `treeUpdate`.
- Consumes: `TreeCrdt` from `crdt/tree.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/derived/childOrder.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { TreeCrdt } from "../../src/crdt/tree";
import { applyChildOrderOperation } from "../../src/derived/childOrder";
import { createOperation } from "../../src/operation";

test("applies tree update to node_child_order", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "parent", "ws-1", "page", "[]", "[]",
  ]);

  const tree = new TreeCrdt();
  tree.insert("child-a", 0);
  tree.insert("child-b", 1);

  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["parent"],
      opType: "node.updateContent",
    },
    { nodeId: "parent", treeUpdate: Array.from(tree.getState()) }
  );

  applyChildOrderOperation(db, op);
  const rows = db
    .query("SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position")
    .all("parent") as { child_id: string }[];
  expect(rows.map((r) => r.child_id)).toEqual(["child-a", "child-b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/childOrder.test.ts`
Expected: FAIL "applyChildOrderOperation is not defined"

- [ ] **Step 3: Implement CRDT state persistence and child-order projection**

```typescript
// prototypes/notees-ideal-arch/src/derived/crdtState.ts
import { Database } from "bun:sqlite";
import { TextCrdt } from "../crdt/text";
import { TreeCrdt } from "../crdt/tree";

export function loadTreeCrdt(db: Database, nodeId: string): TreeCrdt {
  const row = db.query("SELECT tree_state FROM crdt_state WHERE node_id = ?").get(nodeId) as
    | { tree_state: Uint8Array }
    | undefined;
  return new TreeCrdt(row?.tree_state);
}

export function saveTreeCrdt(db: Database, nodeId: string, crdt: TreeCrdt): void {
  db.run(
    `INSERT INTO crdt_state (node_id, tree_state) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET tree_state = excluded.tree_state`,
    [nodeId, crdt.getState()]
  );
}

export function loadTextCrdt(db: Database, nodeId: string): TextCrdt {
  const row = db.query("SELECT text_state FROM crdt_state WHERE node_id = ?").get(nodeId) as
    | { text_state: Uint8Array }
    | undefined;
  return new TextCrdt(row?.text_state);
}

export function saveTextCrdt(db: Database, nodeId: string, crdt: TextCrdt): void {
  db.run(
    `INSERT INTO crdt_state (node_id, text_state) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET text_state = excluded.text_state`,
    [nodeId, crdt.getState()]
  );
}
```

```typescript
// prototypes/notees-ideal-arch/src/derived/childOrder.ts
import { Database } from "bun:sqlite";
import { loadTreeCrdt, saveTreeCrdt } from "./crdtState";
import type { Operation } from "../operation";

export function applyChildOrderOperation(db: Database, op: Operation): void {
  const payload = op.payload as any;
  if (!payload.treeUpdate) return;

  const tree = loadTreeCrdt(db, payload.nodeId);
  tree.applyUpdate(Uint8Array.from(payload.treeUpdate));
  saveTreeCrdt(db, payload.nodeId, tree);

  db.run("DELETE FROM node_child_order WHERE parent_id = ?", [payload.nodeId]);
  const stmt = db.prepare(
    "INSERT INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)"
  );
  const children = tree.toArray();
  for (let i = 0; i < children.length; i++) {
    stmt.run(payload.nodeId, children[i], i.toString().padStart(10, "0"));
  }
  stmt.finalize();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/childOrder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/derived/crdtState.ts prototypes/notees-ideal-arch/src/derived/childOrder.ts prototypes/notees-ideal-arch/tests/derived/childOrder.test.ts
git commit -m "feat(proto): add crdt state persistence and child-order projection"
```

---

### Task 9: Rich-Text CRDT Integration

**Files:**
- Create: `prototypes/notees-ideal-arch/src/crdt/text.ts`
- Test: `prototypes/notees-ideal-arch/tests/crdt/text.test.ts`

**Interfaces:**
- Produces: `TextCrdt` class with `insert(index, text)`, `delete(index, length)`, `toPlaintext()`, `getState()`, `applyUpdate(update)`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/crdt/text.test.ts
import { expect, test } from "bun:test";
import { TextCrdt } from "../../src/crdt/text";

test("text crdt converges concurrent edits", () => {
  const t1 = new TextCrdt();
  t1.insert(0, "Hello ");

  const t2 = new TextCrdt();
  t2.applyUpdate(t1.getState());
  t2.insert(6, "world");

  t1.applyUpdate(t2.getState());
  expect(t1.toPlaintext()).toBe("Hello world");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/crdt/text.test.ts`
Expected: FAIL "TextCrdt is not defined"

- [ ] **Step 3: Implement text CRDT wrapper**

```typescript
// prototypes/notees-ideal-arch/src/crdt/text.ts
import * as Y from "yjs";

export class TextCrdt {
  private doc: Y.Doc;
  private text: Y.Text;

  constructor(state?: Uint8Array) {
    this.doc = new Y.Doc();
    this.text = this.doc.getText("content");
    if (state) {
      Y.applyUpdate(this.doc, state);
    }
  }

  insert(index: number, value: string): void {
    this.text.insert(index, value);
  }

  delete(index: number, length: number): void {
    this.text.delete(index, length);
  }

  toPlaintext(): string {
    return this.text.toString();
  }

  getState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/crdt/text.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/crdt/text.ts prototypes/notees-ideal-arch/tests/crdt/text.test.ts
git commit -m "feat(proto): add yjs-based rich-text crdt"
```

---

### Task 10: Content Projection

**Files:**
- Modify: `prototypes/notees-ideal-arch/src/derived/node.ts`
- Test: `prototypes/notees-ideal-arch/tests/derived/content.test.ts`

**Interfaces:**
- Produces: `node.updateContent` handling in `applyNodeOperation` persists the text CRDT state and updates `node.content` plaintext.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/derived/content.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { TextCrdt } from "../../src/crdt/text";
import { applyNodeOperation } from "../../src/derived/node";
import { createOperation } from "../../src/operation";

test("node.updateContent stores plaintext from text crdt", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "block-1", "ws-1", "block", "[]", "[]",
  ]);

  const text = new TextCrdt();
  text.insert(0, "Hello");

  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["block-1"],
      opType: "node.updateContent",
    },
    { nodeId: "block-1", textUpdate: Array.from(text.getState()) }
  );

  applyNodeOperation(db, op);
  const row = db.query("SELECT content FROM node WHERE id = ?").get("block-1") as { content: string };
  expect(JSON.parse(row.content)).toEqual([{ type: "text", text: "Hello" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/content.test.ts`
Expected: FAIL content mismatch (current implementation does not handle textUpdate)

- [ ] **Step 3: Extend node projection for text updates**

Add to the end of `applyNodeOperation` in `src/derived/node.ts`:

```typescript
  } else if (opType === "node.updateContent") {
    if (payload.textUpdate) {
      const text = loadTextCrdt(db, payload.nodeId);
      text.applyUpdate(Uint8Array.from(payload.textUpdate));
      saveTextCrdt(db, payload.nodeId, text);
      const ast = [{ type: "text", text: text.toPlaintext() }];
      db.run("UPDATE node SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
        JSON.stringify(ast),
        new Date().toISOString(),
        op.envelope.actorId,
        payload.nodeId,
      ]);
    }
  }
```

Add import at top of `src/derived/node.ts`:

```typescript
import { loadTextCrdt, saveTextCrdt } from "./crdtState";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/derived/node.ts prototypes/notees-ideal-arch/tests/derived/content.test.ts
git commit -m "feat(proto): add text content projection"
```

---

### Task 11: Property Value Projection

**Files:**
- Create: `prototypes/notees-ideal-arch/src/derived/property.ts`
- Test: `prototypes/notees-ideal-arch/tests/derived/property.test.ts`

**Interfaces:**
- Produces: `applyPropertyOperation(db, op): void` handling `property.set` and `property.unset`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/derived/property.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { applyPropertyOperation } from "../../src/derived/property";
import { createOperation } from "../../src/operation";

test("property.set stores a value", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "active" } }
  );

  applyPropertyOperation(db, op);
  const row = db
    .query("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status") as { value: string };
  expect(JSON.parse(row.value)).toEqual({ value: "active" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/property.test.ts`
Expected: FAIL "applyPropertyOperation is not defined"

- [ ] **Step 3: Implement property projection**

```typescript
// prototypes/notees-ideal-arch/src/derived/property.ts
import { Database } from "bun:sqlite";
import type { Operation } from "../operation";

export function applyPropertyOperation(db: Database, op: Operation): void {
  const payload = op.payload as any;

  if (op.envelope.opType === "property.set") {
    const existing = db
      .query("SELECT id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?")
      .get(payload.nodeId, payload.schemaId, payload.index ?? 0);
    if (existing) {
      db.run(
        "UPDATE property_value SET value = ? WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
        [JSON.stringify(payload.value), payload.nodeId, payload.schemaId, payload.index ?? 0]
      );
    } else {
      db.run(
        "INSERT INTO property_value (id, node_id, property_schema_id, value, idx) VALUES (?, ?, ?, ?, ?)",
        [payload.propertyValueId, payload.nodeId, payload.schemaId, JSON.stringify(payload.value), payload.index ?? 0]
      );
    }
  } else if (op.envelope.opType === "property.unset") {
    db.run("DELETE FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?", [
      payload.nodeId,
      payload.schemaId,
      payload.index ?? 0,
    ]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/property.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/derived/property.ts prototypes/notees-ideal-arch/tests/derived/property.test.ts
git commit -m "feat(proto): add property value projection"
```

---

### Task 12: Edge Projection

**Files:**
- Create: `prototypes/notees-ideal-arch/src/derived/edge.ts`
- Test: `prototypes/notees-ideal-arch/tests/derived/edge.test.ts`

**Interfaces:**
- Produces: `rebuildEdgesForNode(db, nodeId): void` that scans `node.content` for refs and `property_value` for relations and writes `edge` rows.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/derived/edge.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { rebuildEdgesForNode } from "../../src/derived/edge";

test("rebuildEdgesForNode creates edges from content refs", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1",
    "ws-1",
    "page",
    "[]",
    JSON.stringify([{ type: "ref", targetId: "node-2", label: "Two" }]),
  ]);

  rebuildEdgesForNode(db, "node-1");
  const rows = db
    .query("SELECT target_id FROM edge WHERE source_id = ?")
    .all("node-1") as { target_id: string }[];
  expect(rows.map((r) => r.target_id)).toContain("node-2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/edge.test.ts`
Expected: FAIL "rebuildEdgesForNode is not defined"

- [ ] **Step 3: Implement edge projection**

```typescript
// prototypes/notees-ideal-arch/src/derived/edge.ts
import { Database } from "bun:sqlite";
import { uuidv7 } from "../uuid";

export function rebuildEdgesForNode(db: Database, nodeId: string): void {
  const node = db.query("SELECT workspace_id, content FROM node WHERE id = ?").get(nodeId) as
    | { workspace_id: string; content: string }
    | undefined;
  if (!node) return;

  db.run("DELETE FROM edge WHERE source_id = ?", [nodeId]);

  const content = JSON.parse(node.content) as any[];
  const stmt = db.prepare(
    "INSERT INTO edge (id, workspace_id, source_id, target_id, type, property_schema_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (const child of content) {
    if (child.type === "ref" && child.targetId) {
      stmt.run(
        uuidv7(),
        node.workspace_id,
        nodeId,
        child.targetId,
        "reference",
        null,
        JSON.stringify({ label: child.label ?? null }),
        new Date().toISOString()
      );
    }
  }
  stmt.finalize();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/derived/edge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/derived/edge.ts prototypes/notees-ideal-arch/tests/derived/edge.test.ts
git commit -m "feat(proto): add edge projection"
```

---

### Task 13: Workspace Store

**Files:**
- Create: `prototypes/notees-ideal-arch/src/store.ts`
- Test: `prototypes/notees-ideal-arch/tests/store.test.ts`

**Interfaces:**
- Produces: `WorkspaceStore` class with `apply(op): void`, `createNode(...)`, `updateText(...)`, `moveNode(...)`, `setProperty(...)`, `getNode(id)`.
- Consumes: all derived projections, `Clock`, `createOperation`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/store.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";

test("store creates a page with text content", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  store.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  store.updateText("page-1", (t) => t.insert(0, "Title"));
  const node = store.getNode("page-1");
  expect(node.kind).toBe("page");
  expect(JSON.parse(node.content)[0].text).toBe("Title");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/store.test.ts`
Expected: FAIL "WorkspaceStore is not defined"

- [ ] **Step 3: Implement workspace store**

```typescript
// prototypes/notees-ideal-arch/src/store.ts
import { Database } from "bun:sqlite";
import { Clock } from "./clock";
import { TextCrdt } from "./crdt/text";
import { createSchema } from "./db";
import { applyNodeOperation } from "./derived/node";
import { applyChildOrderOperation } from "./derived/childOrder";
import { applyPropertyOperation } from "./derived/property";
import { rebuildEdgesForNode } from "./derived/edge";
import { loadTextCrdt } from "./derived/crdtState";
import { createOperation, type Operation } from "./operation";

export class WorkspaceStore {
  private clock: Clock;

  constructor(
    private db: Database,
    private workspaceId: string,
    private actorId: string
  ) {
    createSchema(db);
    this.clock = new Clock(actorId);
  }

  apply(op: Operation): void {
    const existing = this.db
      .query("SELECT 1 FROM operation WHERE id = ?")
      .get(op.envelope.id);
    if (existing) return;

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO operation (id, workspace_id, actor_id, hlc_physical, hlc_logical, affected_node_ids, op_type, payload, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          op.envelope.id,
          op.envelope.workspaceId,
          op.envelope.actorId,
          op.envelope.hlc.physical,
          op.envelope.hlc.logical,
          JSON.stringify(op.envelope.affectedNodeIds),
          op.envelope.opType,
          JSON.stringify(op.payload),
          new Date().toISOString(),
        ]
      );
      applyNodeOperation(this.db, op);
      applyChildOrderOperation(this.db, op);
      applyPropertyOperation(this.db, op);
      const payload = op.payload as any;
      if (payload?.nodeId) {
        rebuildEdgesForNode(this.db, payload.nodeId);
      }
    })();
  }

  createNode(args: { nodeId: string; kind: "page" | "block" | "class"; parentId: string | null; classIds?: string[] }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType: "node.create",
      },
      { nodeId: args.nodeId, kind: args.kind, parentId: args.parentId, classIds: args.classIds ?? [] }
    );
    this.apply(op);
  }

  updateText(nodeId: string, editor: (text: TextCrdt) => void): void {
    const text = loadTextCrdt(this.db, nodeId);
    editor(text);
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId],
        opType: "node.updateContent",
      },
      { nodeId, textUpdate: Array.from(text.getState()) }
    );
    this.apply(op);
  }

  moveNode(nodeId: string, newParentId: string | null): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [nodeId, newParentId].filter(Boolean),
        opType: "node.move",
      },
      { nodeId, newParentId }
    );
    this.apply(op);
  }

  setProperty(args: { propertyValueId: string; nodeId: string; schemaId: string; index?: number; value: unknown }): void {
    const op = createOperation(
      {
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        hlc: this.clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType: "property.set",
      },
      { propertyValueId: args.propertyValueId, nodeId: args.nodeId, schemaId: args.schemaId, index: args.index ?? 0, value: args.value }
    );
    this.apply(op);
  }

  getNode(id: string): { kind: string; content: string } {
    return this.db.query("SELECT kind, content FROM node WHERE id = ?").get(id) as { kind: string; content: string };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/store.ts prototypes/notees-ideal-arch/tests/store.test.ts
git commit -m "feat(proto): add workspace store"
```

---

### Task 14: Snapshots

**Files:**
- Create: `prototypes/notees-ideal-arch/src/snapshot.ts`
- Test: `prototypes/notees-ideal-arch/tests/snapshot.test.ts`

**Interfaces:**
- Produces: `createSnapshot(db, workspaceId): Promise<Snapshot>`, `loadSnapshotData(data): Database`, `latestSnapshot(db, workspaceId): Snapshot | null`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/snapshot.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSnapshot, loadSnapshotData, latestSnapshot } from "../src/snapshot";

test("snapshot captures and restores derived state", async () => {
  const db1 = new Database(":memory:");
  const store = new WorkspaceStore(db1, "ws-1", "actor-1");
  store.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  store.updateText("page-1", (t) => t.insert(0, "Hello"));

  const snap = await createSnapshot(db1, "ws-1");

  const db2 = loadSnapshotData(snap.data);
  const node = db2.query("SELECT content FROM node WHERE id = ?").get("page-1") as { content: string };
  expect(JSON.parse(node.content)[0].text).toBe("Hello");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/snapshot.test.ts`
Expected: FAIL "createSnapshot is not defined"

- [ ] **Step 3: Implement snapshot create/load**

```typescript
// prototypes/notees-ideal-arch/src/snapshot.ts
import { Database } from "bun:sqlite";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSchema } from "./db";
import { uuidv7 } from "./uuid";

export interface Snapshot {
  id: string;
  workspaceId: string;
  hlcPhysical: number;
  hlcLogical: number;
  stateHash: string;
  data: Uint8Array;
}

export async function createSnapshot(db: Database, workspaceId: string): Promise<Snapshot> {
  const latestOp = db
    .query("SELECT hlc_physical, hlc_logical FROM operation WHERE workspace_id = ? ORDER BY hlc_physical DESC, hlc_logical DESC LIMIT 1")
    .get(workspaceId) as { hlc_physical: number; hlc_logical: number } | undefined;

  const hlcPhysical = latestOp?.hlc_physical ?? 0;
  const hlcLogical = latestOp?.hlc_logical ?? 0;
  const data = db.serialize();
  const stateHash = await sha256(data);
  const id = uuidv7();

  db.run(
    "INSERT INTO snapshot (id, workspace_id, hlc_physical, hlc_logical, state_hash, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, workspaceId, hlcPhysical, hlcLogical, stateHash, data, new Date().toISOString()]
  );

  return { id, workspaceId, hlcPhysical, hlcLogical, stateHash, data };
}

export function latestSnapshot(db: Database, workspaceId: string): Snapshot | null {
  const row = db
    .query("SELECT * FROM snapshot WHERE workspace_id = ? ORDER BY hlc_physical DESC, hlc_logical DESC LIMIT 1")
    .get(workspaceId) as any;
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    hlcPhysical: row.hlc_physical,
    hlcLogical: row.hlc_logical,
    stateHash: row.state_hash,
    data: row.data,
  };
}

export function loadSnapshotData(data: Uint8Array): Database {
  // bun:sqlite can open databases only from file paths, so write the serialized bytes to a temp file.
  const tmpDir = mkdtempSync(join(tmpdir(), "notees-snap-"));
  const tmpPath = join(tmpDir, "state.sqlite");
  writeFileSync(tmpPath, data);
  const db = new Database(tmpPath);
  db.run("PRAGMA journal_mode = MEMORY");
  return db;
}

async function sha256(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/snapshot.ts prototypes/notees-ideal-arch/tests/snapshot.test.ts
git commit -m "feat(proto): add snapshot create and load"
```

---

### Task 15: Compaction Segments

**Files:**
- Create: `prototypes/notees-ideal-arch/src/compaction.ts`
- Test: `prototypes/notees-ideal-arch/tests/compaction.test.ts`

**Interfaces:**
- Produces: `createCompactionSegment(db, workspaceId, snapshotId): CompactionSegment`, `listCompactionSegments(db, workspaceId)`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/compaction.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSnapshot } from "../src/snapshot";
import { createCompactionSegment, listCompactionSegments } from "../src/compaction";

test("compaction segment records operation range", async () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  store.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  store.updateText("page-1", (t) => t.insert(0, "Hello"));

  const snap = await createSnapshot(db, "ws-1");
  const segment = createCompactionSegment(db, "ws-1", snap.id);

  expect(segment.operationCount).toBe(2);
  expect(listCompactionSegments(db, "ws-1").length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/compaction.test.ts`
Expected: FAIL "createCompactionSegment is not defined"

- [ ] **Step 3: Implement compaction**

```typescript
// prototypes/notees-ideal-arch/src/compaction.ts
import { Database } from "bun:sqlite";
import { uuidv7 } from "./uuid";

export interface CompactionSegment {
  id: string;
  workspaceId: string;
  fromHlcPhysical: number;
  fromHlcLogical: number;
  toHlcPhysical: number;
  toHlcLogical: number;
  snapshotId: string;
  operationCount: number;
}

export function createCompactionSegment(db: Database, workspaceId: string, snapshotId: string): CompactionSegment {
  const snap = db
    .query("SELECT hlc_physical, hlc_logical FROM snapshot WHERE id = ?")
    .get(snapshotId) as { hlc_physical: number; hlc_logical: number };

  const firstOp = db
    .query("SELECT hlc_physical, hlc_logical FROM operation WHERE workspace_id = ? ORDER BY hlc_physical ASC, hlc_logical ASC LIMIT 1")
    .get(workspaceId) as { hlc_physical: number; hlc_logical: number } | undefined;

  const countRow = db
    .query(`SELECT COUNT(*) as c FROM operation
            WHERE workspace_id = ?
              AND (hlc_physical < ? OR (hlc_physical = ? AND hlc_logical <= ?))`)
    .get(workspaceId, snap.hlc_physical, snap.hlc_physical, snap.hlc_logical) as { c: number };

  const id = uuidv7();
  const fromHlcPhysical = firstOp?.hlc_physical ?? snap.hlc_physical;
  const fromHlcLogical = firstOp?.hlc_logical ?? snap.hlc_logical;

  db.run(
    `INSERT INTO compacted_operation_segment
     (id, workspace_id, from_hlc_physical, from_hlc_logical, to_hlc_physical, to_hlc_logical, snapshot_id, operation_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      fromHlcPhysical,
      fromHlcLogical,
      snap.hlc_physical,
      snap.hlc_logical,
      snapshotId,
      countRow.c,
      new Date().toISOString(),
    ]
  );

  return {
    id,
    workspaceId,
    fromHlcPhysical,
    fromHlcLogical,
    toHlcPhysical: snap.hlc_physical,
    toHlcLogical: snap.hlc_logical,
    snapshotId,
    operationCount: countRow.c,
  };
}

export function listCompactionSegments(db: Database, workspaceId: string): CompactionSegment[] {
  const rows = db
    .query("SELECT * FROM compacted_operation_segment WHERE workspace_id = ? ORDER BY to_hlc_physical ASC, to_hlc_logical ASC")
    .all(workspaceId) as any[];
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    fromHlcPhysical: r.from_hlc_physical,
    fromHlcLogical: r.from_hlc_logical,
    toHlcPhysical: r.to_hlc_physical,
    toHlcLogical: r.to_hlc_logical,
    snapshotId: r.snapshot_id,
    operationCount: r.operation_count,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/compaction.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/compaction.ts prototypes/notees-ideal-arch/tests/compaction.test.ts
git commit -m "feat(proto): add compaction segment tracking"
```

---

### Task 16: Encrypted Sync Envelopes

**Files:**
- Create: `prototypes/notees-ideal-arch/src/crypto.ts`
- Test: `prototypes/notees-ideal-arch/tests/crypto.test.ts`

**Interfaces:**
- Produces: `deriveKey(password): Promise<CryptoKey>`, `encryptEnvelope(payload, key): Promise<EncryptedEnvelope>`, `decryptEnvelope(envelope, key): Promise<unknown>`.
- Produces: envelope shape `{ ciphertext, iv, affectedNodeIds, opType, hlc }`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/crypto.test.ts
import { expect, test } from "bun:test";
import { deriveKey, encryptEnvelope, decryptEnvelope } from "../src/crypto";

test("round-trips encrypted payload with routing metadata visible", async () => {
  const key = await deriveKey("workspace-secret");
  const payload = { nodeId: "n1", kind: "page" };
  const encrypted = await encryptEnvelope(payload, key, {
    actorId: "actor-1",
    affectedNodeIds: ["n1"],
    opType: "node.create",
    hlc: { physical: 1000, logical: 0 },
  });
  expect(encrypted.actorId).toBe("actor-1");
  expect(encrypted.affectedNodeIds).toEqual(["n1"]);
  expect(encrypted.opType).toBe("node.create");
  expect(encrypted.hlc.physical).toBe(1000);

  const decrypted = await decryptEnvelope(encrypted, key);
  expect(decrypted).toEqual(payload);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/crypto.test.ts`
Expected: FAIL "deriveKey is not defined"

- [ ] **Step 3: Implement envelope encryption**

```typescript
// prototypes/notees-ideal-arch/src/crypto.ts
import type { Hlc } from "./clock";

export interface EncryptedEnvelope {
  ciphertext: string; // base64
  iv: string; // base64
  actorId: string;
  affectedNodeIds: string[];
  opType: string;
  hlc: Hlc;
}

const ENCODER = new TextEncoder();

export async function deriveKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", ENCODER.encode(password), "PBKDF2", false, ["deriveKey"]);
  const salt = ENCODER.encode("notees-ideal-prototype-salt");
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptEnvelope(
  payload: unknown,
  key: CryptoKey,
  metadata: { actorId: string; affectedNodeIds: string[]; opType: string; hlc: Hlc }
): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = ENCODER.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
    actorId: metadata.actorId,
    affectedNodeIds: metadata.affectedNodeIds,
    opType: metadata.opType,
    hlc: metadata.hlc,
  };
}

export async function decryptEnvelope(envelope: EncryptedEnvelope, key: CryptoKey): Promise<unknown> {
  const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/crypto.ts prototypes/notees-ideal-arch/tests/crypto.test.ts
git commit -m "feat(proto): add encrypted sync envelope"
```

---

### Task 17: Mock Sync Relay

**Files:**
- Create: `prototypes/notees-ideal-arch/src/relay.ts`
- Test: `prototypes/notees-ideal-arch/tests/relay.test.ts`

**Interfaces:**
- Produces: `MemoryRelay` class with `send(workspaceId, envelope)`, `subscribe(workspaceId, callback)`, `catchUp(workspaceId, afterHlc): EncryptedEnvelope[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/relay.test.ts
import { expect, test } from "bun:test";
import { MemoryRelay } from "../src/relay";
import type { EncryptedEnvelope } from "../src/crypto";

test("relay broadcasts and catches up envelopes per workspace", () => {
  const relay = new MemoryRelay();
  const seen: EncryptedEnvelope[] = [];
  relay.subscribe("ws-1", (env) => seen.push(env));

  const env: EncryptedEnvelope = {
    ciphertext: "abc",
    iv: "iv",
    actorId: "actor-1",
    affectedNodeIds: ["n1"],
    opType: "node.create",
    hlc: { physical: 1000, logical: 0 },
  };
  relay.send("ws-1", env);
  relay.send("ws-2", env);

  expect(seen.length).toBe(1);
  const caught = relay.catchUp("ws-1", { physical: 0, logical: 0 });
  expect(caught.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/relay.test.ts`
Expected: FAIL "MemoryRelay is not defined"

- [ ] **Step 3: Implement memory relay**

```typescript
// prototypes/notees-ideal-arch/src/relay.ts
import type { EncryptedEnvelope } from "./crypto";
import type { Hlc } from "./clock";

export class MemoryRelay {
  private envelopes = new Map<string, EncryptedEnvelope[]>();
  private subscribers = new Map<string, ((envelope: EncryptedEnvelope) => void)[]>();

  send(workspaceId: string, envelope: EncryptedEnvelope): void {
    const list = this.envelopes.get(workspaceId) ?? [];
    list.push(envelope);
    this.envelopes.set(workspaceId, list);
    const workspaceSubs = this.subscribers.get(workspaceId) ?? [];
    for (const cb of workspaceSubs) cb(envelope);
  }

  subscribe(workspaceId: string, callback: (envelope: EncryptedEnvelope) => void): void {
    const list = this.subscribers.get(workspaceId) ?? [];
    list.push(callback);
    this.subscribers.set(workspaceId, list);
  }

  catchUp(workspaceId: string, afterHlc: Hlc): EncryptedEnvelope[] {
    const list = this.envelopes.get(workspaceId) ?? [];
    return list.filter(
      (env) => env.hlc.physical > afterHlc.physical || (env.hlc.physical === afterHlc.physical && env.hlc.logical > afterHlc.logical)
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/relay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/relay.ts prototypes/notees-ideal-arch/tests/relay.test.ts
git commit -m "feat(proto): add in-memory sync relay"
```

---

### Task 18: Offline → Reconnect Convergence

**Files:**
- Create: `prototypes/notees-ideal-arch/src/sync.ts`
- Test: `prototypes/notees-ideal-arch/tests/sync.test.ts`

**Interfaces:**
- Produces: `SyncEngine` class with `applyLocal(op)`, `pushTo(relay)`, `pullFrom(relay)`.
- Consumes: `WorkspaceStore`, `MemoryRelay`, `deriveKey`, `encryptEnvelope`, `decryptEnvelope`.

- [ ] **Step 1: Write the failing test**

```typescript
// prototypes/notees-ideal-arch/tests/sync.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { MemoryRelay } from "../src/relay";
import { SyncEngine } from "../src/sync";
import { deriveKey } from "../src/crypto";

test("two clients converge after offline edits", async () => {
  const key = await deriveKey("shared-secret");
  const relay = new MemoryRelay();

  const dbA = new Database(":memory:");
  const storeA = new WorkspaceStore(dbA, "ws-1", "actor-a");
  const syncA = new SyncEngine(storeA, "actor-a", key);

  const dbB = new Database(":memory:");
  const storeB = new WorkspaceStore(dbB, "ws-1", "actor-b");
  const syncB = new SyncEngine(storeB, "actor-b", key);

  // Client A creates page offline.
  storeA.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  storeA.updateText("page-1", (t) => t.insert(0, "A"));

  // Client B creates page offline.
  storeB.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  storeB.updateText("page-1", (t) => t.insert(0, "B"));

  // Sync both ways through relay.
  await syncA.pushTo(relay);
  await syncB.pullFrom(relay);
  await syncB.pushTo(relay);
  await syncA.pullFrom(relay);

  const nodeA = storeA.getNode("page-1");
  const nodeB = storeB.getNode("page-1");
  expect(nodeA.content).toBe(nodeB.content);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd prototypes/notees-ideal-arch && bun test tests/sync.test.ts`
Expected: FAIL "SyncEngine is not defined"

- [ ] **Step 3: Implement sync engine**

```typescript
// prototypes/notees-ideal-arch/src/sync.ts
import type { WorkspaceStore } from "./store";
import type { MemoryRelay } from "./relay";
import type { EncryptedEnvelope } from "./crypto";
import { decryptEnvelope, encryptEnvelope } from "./crypto";
import type { Operation } from "./operation";
import { createOperation } from "./operation";
import type { Database } from "bun:sqlite";

export class SyncEngine {
  constructor(
    private store: WorkspaceStore,
    private actorId: string,
    private key: CryptoKey
  ) {}

  async pushTo(relay: MemoryRelay): Promise<void> {
    const db = (this.store as any).db as Database;
    const rows = db
      .query("SELECT * FROM operation ORDER BY hlc_physical ASC, hlc_logical ASC")
      .all() as any[];
    for (const row of rows) {
      const op: Operation = {
        envelope: {
          id: row.id,
          workspaceId: row.workspace_id,
          actorId: row.actor_id,
          hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
          affectedNodeIds: JSON.parse(row.affected_node_ids),
          opType: row.op_type,
        },
        payload: JSON.parse(row.payload),
      };
      const encrypted = await encryptEnvelope(op.payload, this.key, {
        actorId: op.envelope.actorId,
        affectedNodeIds: op.envelope.affectedNodeIds,
        opType: op.envelope.opType,
        hlc: op.envelope.hlc,
      });
      relay.send(row.workspace_id, encrypted);
    }
  }

  async pullFrom(relay: MemoryRelay): Promise<void> {
    const db = (this.store as any).db as Database;
    const lastOp = db
      .query("SELECT hlc_physical, hlc_logical FROM operation ORDER BY hlc_physical DESC, hlc_logical DESC LIMIT 1")
      .get() as { hlc_physical: number; hlc_logical: number } | undefined;
    const afterHlc = lastOp ?? { physical: 0, logical: 0 };
    const workspaceId = (this.store as any).workspaceId as string;
    const envelopes = relay.catchUp(workspaceId, afterHlc);
    for (const env of envelopes) {
      const payload = await decryptEnvelope(env, this.key);
      const op = createOperation(
        {
          workspaceId,
          actorId: env.actorId,
          hlc: env.hlc,
          affectedNodeIds: env.affectedNodeIds,
          opType: env.opType,
        },
        payload
      );
      this.store.apply(op);
    }
  }
}
```

Note: This simple engine does not handle duplicate operations or HLC merging on receive. For the prototype it demonstrates convergence for distinct operations. Add a duplicate check in `store.apply` if needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prototypes/notees-ideal-arch/src/sync.ts prototypes/notees-ideal-arch/tests/sync.test.ts
git commit -m "feat(proto): add offline-to-online sync engine"
```

---

### Task 19: Full Vertical Slice Integration Test

**Files:**
- Create: `prototypes/notees-ideal-arch/tests/integration.test.ts`

**Interfaces:**
- Produces: end-to-end test exercising create, edit, snapshot, compaction, sync, and convergence.

- [ ] **Step 1: Write the integration test**

```typescript
// prototypes/notees-ideal-arch/tests/integration.test.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSnapshot } from "../src/snapshot";
import { createCompactionSegment } from "../src/compaction";
import { SyncEngine } from "../src/sync";
import { MemoryRelay } from "../src/relay";
import { deriveKey } from "../src/crypto";

test("full vertical slice: create, snapshot, compact, sync, converge", async () => {
  const key = await deriveKey("slice-secret");
  const relay = new MemoryRelay();

  const dbA = new Database(":memory:");
  const storeA = new WorkspaceStore(dbA, "ws-1", "actor-a");
  storeA.createNode({ nodeId: "root", kind: "page", parentId: null });
  storeA.createNode({ nodeId: "child", kind: "block", parentId: "root" });
  storeA.updateText("child", (t) => t.insert(0, "Hello world"));
  storeA.setProperty({ propertyValueId: "pv-1", nodeId: "root", schemaId: "status", value: { value: "active" } });

  const snap = await createSnapshot(dbA, "ws-1");
  const segment = createCompactionSegment(dbA, "ws-1", snap.id);
  expect(segment.operationCount).toBeGreaterThan(0);

  const syncA = new SyncEngine(storeA, "actor-a", key);
  await syncA.pushTo(relay);

  const dbB = new Database(":memory:");
  const storeB = new WorkspaceStore(dbB, "ws-1", "actor-b");
  const syncB = new SyncEngine(storeB, "actor-b", key);
  await syncB.pullFrom(relay);

  const nodeA = storeA.getNode("child");
  const nodeB = storeB.getNode("child");
  expect(JSON.parse(nodeA.content)[0].text).toBe("Hello world");
  expect(nodeA.content).toBe(nodeB.content);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd prototypes/notees-ideal-arch && bun test tests/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd prototypes/notees-ideal-arch && bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add prototypes/notees-ideal-arch/tests/integration.test.ts
git commit -m "test(proto): add full vertical slice integration test"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Task(s) |
|---|---|
| Operation log + HLC | Task 2, 4 |
| Operation envelope (`affectedNodeIds`) | Task 4, 16 |
| Derived tables (`node`, `node_child_order`, `property_value`, `edge`) | Task 6, 8, 11, 12 |
| CRDT tree/text | Task 7, 9 |
| Snapshots | Task 14 |
| Compaction | Task 15 |
| Encrypted sync | Task 16, 17, 18 |
| Offline→online convergence | Task 18, 19 |

**Gaps:**
- Search index population is not implemented in the slice (schema exists but no population logic).
- Class/property schema operations are not fully wired; only `property.set` is demonstrated.
- Plugin extensibility, whiteboard, computed properties, graph view, publishing, and AI API are out of scope for this vertical slice and will be covered in later plans.

### 2. Placeholder scan

No placeholders such as "TBD", "TODO", or vague "handle edge cases" remain. Each step has concrete code, commands, and expected output.

### 3. Type consistency

- `Hlc` is used consistently across clock, operation, crypto, relay, and sync.
- `Operation` shape matches between `operation.ts`, `store.ts`, and `sync.ts`.
- `EncryptedEnvelope` shape matches between `crypto.ts`, `relay.ts`, and `sync.ts`.

---

## Known Risk Areas

| Task | Risk |
|---|---|
| 7–8 | Yjs tree ordering semantics around moves and concurrent inserts. |
| 10 | Text CRDT state persistence round-tripping formatting/structural edits. |
| 14 | Snapshot serialization edge cases with `bun:sqlite` serialize/deserialize. |
| 15 | HLC range comparisons; fixed in this plan with lexicographic SQL. |
| 18 | Duplicate suppression and replay ordering across reconnects. |
| 19 | True convergence under interleaved concurrent edits. |

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-17-notees-ideal-arch-vertical-slice.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach would you like?