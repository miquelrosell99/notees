/**
 * calendarRecurrence ops tests — the Google-calendar semantics (owner
 * 2026-10-23): deleting/editing ONE occurrence of a recurring event per
 * the scope ("one" / "following" / "all"). The exception state is additive
 * date-value metadata (exdates / until); the calendar read model
 * (eventRowsForDays) honors it, so the specs assert through both the raw
 * metadata and the read model.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { eventRowsForDays, recurringRowsOf } from "../src/features/calendar/calendarRows.js";
import {
  deleteOccurrence,
  editOccurrence,
} from "../src/features/calendar/calendarRecurrence.js";

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

function seedEnvelope(
  opType: string,
  payload: Record<string, unknown>,
  affected: string[],
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device",
    client: "seed",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

async function seedClient(): Promise<WorkspaceClient> {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.event, contentAst: [{ type: "text", text: "event" }] },
      [SYSTEM_CLASS_UUIDS.event],
    ),
  ]);
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** A weekly event anchored on the given day. */
async function createWeekly(
  client: WorkspaceClient,
  name: string,
  anchorIso: string,
): Promise<string> {
  const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.event, schemaId, {});
  const id = await client.createObject({
    isEmbedded: false,
    name,
    classIds: [SYSTEM_CLASS_UUIDS.event],
  });
  // The date value references the day node — the chain must exist first
  // (the date-ref contract property.set enforces).
  await client.ensureDateChain(anchorIso);
  await client.setProperty(id, schemaId, { nodeId: `00000000-0000-0000-00dd-${anchorIso.replace(/-/g, "")}0000` }, 0, {
    repeat: "weekly",
  });
  return id;
}

/** The driving date row of a node (the series carrier). */
function dateRowOf(client: WorkspaceClient, nodeId: string) {
  return client
    .getEffectiveProperties(nodeId)
    .find((prop) => prop.schema?.type === "datetime" && prop.source === "authored");
}

/** The event row ids for one scope day (recurring union included). */
function eventIdsOf(client: WorkspaceClient, iso: string): string[] {
  return eventRowsForDays(client, [iso], recurringRowsOf(client)).map((row) => row.node.id);
}

describe("deleteOccurrence", () => {
  it("'one' exdates just that day; the node and the other occurrences live", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");
    const d2 = "2026-10-12";

    await deleteOccurrence(client, id, d2, "one");

    expect(eventIdsOf(client, "2026-10-05")).toContain(id);
    expect(eventIdsOf(client, d2)).not.toContain(id);
    expect(eventIdsOf(client, "2026-10-19")).toContain(id);
    expect(client.getNode(id)).toBeDefined(); // trash never touched
    expect(dateRowOf(client, id)?.metadata).toMatchObject({ repeat: "weekly", exdates: [d2] });
  });

  it("'following' truncates at the previous occurrence; earlier ones live", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");
    const d3 = "2026-10-19";

    await deleteOccurrence(client, id, d3, "following");

    expect(eventIdsOf(client, "2026-10-05")).toContain(id);
    expect(eventIdsOf(client, "2026-10-12")).toContain(id);
    expect(eventIdsOf(client, d3)).not.toContain(id);
    expect(eventIdsOf(client, "2026-10-26")).not.toContain(id);
    expect(dateRowOf(client, id)?.metadata).toMatchObject({ repeat: "weekly", until: "2026-10-12" });
  });

  it("'following' on the anchor degenerates to 'all' (the node trashes)", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");

    await deleteOccurrence(client, id, "2026-10-05", "following");

    expect(client.getNode(id)).toBeUndefined();
  });

  it("'all' trashes the node", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");

    await deleteOccurrence(client, id, "2026-10-12", "all");

    expect(client.getNode(id)).toBeUndefined();
    expect(eventIdsOf(client, "2026-10-05")).not.toContain(id);
  });
});

