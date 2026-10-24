/**
 * Sources hub facets-pane tests (task 2 — the type facets pane):
 *
 * - The enabled types render alphabetically as chips with live counts
 *   (Book · 1, Book section · 1, Journal article · 2, Web page · 4).
 * - The archived types ride a collapsed "Hidden types" disclosure — the
 *   archived-by-default artwork with its count and an Enable row.
 * - The Enable round-trip (Review Focus 3): clicking Enable writes the
 *   SAME setArchived seam the gallery and settings use; the pane updates
 *   in place — the facet moves from Hidden types to the enabled list
 *   without a remount loop.
 * - Type picking pushes the App-owned URL state (the calendar's
 *   onRouteChange seam): {…query, type} in "push" mode, toggling the
 *   active type back to null.
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js), the
 * sources-data convention (a compact roster: journal ×2, web_page ×3,
 * book + book_section multi-type carriers, archived artwork ×1).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
  type SystemClassName,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { SourcesHub } from "../src/features/sources/SourcesHub.js";
import { DEFAULT_SOURCES_QUERY } from "../src/features/sources/sourcesQuery.js";

const WS = "0192a000-0000-7000-8000-0000000000f1";
const ACTOR = "0192a000-0000-7000-8000-0000000000f2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

const ROSTER = ["journal_article", "web_page", "book", "book_section", "artwork"] as const;

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);

  for (const name of ["source", ...ROSTER] as const) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id: SYSTEM_CLASS_UUIDS[name] });
  }
  for (const name of ROSTER) {
    await client.setClassExtends(SYSTEM_CLASS_UUIDS[name], [SYSTEM_CLASS_UUIDS.source]);
  }
  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  const P = SYSTEM_PROPERTY_UUIDS;
  await client.createPropertySchema({
    id: P.authors,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.authors,
    type: "text",
    multi: true,
    scopeClassIds: [SOURCE],
  });
  await client.createPropertySchema({
    id: P.publicationTitle,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.publicationTitle,
    type: "text",
    scopeClassIds: [SOURCE],
  });
  await client.setClassProperty(SOURCE, P.authors, {});
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.journal_article, P.publicationTitle, {});
  // artwork rides SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES — archive it.
  await client.setArchived(SYSTEM_CLASS_UUIDS.artwork, false);

  const create = (title: string, classes: readonly SystemClassName[]) =>
    client.createObject({
      isEmbedded: false,
      name: title,
      classIds: classes.map((c) => SYSTEM_CLASS_UUIDS[c]),
    });
  // journal ×2.
  await create("On the Analytical Engine", ["journal_article"]);
  await create("Computing Machinery", ["journal_article"]);
  // web_page ×3.
  await create("A Great Article", ["web_page"]);
  await create("Another Page", ["web_page"]);
  await create("Third Page", ["web_page"]);
  // The multi-type carriers.
  await create("Dual Nature", ["web_page", "book_section"]);
  await create("Archived Mix", ["artwork", "book"]);
  return client;
}

function renderHub(
  client: WorkspaceClient,
  query = DEFAULT_SOURCES_QUERY,
  onQueryChange: ((next: typeof query, mode: "push" | "replace") => void) | undefined = undefined,
) {
  return render(
    <SourcesHub client={client} query={query} onQueryChange={onQueryChange} />,
  );
}

function facetsRegion(): HTMLElement {
  return screen.getByRole("complementary", { name: "Source types" });
}

describe("SourcesFacets — the type facet list", () => {
  it("renders the enabled types alphabetically with live counts", async () => {
    const client = await seedClient();
    renderHub(client);

    const region = facetsRegion();
    const list = within(region).getByRole("group", { name: "Source types" });
    const chips = within(list).getAllByRole("button");
    const labels = chips.map((chip) => chip.textContent);
    expect(labels).toEqual([
      "Book · 1",
      "Book section · 1",
      "Journal article · 2",
      "Web page · 4",
    ]);
    // The archived type does not ride the enabled list…
    expect(labels.some((label) => label?.startsWith("Artwork"))).toBe(false);
    // …it waits under the collapsed Hidden types disclosure.
    expect(within(region).getByRole("button", { name: /hidden types/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("the Hidden types disclosure lists archived types with counts and an Enable row", async () => {
    const client = await seedClient();
    renderHub(client);

    const region = facetsRegion();
    fireEvent.click(within(region).getByRole("button", { name: /hidden types/i }));
    expect(within(region).getByRole("button", { name: /hidden types/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(region).getByText("Artwork · 1")).not.toBeNull();
    expect(
      within(region).getByRole("button", { name: "Enable Artwork" }),
    ).not.toBeNull();
  });

  it("Enable round-trips through the gallery's setArchived seam and updates the pane in place (no remount loop)", async () => {
    const client = await seedClient();
    renderHub(client);
    const region = facetsRegion();

    fireEvent.click(within(region).getByRole("button", { name: /hidden types/i }));
    fireEvent.click(within(region).getByRole("button", { name: "Enable Artwork" }));

    // The write converges; the same pane instance re-renders via the
    // subscription — the facet moves to the enabled list, the hidden row
    // disappears, and the class row's active bit flipped.
    await waitFor(() => {
      expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.artwork)?.isActive).toBe(true);
    });
    const list = within(region).getByRole("group", { name: "Source types" });
    expect(within(list).getAllByRole("button").map((chip) => chip.textContent)).toContain(
      "Artwork · 1",
    );
    expect(within(region).queryByText("Artwork · 1", { selector: "li span" })).toBeNull();
  });

  it("type picking pushes the App-owned URL state; the active type clears back to null", async () => {
    const client = await seedClient();
    const onQueryChange = vi.fn();
    const { rerender } = renderHub(client, DEFAULT_SOURCES_QUERY, onQueryChange);

    fireEvent.click(screen.getByRole("button", { name: "Book · 1" }));
    expect(onQueryChange).toHaveBeenCalledWith(
      { type: "book", q: "", sort: null },
      "push",
    );

    // The App state round-trips (the calendar seam) — re-render with the
    // picked type, then picking the SAME type clears the filter.
    onQueryChange.mockClear();
    rerender(
      <SourcesHub
        client={client}
        query={{ type: "book", q: "", sort: null }}
        onQueryChange={onQueryChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Book · 1" }));
    expect(onQueryChange).toHaveBeenCalledWith({ type: null, q: "", sort: null }, "push");
  });

  it("the picked type renders pressed (the URL state mirrored back)", async () => {
    const client = await seedClient();
    renderHub(client, { type: "journal_article", q: "", sort: null });

    expect(screen.getByRole("button", { name: "Journal article · 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Web page · 4" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
