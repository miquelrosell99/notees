/**
 * Linked-references auto-collapse level — the "Auto-collapse nodes at this
 * depth in system sections" device setting (`linkedRefsCollapseLevel`)
 * actually governs the reference rows' starting fold state: rows at the
 * named depth and deeper start collapsed, 0 = disabled (nothing auto-folds,
 * rows render fully expanded). The collapse default rides the collection's
 * `defaultCollapseLevel` prop; the depth count starts at 1 for the section's
 * top-level reference rows. Harness: in-process WorkspaceClient + jsdom.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { ReferenceList } from "../src/features/page-sections/SystemSections.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";
const SETTING_KEY = "notees.settings.linkedRefsCollapseLevel";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
});

async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

/**
 * Target ← "Source" page (the reference row, depth 1) with a child block
 * "Middle block" (depth 2) carrying its own child "Deep block" (depth 3).
 * The edge rides a bound property value on the page itself, so the entry's
 * source IS its containing page — the row rides the ungrouped top-level flat
 * outline.
 */
async function seedThreeDeep(): Promise<{ client: WorkspaceClient; target: string }> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  const schemaId = await client.createPropertySchema({
    name: "supports",
    type: "object",
    multi: true,
    targetClassFilter: [],
  });
  const target = await client.createObject({ isEmbedded: false, name: "Target" });
  const source = await client.createObject({ isEmbedded: false, name: "Source" });
  const middle = await client.createObject({
    parentId: source,
    contentAst: [{ type: "text", text: "Middle block" }],
  });
  await client.createObject({
    parentId: middle,
    contentAst: [{ type: "text", text: "Deep block" }],
  });
  await client.setProperty(source, schemaId, { nodeId: target }, 0);
  await flushSync();
  return { client, target };
}

function renderRefs(client: WorkspaceClient, target: string): void {
  render(
    <ReferenceList
      entries={client.getLinkedReferences(target)}
      client={client}
      onOpenPage={() => {}}
    />,
  );
}

describe("linked-references auto-collapse level", () => {
  it("level 0 (disabled) renders the reference rows fully expanded", async () => {
    localStorage.setItem(SETTING_KEY, "0");
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    expect(document.body.textContent).toContain("Middle block");
    expect(document.body.textContent).toContain("Deep block");
  });

  it("level 0 is the default when the setting was never written", async () => {
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    expect(document.body.textContent).toContain("Deep block");
  });

  it("level 1 folds the top-level reference rows (their children hidden)", async () => {
    localStorage.setItem(SETTING_KEY, "1");
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    // The row itself still renders; its subtree stays behind the chevron.
    expect(document.body.textContent).toContain("Source");
    expect(document.body.textContent).not.toContain("Middle block");
  });

  it("level 2 expands the reference rows and folds their children", async () => {
    localStorage.setItem(SETTING_KEY, "2");
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    expect(document.body.textContent).toContain("Middle block");
    expect(document.body.textContent).not.toContain("Deep block");
  });

  it("a folded row unfolds on chevron click (the session-local override)", async () => {
    localStorage.setItem(SETTING_KEY, "1");
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    const row = document.querySelector(".nt-block[data-block-id]") as HTMLElement;
    expect(row).not.toBeNull();
    const toggle = row.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle.click();
    });
    expect(document.body.textContent).toContain("Middle block");
  });
});
