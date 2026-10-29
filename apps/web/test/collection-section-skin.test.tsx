/**
 * CollectionSection — the ONE section skin (slice 1 of the section-skin
 * conversion): the chrome gaps the converting sections need, BEFORE any
 * section converts. The skin renders the NodeViewSection header's
 * action/count/hideHeader, resolves on mount when the host asks (the Created
 * contract — the query IS the count), re-runs on `refreshKey`, reports its
 * transient FilterQuery through `onFilterChange` (the live sort-flip), and
 * composes the hosted toolbar cluster in the owner's register — toolbar with
 * its quick search FIRST, then the ViewChromeSlot, then the host's extras —
 * with the "Save as tab" wiring riding when the hosted views are CONTROLLED.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { CollectionSection } from "../src/features/collection/CollectionSection.js";
import type { NodeCollectionItem } from "../src/features/collection/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
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

/** The section's root element. */
function skinRoot(): HTMLElement {
  const root = document.querySelector(".nt-collection-section");
  if (root === null) throw new Error("no collection section");
  return root as HTMLElement;
}

/** All rows' textContent — the resolved set at a glance. */
function rowTitles(): string[] {
  return [...document.querySelectorAll(".nt-collection-section .outline-flat > li")].map(
    (li) => li.textContent ?? "",
  );
}

async function twoItems(client: WorkspaceClient): Promise<NodeCollectionItem[]> {
  const a = await client.createObject({ isEmbedded: false, name: "Alpha" });
  const b = await client.createObject({ isEmbedded: false, name: "Beta" });
  return [
    { node: client.getNode(a)! },
    { node: client.getNode(b)! },
  ];
}

/**
 * The quick search idiom depends on the viewport width (jsdom resolves the
 * media query either way) — expand the magnifier when the inline field is
 * absent, and hand back the field.
 */
function quickSearch(scope: HTMLElement): HTMLElement {
  if (within(scope).queryByLabelText("Filter by text") === null) {
    fireEvent.click(within(scope).getByRole("button", { name: "Search rows" }));
  }
  return within(scope).getByLabelText("Filter by text") as HTMLElement;
}

describe("CollectionSection — the skin's chrome gaps", () => {
  it("renders the header action, the count badge, and hides the header on demand", async () => {
    const client = await seedClient();
    const items = await twoItems(client);

    const { unmount } = render(
      <CollectionSection
        client={client}
        title="Created"
        count={2}
        emptyText="Nothing."
        viewMode="outline"
        read={() => items}
        action={{ icon: "mdi mdi-plus", label: "Add child page", onClick: vi.fn() }}
      />,
    );
    const root = skinRoot();
    const action = within(root).getByRole("button", { name: "Add child page" });
    expect(action).not.toBeNull();
    expect(within(root).getByText("2")).not.toBeNull();
    unmount();

    render(
      <CollectionSection
        client={client}
        title="Backlinks"
        emptyText="Nothing."
        viewMode="outline"
        read={() => items}
        resolveOnMount
        hideHeader
      />,
    );
    // Headerless: the header button is gone, the body rides bare.
    expect(document.querySelector(".node-view-section__header")).toBeNull();
    expect(rowTitles()).toHaveLength(2);
  });

  it("resolveOnMount resolves while collapsed — the count IS the query contract", async () => {
    const client = await seedClient();
    const items = await twoItems(client);
    const read = vi.fn(() => items);

    render(
      <CollectionSection
        client={client}
        title="Created"
        emptyText="Nothing."
        viewMode="outline"
        read={read}
        resolveOnMount
      />,
    );
    await act(async () => {});
    // Collapsed (the default) yet resolved — and the rows are in the DOM
    // when the section expands.
    expect(read).toHaveBeenCalled();
    fireEvent.click(within(skinRoot()).getByRole("button", { name: /Created/ }));
    expect(rowTitles()).toHaveLength(2);
  });

  it("a lazy section (no resolveOnMount) does not read until expanded", async () => {
    const client = await seedClient();
    const items = await twoItems(client);
    const read = vi.fn(() => items);

    render(
      <CollectionSection
        client={client}
        title="Created"
        emptyText="Nothing."
        viewMode="outline"
        read={read}
      />,
    );
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(within(skinRoot()).getByRole("button", { name: /Created/ }));
    await act(async () => {});
    expect(read).toHaveBeenCalled();
  });

  it("refreshKey re-runs the resolution", async () => {
    const client = await seedClient();
    const items = await twoItems(client);
    const read = vi.fn(() => items);

    const { rerender } = render(
      <CollectionSection
        client={client}
        title="Backlinks"
        emptyText="Nothing."
        viewMode="outline"
        read={read}
        resolveOnMount
        refreshKey="a"
      />,
    );
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    rerender(
      <CollectionSection
        client={client}
        title="Backlinks"
        emptyText="Nothing."
        viewMode="outline"
        read={read}
        resolveOnMount
        refreshKey="b"
      />,
    );
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reports the transient FilterQuery through onFilterChange", async () => {
    const client = await seedClient();
    const items = await twoItems(client);
    const onFilterChange = vi.fn();

    render(
      <CollectionSection
        client={client}
        title="Created"
        emptyText="Nothing."
        viewMode="outline"
        read={() => items}
        resolveOnMount
        filterable
        defaultCollapsed={false}
        onFilterChange={onFilterChange}
      />,
    );
    await act(async () => {});
    const root = skinRoot();
    fireEvent.change(quickSearch(root), {
      target: { value: "Alpha" },
    });
    expect(onFilterChange).toHaveBeenCalled();
    expect(onFilterChange.mock.calls.at(-1)![0].text).toBe("Alpha");
    // The filter narrows the rendered rows through the hook.
    expect(rowTitles()).toHaveLength(1);
  });
});

