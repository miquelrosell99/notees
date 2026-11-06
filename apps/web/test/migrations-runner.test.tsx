/**
 * F3 — the client-side content-migration runner (the web half of the
 * proving pattern). A pending content-class migration on the OPEN workspace
 * lists through each core's `isPending(localStore)`; the dry-run shows the
 * planner's report (counts + the conflict rows); Run commits the envelopes
 * through the client's normal write path — the local UNSEALED store
 * converges and, on a keyed workspace, the pushed ops ride the wire SEALED
 * with the CLIENT SESSION's actor/device constants (no new crypto, no wire
 * change: the sync engine seals what the single enqueue seam accepted).
 * A converged workspace lists nothing (the surface renders empty); an
 * unkeyed workspace lists a pending migration with the hint that the
 * server-side scripts can also run it. jsdom over the in-process
 * WorkspaceClient + MemoryTransport/MemoryRelay harness.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { isEncryptedPayload, newEnvelope } from "@notees/protocol";
import { chainNodeIds, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { MigrationsSection } from "../src/features/settings/MigrationsSection.js";
import {
  MEETING_DATE_ID,
  MIGRATION_IDENTITY,
} from "../../../vendor/notees/scripts/lib/migrations/meeting-date-retirement.ts";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const DEVICE = "migrations-runner-test-device";
const KEY = new Uint8Array(32).fill(0x42);

const MEETING_ID = SYSTEM_CLASS_UUIDS.meeting;
const EVENT_DATE_ID = SYSTEM_PROPERTY_UUIDS.eventDate;

const MEETING_NODE = "0192a000-0000-7000-8000-00000000e101";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function createClient(relay: MemoryRelay, workspaceKey?: Uint8Array): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    deviceId: DEVICE,
    client: "migrations-runner-test",
    sqlJs: sqlModule,
    ...(workspaceKey !== undefined ? { workspaceKey } : {}),
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/**
 * Stage the pre-retirement state through the client's own write path: the
 * event root carries the eventDate schema, the meeting subclass (extends
 * event) carries the withdrawn meetingDate schema + binding, and one
 * meeting node holds a meetingDate value whose date chain exists (the PG6
 * target-existence rule).
 */
async function stagePendingMeetingDate(client: WorkspaceClient): Promise<void> {
  const EVENT_ID = SYSTEM_CLASS_UUIDS.event;
  if (client.getNodeRaw(EVENT_ID) === undefined) {
    await client.createClass("Event", { id: EVENT_ID });
  }
  if (client.listPropertySchemas().every((schema) => schema.id !== EVENT_DATE_ID)) {
    await client.createPropertySchema({
      id: EVENT_DATE_ID,
      name: "Event date",
      type: "datetime",
      scopeClassIds: [EVENT_ID],
    });
  }
  await client.setClassProperty(EVENT_ID, EVENT_DATE_ID, {});
  if (client.getNodeRaw(MEETING_ID) === undefined) {
    await client.createClass("Meeting", { id: MEETING_ID });
    await client.setClassExtends(MEETING_ID, [EVENT_ID]);
  }
  if (client.listPropertySchemas().every((schema) => schema.id !== MEETING_DATE_ID)) {
    await client.createPropertySchema({
      id: MEETING_DATE_ID,
      name: "Meeting date",
      type: "datetime",
      scopeClassIds: [MEETING_ID],
    });
  }
  await client.setClassProperty(MEETING_ID, MEETING_DATE_ID, {});
  await client.createObject({
    id: MEETING_NODE,
    name: "Weekly sync",
    isEmbedded: false,
    classIds: [MEETING_ID],
  });
  const chain = await client.ensureDateChain("2026-07-01");
  await client.setProperty(MEETING_NODE, MEETING_DATE_ID, { nodeId: chain.day }, 0);
}

const valuesOf = (client: WorkspaceClient, nodeId: string, schemaId: string): unknown[] =>
  (
    client.store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id",
      )
      .all(nodeId, schemaId) as Array<{ value: string }>
  ).map((row) => JSON.parse(row.value));

async function flushUi(): Promise<void> {
  await act(async () => {});
}

