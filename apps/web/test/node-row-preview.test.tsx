/**
 * Node-row preview line tests: the metadata line NodeResultItem renders
 * under a node row when one of the node's classes binds a property flagged
 * showInNodeRows (the compact " · "-joined line — bare formatted values, no
 * labels, the Add-Source preview card's idiom).
 *
 * Coverage:
 *  - the SEEDED cases end-to-end through the real families: a task renders
 *    "Status · Deadline", an event renders its date, a source renders
 *    "authors · year" (extends-aware — the flags ride the source base);
 *  - unflagged bindings render NO line (a task with only the unflagged
 *    Scheduled date), and a flagged-but-all-empty node renders NO line;
 *  - the formatting contract: multi-values join with ", ", relation values
 *    resolve to the target's name, dates honor the precision (year → the
 *    bare year), empty segments are omitted;
 *  - the degradation contract: a client without the preview seams renders
 *    no line, and rows pay the effective-values read ONLY when a flagged
 *    binding exists (spy contract).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_STATUS_OPTION_UUIDS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeResultItem } from "../src/features/pickers/NodeResultItem.js";
import { nodeRowPreviewLine } from "../src/features/pickers/nodeRowPreview.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";
import { ensureMeetingFamily } from "../src/features/classview/meetingFamily.js";

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

function metaLine(container: HTMLElement): string | null {
  const el = container.querySelector(".node-result-item__meta");
  return el === null ? null : el.textContent;
}

describe("NodeResultItem node-row preview line (seeded families)", () => {
  it("a task renders its flagged Deadline + Status, joined ' · ' (binding-list order), day-precision date", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const taskId = await client.createObject({
      name: "File the report",
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await client.setProperty(
      taskId,
      SYSTEM_PROPERTY_UUIDS.taskStatus,
      TASK_STATUS_OPTION_UUIDS.doing,
      0,
    );
    const { day } = await client.ensureDateChain("2026-03-10");
    await client.setProperty(taskId, SYSTEM_PROPERTY_UUIDS.taskDeadline, { nodeId: day }, 0);
    await flushSync();

    const { container } = render(
      <NodeResultItem node={client.getNode(taskId)!} client={client} onClick={() => {}} />,
    );
    // Binding-list order: both ride the pinned tier, alphabetical within it.
    expect(metaLine(container)).toBe("2026-03-10 · Doing");
  });

  it("an event renders its flagged eventDate", async () => {
    const client = await seedClient();
    await ensureMeetingFamily(client);
    const eventId = await client.createObject({
      name: "Design review",
      classIds: [SYSTEM_CLASS_UUIDS.event],
    });
    const { day } = await client.ensureDateChain("2026-05-20");
    await client.setProperty(eventId, SYSTEM_PROPERTY_UUIDS.eventDate, { nodeId: day }, 0);
    await flushSync();

    const { container } = render(
      <NodeResultItem node={client.getNode(eventId)!} client={client} onClick={() => {}} />,
    );
    expect(metaLine(container)).toBe("2026-05-20");
  });

  it("a source renders its flagged authors + publicationDate (year), extends-aware off the base", async () => {
    const client = await seedClient();
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");
    await deploySystemClass(client, "journal_article");
    await flushSync();
    const classId = SYSTEM_CLASS_UUIDS.journal_article;
    const sourceId = await client.createObject({ name: "Wealth of Networks", classIds: [classId] });
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.authors, "Benkler, Yochai", 0);
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.authors, "Weber, Steven", 1);
    const { year } = await client.ensureDateChain("2006-01-01");
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: year }, 0);
    await flushSync();

    const { container } = render(
      <NodeResultItem node={client.getNode(sourceId)!} client={client} onClick={() => {}} />,
    );
    expect(metaLine(container)).toBe("Benkler, Yochai, Weber, Steven · 2006");
  });

  it("an unflagged binding's value never renders (only the flagged Status default shows)", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const taskId = await client.createObject({
      name: "Undated status",
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    const { day } = await client.ensureDateChain("2026-04-01");
    await client.setProperty(taskId, SYSTEM_PROPERTY_UUIDS.taskScheduled, { nodeId: day }, 0);
    await flushSync();

    const { container } = render(
      <NodeResultItem node={client.getNode(taskId)!} client={client} onClick={() => {}} />,
    );
    // The flagged Status default ("Pending") renders; the UNFLAGGED Scheduled
    // date never does.
    const line = metaLine(container);
    expect(line).not.toBeNull();
    expect(line).not.toContain("2026-04-01");
  });

  it("renders NO line when every flagged value is empty (no default on the schema)", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Project");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Project" }] });
    const schemaId = await client.createPropertySchema({ name: "code", type: "text" });
    await client.setClassProperty(classId, schemaId, { showInNodeRows: true });
    const memberId = await client.createObject({ name: "Empty project", classIds: [classId] });
    await flushSync();

    const { container } = render(
      <NodeResultItem node={client.getNode(memberId)!} client={client} onClick={() => {}} />,
    );
    expect(metaLine(container)).toBeNull();
  });

  it("resolves a relation value to the target node's name", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Project");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Project" }] });
    const schemaId = await client.createPropertySchema({ name: "owner", type: "object" });
    await client.setClassProperty(classId, schemaId, { showInNodeRows: true });
    const memberId = await client.createObject({ name: "Thesis", classIds: [classId] });
    const personId = await client.createObject({ name: "Ada Lovelace" });
    await client.setProperty(memberId, schemaId, { nodeId: personId }, 0);
    await flushSync();

    const { container } = render(
      <NodeResultItem node={client.getNode(memberId)!} client={client} onClick={() => {}} />,
    );
    expect(metaLine(container)).toBe("Ada Lovelace");
  });

  it("a client without the preview seams renders no line", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const taskId = await client.createObject({
      name: "Seamless",
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await flushSync();
    const narrowClient = {
      getNode: (id: string) => client.getNode(id),
      getDisplayName: (id: string) => client.getDisplayName(id),
    };
    const { container } = render(
      <NodeResultItem node={client.getNode(taskId)!} client={narrowClient} onClick={() => {}} />,
    );
    expect(metaLine(container)).toBeNull();
  });

  it("rows without a flagged binding never pay the effective-values read", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Plain");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Plain" }] });
    const schemaId = await client.createPropertySchema({ name: "note", type: "text" });
    await client.setClassProperty(classId, schemaId, {});
    const memberId = await client.createObject({ name: "Plain row", classIds: [classId] });
    await flushSync();

    const spy = vi.spyOn(client, "getEffectiveProperties");
    render(<NodeResultItem node={client.getNode(memberId)!} client={client} onClick={() => {}} />);
    expect(spy).not.toHaveBeenCalled();
  });

  it("an inactive flagged binding contributes no line", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Muted");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Muted" }] });
    const schemaId = await client.createPropertySchema({ name: "tagline", type: "text" });
    await client.setClassProperty(classId, schemaId, { showInNodeRows: true, active: false });
    const memberId = await client.createObject({ name: "Muted row", classIds: [classId] });
    await client.setProperty(memberId, schemaId, "should not render", 0);
    await flushSync();

    const { container } = render(
      <NodeResultItem node={client.getNode(memberId)!} client={client} onClick={() => {}} />,
    );
    expect(metaLine(container)).toBeNull();
  });
});

describe("nodeRowPreviewLine (unit)", () => {
  it("joins multiple flagged segments with ' · ' and omits empty ones", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Doc");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Doc" }] });
    const first = await client.createPropertySchema({ name: "venue", type: "text" });
    const second = await client.createPropertySchema({ name: "year", type: "text" });
    await client.setClassProperty(classId, first, { showInNodeRows: true });
    await client.setClassProperty(classId, second, { showInNodeRows: true });
    const memberId = await client.createObject({ name: "Paper", classIds: [classId] });
    await client.setProperty(memberId, first, "CSCW", 0);
    await flushSync();

    expect(nodeRowPreviewLine(client, client.getNode(memberId)!)).toBe("CSCW");
  });
});
