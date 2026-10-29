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
 *    ("" is a real value, not absence);
 *  - `client.updateClassDisplayTemplate(classId, template)` presence-writes a
 *    string and present-null clears back to NULL;
 *  - `deploySystemClass` passes the manifest entry on CREATE, converges an
 *    EXISTING class whose display_template is NULL (including the "" opt-out),
 *    and NEVER overwrites a non-NULL (user-set) column.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
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
