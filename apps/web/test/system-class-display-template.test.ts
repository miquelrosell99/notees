/**
 * The class displayTemplate seed/deploy convergence — the citekey-centric
 * Task 3 slice over the Task-1 payload + derived column (store schema v36,
 * the `class` registry table ONLY — the node row is not a carrier) and the
 * Task-2 seed manifest (SYSTEM_CLASS_DISPLAY_TEMPLATES: `source` ships
 * "@{{citekey}}", the seven media-type classes opt out explicitly with "",
 * every other roster class is absent = inherit through extends).
 *
 * Pins:
 *
 *  - `client.createClass(name, { displayTemplate })` passes the option through
 *    to the class.create payload — a non-empty string AND the "" opt-out
 *    ("" is a real value, not absence) — after the write-time placeholder
 *    validation resolves the names against the schemas available to the class;
 *  - the SCHEMA.md write-time MUST: an unknown, ineligible, or empty
 *    placeholder fails loud on BOTH write paths and emits NO op;
 *  - `client.updateClassDisplayTemplate(classId, template)` presence-writes a
 *    string and present-null clears back to NULL;
 *  - `deploySystemClass` converges an EXISTING class whose display_template
 *    is NULL (including the "" opt-out), NEVER overwrites a non-NULL
 *    (user-set) column, and under the WorkerClient decides on a FRESH read —
 *    a cold render cache seeds null (the exact "never set" sentinel), which
 *    would clobber a user-set template on a cold deploy.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { DisplayTemplateError, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkerClient } from "../src/core/worker-client.js";
import { WorkspaceClient } from "../src/core/workspace-client/index.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];
const workerClients: WorkerClient[] = [];

afterEach(async () => {
  // Let a worker client's in-flight cache refresh drain before closing —
  // a closed client rejects the drain's multiRead and logs a loud error.
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  while (workerClients.length > 0) workerClients.pop()!.close();
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("class displayTemplate client writes (registry column, store v36)", () => {
  it("createClass passes displayTemplate through — string AND the '' opt-out", async () => {
    const client = await seedClient();
    // The write-time validation resolves placeholders against the schemas
    // available to the class — seed a global "Citekey" so "@{{citekey}}" is
    // eligible (matched case-insensitively).
    await client.createPropertySchema({ name: "Citekey", type: "text" });
    const libraryId = await client.createClass("Library", { displayTemplate: "@{{citekey}}" });
    const coverId = await client.createClass("Cover art", { displayTemplate: "" });
    const plainId = await client.createClass("Plain", {});
    await flushSync();

    expect(client.getClassDisplayTemplate(libraryId)).toBe("@{{citekey}}");
    expect(client.getClassDisplayTemplate(coverId)).toBe("");
    expect(client.getClassDisplayTemplate(plainId)).toBeNull();
  });

  it("updateClassDisplayTemplate presence-writes a string and present-null clears", async () => {
    const client = await seedClient();
    // The write-time placeholder validation resolves names against the
    // schemas available to the class — a global "Citekey" schema makes the
    // "@{{citekey}}" template eligible (case-insensitively).
    await client.createPropertySchema({ name: "Citekey", type: "text" });
    const id = await client.createClass("Source-like");
    await flushSync();
    expect(client.getClassDisplayTemplate(id)).toBeNull();

    await client.updateClassDisplayTemplate(id, "@{{citekey}}");
    await flushSync();
    expect(client.getClassDisplayTemplate(id)).toBe("@{{citekey}}");

    await client.updateClassDisplayTemplate(id, "");
    await flushSync();
    expect(client.getClassDisplayTemplate(id)).toBe("");

    await client.updateClassDisplayTemplate(id, null);
    await flushSync();
    expect(client.getClassDisplayTemplate(id)).toBeNull();
  });
});

describe("deploySystemClass displayTemplate convergence", () => {
  it("passes the manifest entry on create — `source` template, `book` '' opt-out", async () => {
    const client = await seedClient();
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");
    // book is archived-by-default: deploying it is the gallery's enable pick —
    // its parent `source` deploys first.
    await deploySystemClass(client, "book");
    await flushSync();

    expect(client.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source)).toBe("@{{citekey}}");
    expect(client.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.book)).toBe("");
    // An absent roster member stays NULL (inherits through extends at read).
    expect(client.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.book_section)).toBeNull();
  });

  it("converges an existing NULL column (incl. '') and never overwrites a user-set value", async () => {
    const client = await seedClient();
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");

    // A pre-existing class node with NO display_template (a workspace seeded
    // before the manifest existed).
    await client.createClass("Source", { id: SYSTEM_CLASS_UUIDS.source });
    await flushSync();
    expect(client.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source)).toBeNull();

    await deploySystemClass(client, "source");
    await flushSync();
    // NULL → the manifest value lands.
    expect(client.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source)).toBe("@{{citekey}}");

    // A user-set value is NEVER overwritten: neither a template nor an
    // explicit user opt-out.
    await client.updateClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source, "user template");
    await flushSync();
    await deploySystemClass(client, "source");
    await flushSync();
    expect(client.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source)).toBe("user template");

    await client.updateClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source, "");
    await flushSync();
    await deploySystemClass(client, "source");
    await flushSync();
    expect(client.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source)).toBe("");
  });
});


describe("displayTemplate write-time placeholder validation (SCHEMA.md MUST)", () => {
  it("createClass fails loud on an unknown placeholder and emits NO op", async () => {
    const client = await seedClient();
    await expect(
      client.createClass("Library", { displayTemplate: "@{{citeke}}" }),
    ).rejects.toThrow(DisplayTemplateError);
    await flushSync();
    // No envelope reached the log: the class does not exist.
    expect(client.listClasses()).toEqual([]);
  });

  it("createClass fails loud on an empty placeholder", async () => {
    const client = await seedClient();
    await expect(
      client.createClass("Library", { displayTemplate: "{{}}" }),
    ).rejects.toThrow(DisplayTemplateError);
    await flushSync();
    expect(client.listClasses()).toEqual([]);
  });

  it("createClass passes a template naming an available schema — case-insensitively", async () => {
    const client = await seedClient();
    await client.createPropertySchema({ name: "Citekey", type: "text" });
    const id = await client.createClass("Library", { displayTemplate: "@{{citekey}}" });
    await flushSync();
    expect(client.getClassDisplayTemplate(id)).toBe("@{{citekey}}");
  });

  it("createClass rejects a placeholder scoped to a DIFFERENT class", async () => {
    const client = await seedClient();
    const otherId = await client.createClass("Other");
    await client.createPropertySchema({
      name: "Citekey",
      type: "text",
      scopeClassIds: [otherId],
    });
    await expect(
      client.createClass("Library", { displayTemplate: "@{{citekey}}" }),
    ).rejects.toThrow(DisplayTemplateError);
    await flushSync();
    expect(client.listClasses().map((klass) => klass.id)).toEqual([otherId]);
  });

  it("updateClassDisplayTemplate fails loud on an unknown placeholder, leaving the column unchanged", async () => {
    const client = await seedClient();
    await client.createPropertySchema({ name: "Citekey", type: "text" });
    const id = await client.createClass("Library", { displayTemplate: "@{{citekey}}" });
    await flushSync();

    await expect(client.updateClassDisplayTemplate(id, "{{nope}}")).rejects.toThrow(
      DisplayTemplateError,
    );
    await flushSync();
    // The rejected write emitted no op: the column keeps the prior value.
    expect(client.getClassDisplayTemplate(id)).toBe("@{{citekey}}");
  });

  it("updateClassDisplayTemplate accepts a schema scoped to an extends-ancestor", async () => {
    const client = await seedClient();
    const base = await client.createClass("Base");
    await client.createPropertySchema({ name: "Citekey", type: "text", scopeClassIds: [base] });
    const child = await client.createClass("Child");
    await client.setClassExtends(child, [base]);
    await flushSync();

    await client.updateClassDisplayTemplate(child, "@{{citekey}}");
    await flushSync();
    expect(client.getClassDisplayTemplate(child)).toBe("@{{citekey}}");
  });
});

/**
 * A fake worker fronting a REAL in-process WorkspaceClient: the worker RPC
 * protocol (init / multiRead / changed) over a store the test can inspect
 * directly. Write methods post a coalesced-style "changed" (structural) so
 * the WorkerClient's read cache converges exactly like the real worker.
 */
