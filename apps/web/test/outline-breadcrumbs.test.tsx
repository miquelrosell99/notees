/**
 * Outline-row breadcrumbs tests (jsdom): the containing-page trail rides
 * ABOVE every outline result row by default (`showBreadcrumbs`, owner
 * 2026-10-22) — the breadcrumbs retired with the Logseq-era reference rows
 * (2026-10-21) are back as shared outline chrome. The trail is ancestors
 * only, read-only navigation context; a reference row carrying
 * `meta.containingPageId` truncates at that page and drops its crumb (the
 * group header / the row itself already names it). The classed-nodes
 * section, the page body (child blocks), the Class View's Extended-by
 * section, and the Child pages section opt out.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeView } from "../src/ui/App.js";
import { PageView } from "../src/ui/PageView.js";
import { OutlinerContext, useOutlinerValue } from "../src/ui/outliner-context.js";
import { CollectionHub } from "../src/features/collection/CollectionHub.js";
import { NodeCollection } from "../src/features/collection/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

/** WORKAROUND(store applier): class.create's contentAst never lands — seed
 * the title through object.update (the class-view suites' helper). */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

describe("outline rows: containing-page breadcrumbs (owner 2026-10-22)", () => {
  it("flat outline rows ride the ancestor trail above the row by default — read-only navigation context", async () => {
    const client = await seedClient();
    const holder = await client.createObject({ isEmbedded: false, name: "Holder" });
    const nested = await client.createObject({
      parentId: holder,
      contentAst: [{ type: "text", text: "Nested" }],
    });

    const opened: string[] = [];
    const { container } = render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Refs"
        items={[{ node: client.getNode(nested)! }]}
        modes={["outline"]}
        defaultMode="outline"
        onOpenNode={(id) => opened.push(id)}
      />,
    );
    const crumbs = container.querySelector(".outline-row__breadcrumbs");
    expect(crumbs).not.toBeNull();
    // The trail names the containing page; the row never crumbs itself.
    expect(crumbs!.textContent).toContain("Holder");
    // Read-only navigation: the crumb click opens through the container's
    // onNodeClick (the same navigation the row bullet rides).
    fireEvent.click(crumbs!.querySelector(".node-breadcrumb-link") as HTMLElement);
    expect(opened).toEqual([holder]);
  });

  it("showBreadcrumbs={false} opts the rows out of the trail", async () => {
    const client = await seedClient();
    const holder = await client.createObject({ isEmbedded: false, name: "Holder" });
    const nested = await client.createObject({
      parentId: holder,
      contentAst: [{ type: "text", text: "Nested" }],
    });
    const { container } = render(
      <NodeCollection
        viewMode="outline"
        client={client}
        items={[{ node: client.getNode(nested)! }]}
        showBreadcrumbs={false}
        onNodeClick={() => {}}
      />,
    );
    expect(container.querySelector(".outline-row__breadcrumbs")).toBeNull();
  });

  it("a breadcrumb-on tree wraps each row with the trail above it", async () => {
    const client = await seedClient();
    const holder = await client.createObject({ isEmbedded: false, name: "Holder" });
    const nested = await client.createObject({
      parentId: holder,
      contentAst: [{ type: "text", text: "Nested" }],
    });
    // A tree rides the call site's OutlinerContext (the page view) — the
    // harness stands one up outside a view.
    function TreeHarness({ children }: { children: React.ReactNode }) {
      const outliner = useOutlinerValue(client, "");
      return <OutlinerContext.Provider value={outliner}>{children}</OutlinerContext.Provider>;
    }
    const { container } = render(
      <TreeHarness>
        <NodeCollection
          viewMode="outline"
          client={client}
          items={[{ node: client.getNode(nested)! }]}
          tree
          readOnly
          onNodeClick={() => {}}
        />
      </TreeHarness>,
    );
    const entry = container.querySelector(".outline-tree-entry");
    expect(entry).not.toBeNull();
    expect(entry!.querySelector(".outline-row__breadcrumbs")?.textContent).toContain("Holder");
    expect(entry!.querySelector("[data-block-id]")).not.toBeNull();
  });

  it("the page body and the Child pages section render no trail (the opt-out)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Parent Page" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Body block" }],
    });
    await client.createObject({ parentId: pageId, isEmbedded: false, name: "Subpage" });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // The Child pages section IS present (the seed has a subpage) — but no
    // row, body or section, carries a breadcrumb line.
    expect(screen.getByText("Subpage")).not.toBeNull();
    expect(container.querySelector(".outline-row__breadcrumbs")).toBeNull();
  });

  it("the classed-nodes section and the Extended-by section render no trail (the opt-out)", async () => {
    const client = await seedClient();
    const parentId = await createTitledClass(client, "work");
    const memberId = await client.createObject({ isEmbedded: false, name: "Some Work" });
    await client.assignClass(memberId, parentId);
    const childId = await createTitledClass(client, "tv series");
    await client.setClassExtends(childId, [parentId]);

    const { container } = render(<NodeView client={client} nodeId={parentId} onOpenNode={() => {}} />);
    // Both sections render…
    expect(screen.getByText("Classed nodes")).not.toBeNull();
    expect(screen.getByText("Extended by")).not.toBeNull();
    // …with no breadcrumb line on any of their rows.
    expect(container.querySelector(".outline-row__breadcrumbs")).toBeNull();
  });

  it("backlink rows carry the trail again, minus the containing-page crumb (the group header names it)", async () => {
    const client = await seedClient();
    const target = await client.createObject({ isEmbedded: false, name: "Zebra" });
    const source = await client.createObject({ isEmbedded: false, name: "Linked Source" });
    // The mention lives on a block NESTED inside the source page — the
    // dropped containing-page crumb leaves the in-page path ("Sec") as the
    // row's trail.
    const section = await client.createObject({
      parentId: source,
      contentAst: [{ type: "text", text: "Sec" }],
    });
    await client.createObject({
      parentId: section,
      contentAst: [{ type: "mention", targetNodeId: target, text: "Zebra" }],
    });

    const { container } = render(<PageView client={client} pageId={target} />);
    const crumbs = container.querySelector(".outline-row__breadcrumbs");
    expect(crumbs).not.toBeNull();
    expect(crumbs!.textContent).toContain("Sec");
    expect(crumbs!.textContent).not.toContain("Linked Source");
  });
});