describe("the client-side migrations runner (F3)", () => {
  it("a pending KEYED workspace lists the migration; dry-run shows the report; Run converges the local store and the pushed ops ride the normal write path SEALED", async () => {
    const relay = new MemoryRelay();
    const client = await createClient(relay, KEY);
    await stagePendingMeetingDate(client);
    await client.push();
    // The relay watermark after staging: every envelope appended by the run
    // rides after it.
    const watermark = relay.envelopes().length;

    // The session constants are the client's, NOT the CLI migration identity.
    expect(client.isKeyedWorkspace()).toBe(true);

    // --- the listing pin ---
    const pending = client.listPendingMigrations();
    expect(pending.map((report) => report.id)).toEqual(["meeting-date-retirement"]);
    const report = pending[0]!;
    expect(report.counts).toContainEqual(["values copied to Event date", 1]);
    expect(report.opCount).toBe(4); // copy + removal + binding unset + schema delete

    // --- the surface + dry-run-first flow ---
    const view = render(<MigrationsSection client={client} />);
    expect(await screen.findByText("Meeting-date retirement")).not.toBeNull();
    expect(screen.queryByText(/not keyed/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /review & run/i }));
    await flushUi();
    // The dry-run report: the op count, the counts, no conflicts staged here.
    expect(screen.getByText(/commits 4 operation/)).not.toBeNull();
    expect(screen.getByText("1 values copied to Event date")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /run migration/i }));
    await flushUi();

    // The surface re-lists: nothing pending → the section renders empty.
    expect(client.listPendingMigrations()).toEqual([]);
    await flushUi();
    expect(view.container.innerHTML).toBe("");

    // --- the local store converged ---
    expect(valuesOf(client, MEETING_NODE, MEETING_DATE_ID)).toEqual([]);
    expect(valuesOf(client, MEETING_NODE, EVENT_DATE_ID)).toEqual([
      { nodeId: chainNodeIds("2026-07-01").day },
    ]);
    const binding = client.store.database
      .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(MEETING_ID, MEETING_DATE_ID);
    expect(binding).toBeUndefined();
    const schema = client.store.database
      .prepare("SELECT active FROM property_schema WHERE id = ?")
      .get(MEETING_DATE_ID) as { active: number };
    expect(schema.active).toBe(0);

    // --- the ops ride the normal write path, sealed, with the session constants ---
    await client.push();
    // The run appended exactly the planner's op set (opTypes are envelope-
    // level metadata; the payloads ride sealed — nothing about the wire's
    // migration-specific content is readable, which is the point).
    const migrationEnvelopes = relay.envelopes().slice(watermark);
    expect(migrationEnvelopes.map((envelope) => envelope.opType)).toEqual([
      "property.set",
      "property.unset",
      "class.property.unset",
      "propertySchema.delete",
    ]);
    for (const envelope of migrationEnvelopes) {
      expect(isEncryptedPayload(envelope.payload)).toBe(true);
      expect(envelope.actorId).toBe(ACTOR);
      expect(envelope.deviceId).toBe(DEVICE);
      expect(envelope.actorId).not.toBe(MIGRATION_IDENTITY.actorId);
      expect(envelope.deviceId).not.toBe(MIGRATION_IDENTITY.deviceId);
    }
  });

  it("a converged (non-pending) workspace lists nothing and the surface renders empty", async () => {
    const client = await createClient(new MemoryRelay(), KEY);
    await client.push();

    expect(client.listPendingMigrations()).toEqual([]);
    const view = render(<MigrationsSection client={client} />);
    await flushUi();
    expect(view.container.innerHTML).toBe("");
    expect(screen.queryByText("Migrations")).toBeNull();
  });

  it("an unkeyed workspace lists the migration with the server-side-path hint", async () => {
    const client = await createClient(new MemoryRelay());
    await stagePendingMeetingDate(client);

    expect(client.isKeyedWorkspace()).toBe(false);
    expect(client.listPendingMigrations().map((report) => report.id)).toEqual([
      "meeting-date-retirement",
    ]);

    render(<MigrationsSection client={client} />);
    expect(await screen.findByText("Meeting-date retirement")).not.toBeNull();
    expect(screen.getByText(/not keyed — the server-side migration scripts can also run it/i)).not.toBeNull();
  });
});