describe("CollectionSection — the hosted toolbar cluster", () => {
  it("composes the owner's register: toolbar (search first) → view-chrome slot → host extras", async () => {
    const client = await seedClient();
    const items = await twoItems(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });

    render(
      <CollectionSection
        client={client}
        title="Backlinks"
        emptyText="Nothing."
        viewMode="outline"
        read={() => items}
        filterable
        defaultCollapsed={false}
        collection={{
          hostedViews: {
            nodeId: host,
            sectionKey: "linked-references",
            createAst: () => ({
              version: 1,
              scope: { type: "entire_workspace" },
              root: { type: "group", logic: "and", children: [] },
            }),
          },
          // The host's extras — the last cluster element in the register.
          toolbarContent: <span data-testid="host-extras" />,
        }}
      />,
    );
    await act(async () => {});
    const cluster = document.querySelector(".nt-node-collection-topbar__cluster") as HTMLElement;
    expect(cluster).not.toBeNull();

    // Expand the quick search — jsdom is wide, so the inline field rides
    // the cluster directly (the narrow-viewport magnifier is the other idiom).
    const search = quickSearch(cluster);
    const follows = (sel: string): boolean => {
      const el = cluster.querySelector(sel);
      return (
        el !== null &&
        (search.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
    };
    // The register: the slot (class on the span) precedes the host extras;
    // both follow the search field.
    expect(follows(".node-collection__view-chrome")).toBe(true);
    expect(follows('[data-testid="host-extras"]')).toBe(true);
    const slot = cluster.querySelector(".node-collection__view-chrome")!;
    expect(
      (slot.compareDocumentPosition(cluster.querySelector('[data-testid="host-extras"]')!)!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("wires the Save-as-tab wiring when the hosted views are controlled", async () => {
    const client = await seedClient();
    const classId = await client.createClass("project");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "project" }] });
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const onSelectTab = vi.fn();

    render(
      <CollectionSection
        client={client}
        title="Classed nodes"
        emptyText="Nothing."
        viewMode="outline"
        read={() => []}
        filterable
        defaultCollapsed={false}
        collection={{
          hostedViews: {
            nodeId: host,
            sectionKey: "classed-nodes",
            createAst: () => ({
              version: 1,
              scope: { type: "entire_workspace" },
              root: { type: "group", logic: "and", children: [] },
            }),
            selected: "default",
            onSelectTab,
          },
        }}
      />,
    );
    await act(async () => {});
    const cluster = document.querySelector(".nt-node-collection-topbar__cluster") as HTMLElement;
    fireEvent.click(within(cluster).getByRole("button", { name: "Structured filters" }));
    // Compose a structured draft (the full builder flow — a bare condition
    // prunes to nothing, so the class must be picked): a NON-empty draft
    // surfaces the Save-as-tab button — the viewSaver wiring, present only
    // on CONTROLLED hosted views.
    const panel = document.querySelector(".nt-node-collection-toolbar__panel") as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Add condition" }));
    fireEvent.click(
      within(document.querySelector(".btn-panel") as HTMLElement).getByRole("menuitem", {
        name: /^Class/,
      }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Add class" }));
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "project" } });
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );
    expect(
      within(document.querySelector(".nt-node-collection-toolbar__panel") as HTMLElement).getByRole(
        "button",
        { name: "Save as tab" },
      ),
    ).not.toBeNull();
  });
});
