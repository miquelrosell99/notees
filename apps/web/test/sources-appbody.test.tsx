/**
 * AppBody — the Sources hub branch + the hub-switch query reset (the
 * whole-hub review findings 1 + 2):
 *
 * - FINDING 2: an AppBody render at activeNav="sources" pins the prop
 *   forwarding — the hub receives the App-owned query state (the top-bar
 *   toolbar's search box mirrors `query.q`) and the URL seam (typing fires
 *   onSourcesQueryChange with "replace").
 * - FINDING 1: switching hubs through the sidebar (Sources → Pages →
 *   Sources) RESETS the sources query to the default in "replace" mode
 *   beside resetCalendarRoute — the bare /sources the navigation lands on
 *   carries no stale filter state (law 9 state/URL parity, the calendar
 *   route precedent). Before the fix the hub re-rendered the stale filter
 *   after the round trip.
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js), a
 * minimal source family so the top-bar toolbar renders (an empty library
 * renders the Add-first-source hint, no toolbar).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState, type RefObject } from "react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import type { AnyClient } from "../src/ui/app/clients.js";
import type { SyncStatusSnapshot } from "../src/core/workspace-client/index.js";
import { AppBody } from "../src/ui/app/AppBody.js";
import type { NavKey } from "../src/ui/app/Sidebar.js";
import {
  DEFAULT_SOURCES_QUERY,
  type SourcesQueryState,
} from "../src/features/sources/sourcesQuery.js";

const WS = "0192d000-0000-7000-8000-00000000a401";
const ACTOR = "0192d000-0000-7000-8000-00000000a402";

const SYNC_IDLE: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

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
  window.localStorage.clear();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);

  for (const name of ["source", "journal_article"] as const) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id: SYSTEM_CLASS_UUIDS[name] });
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.journal_article, [SYSTEM_CLASS_UUIDS.source]);
  const P = SYSTEM_PROPERTY_UUIDS;
  await client.createPropertySchema({
    id: P.citekey,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.citekey,
    type: "text",
    multi: false,
    scopeClassIds: [SYSTEM_CLASS_UUIDS.source],
  });
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.source, P.citekey, {});
  await client.createObject({
    isEmbedded: false,
    name: "On the Analytical Engine",
    classIds: [SYSTEM_CLASS_UUIDS.journal_article],
  });
  return client;
}

interface HarnessBag {
  pushNav: ReturnType<typeof vi.fn>;
  resetCalendarRoute: ReturnType<typeof vi.fn>;
  /** Every onSourcesQueryChange call, in order. */
  calls: Array<{ next: SourcesQueryState; mode: "push" | "replace" }>;
}

/** The App-shaped state harness: AppBody's props wired like App wires them. */
function renderAppBody(client: WorkspaceClient, initialQuery: SourcesQueryState) {
  const bag: HarnessBag = { pushNav: vi.fn(), resetCalendarRoute: vi.fn(), calls: [] };
  function Harness() {
    const [nav, setNav] = useState<NavKey>("sources");
    const [query, setQuery] = useState(initialQuery);
    const clientRef: RefObject<AnyClient | null> = useRef(client);
    const noop = () => {};
    return (
      <AppBody
        client={client}
        clientRef={clientRef}
        user={null}
        offline={false}
        sessionSignedIn={false}
        syncStatus={SYNC_IDLE}
        setSyncDetailsOpen={noop}
        setAdminSettingsOpen={noop}
        selectedPageId={null}
        activeNav={nav}
        setActiveNav={setNav}
        setSettingsSection={noop}
        setSearchOpen={noop}
        setSelectedPageId={noop}
        pushNav={bag.pushNav}
        openPage={vi.fn()}
        openPageAt={vi.fn()}
        openInSidebar={vi.fn()}
        openSettingsSection={vi.fn()}
        handleNodeDeleted={vi.fn()}
        handleSignOut={async () => {}}
        handleForgetServer={noop}
        handleConnectServer={vi.fn()}
        searchOpen={false}
        settingsSection={null}
        serverUrl=""
        token=""
        shareTarget={undefined}
        sectionsLayout={false}
        setPresentingId={noop}
        reorderSidebarCard={vi.fn()}
        rightPanelOpen={false}
        setRightPanelOpen={noop}
        focusMode={false}
        sidebarCards={[]}
        setSidebarCards={noop}
        closeSidebarCard={vi.fn()}
        calendarRoute={null}
        onCalendarRouteChange={vi.fn()}
        onCalendarTitle={vi.fn()}
        resetCalendarRoute={bag.resetCalendarRoute}
        cardsReview={false}
        onExitCardsReview={noop}
        resetCardsReview={noop}
        sourcesQuery={query}
        onSourcesQueryChange={(next, mode) => {
          bag.calls.push({ next, mode });
          setQuery(next);
        }}
      />
    );
  }
  return { ...render(<Harness />), bag };
}

describe("AppBody — the Sources hub branch (review finding 2)", () => {
  it("renders the hub with the App-owned query state and forwards the URL seam", async () => {
    const client = await seedClient();
    const { bag } = renderAppBody(client, { type: null, q: "smith", sort: null });

    // The hub composes: top bar, facets pane, the table region.
    expect(screen.getByRole("heading", { name: "Sources" })).not.toBeNull();
    expect(screen.getByRole("complementary", { name: "Source types" })).not.toBeNull();
    expect(screen.getByRole("region", { name: /sources/i })).not.toBeNull();

    // The App-owned query state reaches the hub: the search box (in the
    // surface top bar) mirrors q.
    await waitFor(() => {
      expect(screen.getByLabelText("Search sources")).toHaveValue("smith");
    });

    // The URL seam forwards: typing replaces (the App's navigateSources).
    fireEvent.change(screen.getByLabelText("Search sources"), {
      target: { value: "smithsonian" },
    });
    await waitFor(() => {
      expect(bag.calls.length).toBeGreaterThan(0);
    });
    expect(bag.calls[0]).toEqual({
      next: { type: null, q: "smithsonian", sort: null },
      mode: "replace",
    });
  });
});

describe("AppBody — the hub-switch reset (review finding 1)", () => {
  it("switching hubs resets the sources query to the default (replace), beside the calendar reset", async () => {
    const client = await seedClient();
    const { bag } = renderAppBody(client, { type: null, q: "smith", sort: null });
    await waitFor(() => {
      expect(screen.getByLabelText("Search sources")).toHaveValue("smith");
    });

    // Sources → Pages through the sidebar.
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));

    // The calendar precedent, now the sources pair: the query resets in
    // replace mode (the bare /sources carries no filter state) and the
    // navigation pushes the target hub's path.
    expect(bag.resetCalendarRoute).toHaveBeenCalled();
    expect(bag.calls[bag.calls.length - 1]).toEqual({
      next: DEFAULT_SOURCES_QUERY,
      mode: "replace",
    });
    expect(bag.pushNav).toHaveBeenCalledWith("/pages", { node: null, nav: "pages" });

    // Pages → Sources and back: the hub renders the DEFAULT state — before
    // the fix the stale "smith" filter survived the round trip (the hub
    // rendered filtered state under a bare /sources URL).
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sources" })).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Search sources")).toHaveValue("");
    });
  });
});
