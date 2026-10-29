/**
 * The hub's lifted filter toolbar, end to end (jsdom over the in-process
 * WorkspaceClient + MemoryRelay): every CollectionHub rides the shared
 * NodeCollectionToolbar in the SurfaceTopBar's actions cluster — the quick
 * search + the structured-filters toggle between the view chrome and the
 * header actions — and the FilterQuery (component state at the hub)
 * narrows the collection through the section-data contract (ranked quick
 * text, then the structured group through the query-run seam) while the
 * bar's count stays unfiltered. The views' per-view chrome (the outline's
 * SortMenuButton et al.) PORTALS into the slot the bar owns — the Pages
 * hub's body-top lone sort row retires — and the structured panel drops
 * into the hub bar's full-width seat beneath the bar (the NodeCollectionTopBar
 * precedent), never an in-place popover in the cluster. The Cards hub
 * inherits the shared toolbar (its bespoke prepend wiring retires): the
 * bucket strip stays prepended and the Review actions ride the filtered-set
 * report.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { HubView } from "../src/ui/app/HubView.js";

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
  vi.unstubAllGlobals();
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

/** Flush the microtasks an effect-triggered async write/run rides on. */
async function flush(): Promise<void> {
  await act(async () => {});
}

/** WORKAROUND(store applier): class.create's contentAst never lands — seed
 * the title through object.update instead. */
async function seedClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

/** The hub's SurfaceTopBar. */
function hubBar(): HTMLElement {
  const bar = document.querySelector(".nt-hub .surface-topbar");
  if (bar === null) throw new Error("no hub bar");
  return bar as HTMLElement;
}

/** Top-level outline row titles (each row's OWN content read). */
function outlineTitles(): string[] {
  return [...document.querySelectorAll(".nt-hub .outline-flat > li")].map(
    (li) =>
      li.querySelector(
        ":scope > .outline-row > .nt-block > .nt-block-row > .nt-block-content",
      )?.textContent ?? "",
  );
}

/**
 * The quick search COLLAPSES by default (the magnifier toggle) — expand it
 * before typing into it, and hand back the field.
 */
function openQuickSearch(scope: HTMLElement): HTMLElement {
  if (within(scope).queryByLabelText("Filter by text") === null) {
    fireEvent.click(within(scope).getByRole("button", { name: "Search rows" }));
  }
  return within(scope).getByLabelText("Filter by text") as HTMLElement;
}