function storeWorker(inner: WorkspaceClient): Worker {
  const listeners: Array<(event: MessageEvent) => void> = [];
  let revision = 0;
  const WRITE_METHODS = new Set([
    "createClass",
    "updateClassDisplayTemplate",
    "updateObject",
    "setClassProperty",
    "unsetClassProperty",
    "createPropertySchema",
    "updatePropertySchema",
    "setClassExtends",
    "setFeatureEnabled",
  ]);
  const dispatch = (method: string, args: unknown[]): unknown => {
    const fn = (inner as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== "function") throw new Error(`no such method: ${method}`);
    return fn.apply(inner, args);
  };
  const post = (message: unknown): void => {
    for (const listener of listeners) listener({ data: message } as MessageEvent);
  };
  const worker = {
    postMessage(message: { id: number; method: string; args: unknown[] }) {
      void (async () => {
        try {
          let result: unknown;
          if (message.method === "init") {
            result = null;
          } else if (message.method === "multiRead") {
            result = (message.args[0] as string[]).map((key) => {
              const [method, args] = JSON.parse(key) as [string, unknown[]];
              return dispatch(method, args);
            });
          } else {
            result = await dispatch(message.method, message.args);
          }
          post({ id: message.id, result });
          if (WRITE_METHODS.has(message.method)) {
            post({ type: "changed", revision: ++revision, structural: true });
          }
        } catch (error) {
          post({
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    terminate() {},
  };
  Object.defineProperty(worker, "onmessage", {
    set(listener: (event: MessageEvent) => void) {
      listeners.length = 0;
      listeners.push(listener);
    },
  });
  return worker as unknown as Worker;
}

describe("deploySystemClass under the WorkerClient (cold render cache)", () => {
  async function seedWorkerClient(): Promise<{ inner: WorkspaceClient; client: WorkerClient }> {
    const inner = await seedClient();
    const client = await WorkerClient.create({
      serverUrl: "http://localhost:8377",
      apiKey: "test-key",
      workspaceId: WS,
      sqlWasmUrl: "/sql-wasm.wasm",
      spawn: () => storeWorker(inner),
    });
    workerClients.push(client);
    return { inner, client };
  }

  it("a user-set template survives a deploy — the fresh read beats the cold null cache", async () => {
    const { inner, client } = await seedWorkerClient();
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");

    await client.createClass("Source", { id: SYSTEM_CLASS_UUIDS.source });
    // Prime ONLY the node-existence read. The displayTemplate cache key
    // stays cold — its cached default (null) is exactly what the OLD
    // cached-read code decided the NULL-only convergence on.
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.source)).toBeUndefined();
    await vi.waitFor(() => {
      expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.source)).toBeDefined();
    });

    await client.updateClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source, "user template");
    await deploySystemClass(client, "source");
    await flushSync();

    expect(inner.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source)).toBe("user template");
  });

  it("a NULL column still converges under the WorkerClient (the fresh read returns null)", async () => {
    const { inner, client } = await seedWorkerClient();
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");

    await client.createClass("Source", { id: SYSTEM_CLASS_UUIDS.source });
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.source)).toBeUndefined();
    await vi.waitFor(() => {
      expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.source)).toBeDefined();
    });

    await deploySystemClass(client, "source");
    await flushSync();
    expect(inner.getClassDisplayTemplate(SYSTEM_CLASS_UUIDS.source)).toBe("@{{citekey}}");
  });
});