describe("editOccurrence", () => {
  it("'all' moves the series anchor on the same node, rule preserved", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");

    const created = await editOccurrence(client, id, "2026-10-12", "all", { toIso: "2026-11-02" });

    expect(created).toBeNull();
    const row = dateRowOf(client, id);
    expect(row?.value).toEqual({ nodeId: "00000000-0000-0000-00dd-202611020000" });
    expect(row?.metadata).toMatchObject({ repeat: "weekly" });
    // The series moved wholesale: the old anchor day no longer occurs.
    expect(eventIdsOf(client, "2026-10-05")).not.toContain(id);
    expect(eventIdsOf(client, "2026-11-02")).toContain(id);
    expect(eventIdsOf(client, "2026-11-09")).toContain(id);
  });

  it("'one' detaches an ordinary exception and exdates the original day", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");

    const exceptionId = (await editOccurrence(client, id, "2026-10-12", "one", {
      toIso: "2026-10-14",
    }))!;

    expect(exceptionId).not.toBe(id);
    const exception = client.getNode(exceptionId)!;
    expect(exception.classIds).toContain(SYSTEM_CLASS_UUIDS.event);
    // The exception is plain (no rule): its own edits never re-open the dialog.
    expect(dateRowOf(client, exceptionId)?.metadata ?? null).toBeNull();
    expect(dateRowOf(client, exceptionId)?.value).toEqual({
      nodeId: "00000000-0000-0000-00dd-202610140000",
    });
    // The series skips the edited day and keeps the surrounding occurrences.
    expect(dateRowOf(client, id)?.metadata).toMatchObject({
      repeat: "weekly",
      exdates: ["2026-10-12"],
    });
    expect(eventIdsOf(client, "2026-10-05")).toContain(id);
    expect(eventIdsOf(client, "2026-10-12")).toEqual([]); // the day joined exdates
    expect(eventIdsOf(client, "2026-10-14")).toContain(exceptionId);
    expect(eventIdsOf(client, "2026-10-19")).toContain(id);
  });

  it("'following' splits: the original truncates, the continuation carries the rule forward", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");

    const continuationId = (await editOccurrence(client, id, "2026-10-19", "following", {
      toIso: "2026-10-21",
    }))!;

    expect(continuationId).not.toBe(id);
    // Original: bounded at the last occurrence before the split day.
    expect(dateRowOf(client, id)?.metadata).toMatchObject({ repeat: "weekly", until: "2026-10-12" });
    expect(eventIdsOf(client, "2026-10-05")).toContain(id);
    expect(eventIdsOf(client, "2026-10-19")).not.toContain(id);
    // Continuation: same rule, new anchor, occurrences from the new day.
    const continuation = dateRowOf(client, continuationId);
    expect(continuation?.metadata).toMatchObject({ repeat: "weekly" });
    expect("until" in (continuation?.metadata ?? {})).toBe(false);
    expect(continuation?.value).toEqual({
      nodeId: "00000000-0000-0000-00dd-202610210000",
    });
    expect(eventIdsOf(client, "2026-10-19")).toEqual([]);
    expect(eventIdsOf(client, "2026-10-21")).toContain(continuationId);
    expect(eventIdsOf(client, "2026-10-28")).toContain(continuationId);
  });

  it("'following' on the anchor degenerates to 'all' (no split)", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");

    const created = await editOccurrence(client, id, "2026-10-05", "following", {
      toIso: "2026-10-06",
    });

    expect(created).toBeNull();
    const row = dateRowOf(client, id);
    expect(row?.value).toEqual({ nodeId: "00000000-0000-0000-00dd-202610060000" });
    expect(row?.metadata).toMatchObject({ repeat: "weekly" });
  });

  it("a single deleted occurrence and an edited exception compose on the read model", async () => {
    const client = await seedClient();
    const id = await createWeekly(client, "Standup", "2026-10-05");

    await deleteOccurrence(client, id, "2026-10-12", "one");
    const exceptionId = (await editOccurrence(client, id, "2026-10-19", "one", {
      toIso: "2026-10-20",
    }))!;

    expect(eventIdsOf(client, "2026-10-05")).toContain(id);
    expect(eventIdsOf(client, "2026-10-12")).toEqual([]);
    expect(eventIdsOf(client, "2026-10-19")).toEqual([]);
    expect(eventIdsOf(client, "2026-10-20")).toContain(exceptionId);
    expect(eventIdsOf(client, "2026-10-26")).toContain(id);
    expect(dateRowOf(client, id)?.metadata).toMatchObject({
      repeat: "weekly",
      exdates: ["2026-10-12", "2026-10-19"],
    });
  });
});