describe("the hub's lifted filter toolbar", () => {
  it("the Pages hub renders the toolbar in the bar and the sort button ports up — no body-top sort row", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Alpha" });
    await client.createObject({ isEmbedded: false, name: "Beta" });

    render(<HubView client={client} nav="pages" onOpenNode={() => {}} />);
    const bar = hubBar();

    // The toolbar rides the bar: the structured-filters toggle + the quick
    // search (collapsed to the magnifier until expanded).
    expect(within(bar).getByRole("button", { name: "Structured filters" })).not.toBeNull();
    expect(within(bar).getByRole("button", { name: "Search rows" })).not.toBeNull();
    // The bar's count names the unfiltered set.
    expect(within(bar).getByText("2")).not.toBeNull();

    // The outline's sort chrome PORTALED into the bar's view-chrome slot —
    // the lone body-top row retires.
    const chromeSlot = bar.querySelector(".nt-hub__view-chrome") as HTMLElement;
    expect(chromeSlot).not.toBeNull();
    expect(chromeSlot.querySelector(".outline-toolbar")).not.toBeNull();
    const sortButton = within(bar).getByRole("button", { name: "Sort" });
    expect(sortButton).not.toBeNull();
    expect(document.querySelector(".nt-hub__body .outline-toolbar")).toBeNull();

    // The cluster order: the mode switcher → the ported sort chrome → the
    // toolbar's search.
    const search = openQuickSearch(bar);
    const precedes = (el: Element | null): boolean =>
      el !== null && (search.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    expect(precedes(sortButton)).toBe(true);
    expect(
      precedes(within(bar).getByRole("radio", { name: "Outline" })),
    ).toBe(true);
  });

  it("quick search narrows the collection live; the badge names N of M and clear restores", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Alpha" });
    await client.createObject({ isEmbedded: false, name: "Beta" });

    render(<HubView client={client} nav="pages" onOpenNode={() => {}} />);
    const bar = hubBar();
    expect(outlineTitles()).toHaveLength(2);

    fireEvent.change(openQuickSearch(bar), { target: { value: "Alpha" } });

    expect(outlineTitles()).toEqual(["Alpha"]);
    expect(within(bar).getByText("1 of 2")).not.toBeNull();
    // The bar count stays unfiltered.
    expect(within(bar).getByText("2")).not.toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "Clear filter" }));
    expect(outlineTitles()).toHaveLength(2);
    expect(within(bar).queryByText(/of 2/)).toBeNull();
  });

  it("a filter emptied to zero reads 'No matching rows.' — the hub's empty state names the unfiltered set", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Alpha" });

    render(<HubView client={client} nav="pages" onOpenNode={() => {}} />);
    const bar = hubBar();

    fireEvent.change(openQuickSearch(bar), { target: { value: "zzz" } });
    expect(outlineTitles()).toHaveLength(0);
    expect(within(bar).getByText("0 of 1")).not.toBeNull();
    expect(screen.getByText("No matching rows.")).not.toBeNull();
    expect(screen.queryByText("Nothing here yet.")).toBeNull();
  });

  it("the structured panel drops into the hub bar's full-width seat, not the actions cluster", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Alpha" });

    render(<HubView client={client} nav="pages" onOpenNode={() => {}} />);
    const bar = hubBar();

    fireEvent.click(within(bar).getByRole("button", { name: "Structured filters" }));
    const panel = document.querySelector(".nt-node-collection-toolbar__panel") as HTMLElement;
    expect(panel).not.toBeNull();

    // The panel ports OUT of the actions cluster into the seat beneath the
    // bar (the NodeCollectionTopBar precedent).
    expect(bar.querySelector(".surface-topbar__actions")!.contains(panel)).toBe(false);
    const host = document.querySelector(".nt-hub__bar-panel-host");
    expect(host).not.toBeNull();
    expect(host!.contains(panel)).toBe(true);
    expect(
      bar.compareDocumentPosition(host!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("the structured builder constrains the hub collection through the run seam", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    await client.createObject({ isEmbedded: false, name: "Alpha", classIds: [classId] });
    await client.createObject({ isEmbedded: false, name: "Beta" });

    render(<HubView client={client} nav="pages" onOpenNode={() => {}} />);
    const bar = hubBar();
    expect(outlineTitles()).toHaveLength(2);

    fireEvent.click(within(bar).getByRole("button", { name: "Structured filters" }));
    const panel = document.querySelector(
      ".nt-node-collection-toolbar__panel",
    ) as HTMLElement;
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
    // The run executes through the query-run seam — flush it.
    await flush();

    expect(outlineTitles()).toEqual(["Alpha"]);
    expect(within(bar).getByText("1 of 2")).not.toBeNull();
  });
});

describe("the Cards hub inherits the shared toolbar", () => {
  it("the toolbar rides the bar (the bespoke prepend wiring retires); the bucket strip stays and the Review action rides the filtered subset", async () => {
    const client = await seedClient();
    // The hub authors the card family on open — ensure up front for a
    // deterministic first render.
    await client.createObject({ isEmbedded: false, name: "Zebra", classIds: [SYSTEM_CLASS_UUIDS.card] });
    await client.createObject({ isEmbedded: false, name: "Mango", classIds: [SYSTEM_CLASS_UUIDS.card] });

    render(<HubView client={client} nav="cards" onOpenNode={() => {}} />);
    await flush();
    const bar = hubBar();

    // The shared toolbar rides the bar; the retired prepend stack renders
    // no filter chrome of its own.
    expect(within(bar).getByRole("button", { name: "Structured filters" })).not.toBeNull();
    expect(document.querySelector(".nt-hub-cards__filters")).toBeNull();
    // The bucket strip stays prepended inside the scrolling body.
    expect(screen.getByLabelText("Card buckets")).not.toBeNull();
    // The header actions stay.
    expect(within(bar).getByRole("button", { name: "Review now" })).not.toBeNull();
    expect(within(bar).getByRole("button", { name: "New card" })).not.toBeNull();

    // Filter to one card: the collection narrows immediately, the Review
    // action rides the filtered-set report (one effect tick behind).
    fireEvent.change(openQuickSearch(bar), { target: { value: "Zebra" } });
    const rows = () =>
      [...document.querySelectorAll(".nt-hub tbody tr")].map((tr) =>
        tr.getAttribute("data-node-id"),
      );
    expect(rows()).toHaveLength(1);
    expect(within(bar).getByText("1 of 2")).not.toBeNull();
    await flush();
    expect((within(bar).getByRole("button", { name: "Review now" }) as HTMLButtonElement).disabled).toBe(false);

    // Emptying the filter disables the Review action over the empty subset.
    fireEvent.change(openQuickSearch(bar), { target: { value: "zzz" } });
    expect(rows()).toHaveLength(0);
    expect(within(bar).getByText("0 of 2")).not.toBeNull();
    await flush();
    expect(
      (within(bar).getByRole("button", { name: "Review now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
