/**
 * sectionRegistry — the SectionSpec registry (phase 2 of the section-skin
 * conversion): every page section declared once as a `{ key, render }`
 * entry; a variant's stack is a KEY LIST composed through `sectionEntries`
 * (placement is data — the date-page ruling that omits unlinked mentions is
 * a plain key filter). The spec: the registry holds every section exactly
 * once, an unknown key fails loud (a stack never silently drops a
 * section), and `pageVariantOf`'s stacks per variant read as pinned key
 * lists.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { dayNodeId } from "../src/features/calendar/calendarViewUtils.js";
import { pageVariantOf } from "../src/features/page-sections/pageVariant.js";
import { sectionEntries } from "../src/features/page-sections/sectionRegistry.js";

const WS = "0192a000-0000-7000-8000-0000000000c1";
const ACTOR = "0192a000-0000-7000-8000-0000000000c2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
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

const keys = (specs: readonly { key: string }[]): string[] => specs.map((spec) => spec.key);

describe("the section registry", () => {
  it("composes a stack from a key list in list order", () => {
    const stack = sectionEntries(["backlinks", "child-pages"]);
    expect(keys(stack)).toEqual(["backlinks", "child-pages"]);
    // The same entry instances across compositions (one declaration each).
    expect(sectionEntries(["backlinks"])[0]).toBe(stack[0]);
  });

  it("an unknown key fails loud — a stack never silently drops a section", () => {
    expect(() => sectionEntries(["backlinks", "nope"])).toThrow(/unknown section key/);
  });

  it("the plain page variant: the reference family in render order, no content sections", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Plain" });
    const variant = pageVariantOf(client, pageId);
    expect(variant.variant).toBe("plain");
    expect(keys(variant.sections)).toEqual([]);
    expect(keys(variant.systemSections)).toEqual([
      "child-pages",
      "backlinks",
      "unlinked-mentions",
      "forward-path",
    ]);
  });

  it("the class variant: classed nodes ahead, the sidebar stack, Extended by before the reference family", async () => {
    const client = await seedClient();
    const classId = await client.createClass("project");
    const variant = pageVariantOf(client, classId);
    expect(variant.variant).toBe("class");
    expect(keys(variant.sections)).toEqual(["classed-nodes"]);
    expect(keys(variant.sidebarSections ?? [])).toEqual([
      "property-definitions",
      "parentless-role",
      "templates",
    ]);
    expect(keys(variant.systemSections)).toEqual([
      "extended-by",
      "child-pages",
      "backlinks",
      "unlinked-mentions",
      "forward-path",
    ]);
  });

  it("the date variants omit the discovery sections — spec absence is the date-page ruling", async () => {
    const client = await seedClient();
    const dayId = dayNodeId("2026-10-29");
    await client.createObject({
      id: dayId,
      isEmbedded: false,
      parentId: null,
      name: "2026/10/29",
      classIds: [SYSTEM_CLASS_UUIDS.day],
    });
    const day = pageVariantOf(client, dayId);
    expect(day.variant).toBe("date-day");
    expect(day.dayIso).toBe("2026-10-29");
    // Unlinked mentions AND the Forward path: a date page is a journal
    // surface, not an idea node — it carries no discovery sections.
    expect(keys(day.systemSections)).toEqual(["child-pages", "backlinks"]);
  });
});
