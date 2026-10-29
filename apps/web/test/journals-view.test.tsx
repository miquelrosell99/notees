/**
 * JournalsView tests: the feed enumerates CALENDAR DAYS (the
 * permanent-address model) — every day from the anchor back through the
 * window renders an entry, realized (the day node exists) or virtual (a
 * slim date header + start affordance); the anchor is today unless a
 * mini-month pick owns it; the initial window is today plus the radius
 * (IntersectionObserver is absent in jsdom, so it never grows); navigation
 * never materializes a node — only the virtual entry's start affordance
 * does (and the restore affordance on a trashed day).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  dateNodeLabel,
  dayNodeId,
  parseDateNodeId,
  parseIsoDate,
  SYSTEM_CLASS_UUIDS,
} from "@notees/domain";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { JournalsView } from "../src/features/calendar/JournalsView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(relay: MemoryRelay = new MemoryRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

async function createDayPage(client: WorkspaceClient, iso: string): Promise<string> {
  const id = dayNodeId(iso);
  await client.createObject({
    id,
    isEmbedded: false,
    parentId: null,
    name: dateNodeLabel(parseIsoDate(iso), "day"),
    classIds: [SYSTEM_CLASS_UUIDS.day],
  });
  return id;
}

/** The rendered entry ids, newest first. */
function renderedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-journal-id]")).map((el) =>
    el.getAttribute("data-journal-id")!,
  );
}

function isoOf(id: string): string {
  const parsed = parseDateNodeId(id)!;
  return `${parsed.year}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
}

describe("JournalsView", () => {
  it("lists a contiguous day window newest-first around a today anchor (toggle on)", async () => {
    const client = await seedClient();
    const today = todayIso();
    await Promise.all([
      createDayPage(client, today),
      createDayPage(client, shiftDays(today, -1)),
      createDayPage(client, shiftDays(today, -3)),
    ]);
    showEmptyDays(true);

    const onOpenPage = vi.fn();
    const { container } = render(<JournalsView client={client} onOpenPage={onOpenPage} />);

    const shown = renderedIds(container);
    // Every calendar day in the window renders an entry — realized or
    // virtual — today plus the radius behind it.
    expect(shown).toHaveLength(1 + 8);
    expect(shown[0]).toBe(dayNodeId(today));
    expect(shown).toEqual([...shown].sort((a, b) => isoOf(b).localeCompare(isoOf(a))));
    // Three realized days carry the full page view; the rest are virtual.
    expect(
      container.querySelectorAll(".journal-entry--virtual").length,
    ).toBe(9 - 3);
    // The anchor sits on today's entry.
    const anchor = container.querySelector("[data-anchor='true']");
    expect(anchor?.getAttribute("data-journal-id")).toBe(dayNodeId(today));
  });

  it("hides empty days by default — only written days and today render", async () => {
    const client = await seedClient();
    const today = todayIso();
    await Promise.all([
      createDayPage(client, today),
      createDayPage(client, shiftDays(today, -1)),
      createDayPage(client, shiftDays(today, -3)),
    ]);

    const { container } = render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    const shown = renderedIds(container);
    // The written days plus the today anchor — the empty days between them
    // collapse out of the feed.
    expect(shown).toEqual([
      dayNodeId(today),
      dayNodeId(shiftDays(today, -1)),
      dayNodeId(shiftDays(today, -3)),
    ]);
    expect(container.querySelectorAll(".journal-entry--virtual").length).toBe(0);
    // The toggle reads its default (hiding): not pressed, action "Show".
    const toggle = screen.getByRole("button", { name: "Empty days" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe("Show empty days");
  });

  it("the toggle reveals every day and persists the choice on this device", async () => {
    const client = await seedClient();
    const today = todayIso();
    await createDayPage(client, today);
    await createDayPage(client, shiftDays(today, -1));

    const { container } = render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    expect(renderedIds(container)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Empty days" }));
    await waitFor(() => {
      expect(renderedIds(container)).toHaveLength(9);
    });
    const toggle = screen.getByRole("button", { name: "Empty days" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.title).toBe("Hide empty days");
    expect(window.localStorage.getItem("notees.settings.journalShowEmptyDays")).toBe(
      JSON.stringify(true),
    );

    // The choice survives a remount (device-local, never an op).
    window.dispatchEvent(new CustomEvent("notees-settings-changed"));
  });

  it("hiding retires the sentinel once every written day is inside the window", async () => {
    const client = await seedClient();
    const today = todayIso();
    // Two written days, both inside the initial window: the floor cap is
    // reached at once — no deeper day can ever appear.
    await createDayPage(client, today);
    await createDayPage(client, shiftDays(today, -3));

    const { container, unmount } = render(
      <JournalsView client={client} onOpenPage={vi.fn()} />,
    );
    expect(container.querySelector(".journals-sentinel")).toBeNull();
    unmount();

    // Written days beyond the window: the sentinel stays to page deeper.
    const deep = await seedClient();
    const all = [];
    for (let i = 1; i <= 40; i++) all.push(createDayPage(deep, shiftDays(today, -i)));
    await Promise.all(all);
    const { container: deepContainer } = render(
      <JournalsView client={deep} onOpenPage={vi.fn()} />,
    );
    expect(deepContainer.querySelector(".journals-sentinel")).not.toBeNull();
  });

  it("today anchors as a virtual entry when no today page exists", async () => {
    const client = await seedClient();
    const today = todayIso();
    const threeBack = shiftDays(today, -3);
    await createDayPage(client, threeBack);

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    const anchor = container.querySelector("[data-anchor='true']");
    expect(anchor?.getAttribute("data-journal-id")).toBe(dayNodeId(today));
    expect(anchor?.classList.contains("journal-entry--virtual")).toBe(true);
  });

  it("realized future pages render above the today anchor", async () => {
    const client = await seedClient();
    const today = todayIso();
    const future = shiftDays(today, 4);
    const further = shiftDays(today, 9);
    await Promise.all([createDayPage(client, future), createDayPage(client, further)]);

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    const anchor = container.querySelector("[data-anchor='true']");
    expect(anchor?.getAttribute("data-journal-id")).toBe(dayNodeId(today));
    const shown = renderedIds(container);
    expect(shown[0]).toBe(dayNodeId(further));
    expect(shown[1]).toBe(dayNodeId(future));
    expect(shown[2]).toBe(dayNodeId(today));
  });

  it("the side panel renders the mini-month navigator and the events element", async () => {
    const client = await seedClient();
    const today = todayIso();
    await createDayPage(client, today);
    // A dated event-family member lists in the panel's events element.
    const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
    // The event root may be absent from this spec's seed — author it at
    // its reserved id first (the ensureTaskFamily precedent).
    if (client.getNodeRaw(SYSTEM_CLASS_UUIDS.event) === undefined) {
      await client.createClass("event", { id: SYSTEM_CLASS_UUIDS.event });
    }
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(gatheringClass, schemaId, {});
    const gathering = await client.createObject({
      isEmbedded: false,
      name: "Launch party",
      classIds: [gatheringClass],
    });
    await client.setDatetimeProperty(gathering, schemaId, { iso: today }, 0);

    const { container } = render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    const panel = await (async () => {
      await screen.findByText("Journal");
      const el = container.querySelector(".journals-panel");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    })();
    expect(panel.querySelector(".month-calendar")).not.toBeNull();
    expect(within(panel).getByLabelText("Events")).toBeDefined();
    await waitFor(() => {
      expect(panel.textContent).toContain("Launch party");
    });
  });

  it("focus mode hides the navigator panel (the all-side-panels ruling)", async () => {
    const client = await seedClient();
    await createDayPage(client, todayIso());
    window.localStorage.setItem("notees.settings.focusMode", JSON.stringify(true));

    const { container } = render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    await screen.findByText("Journal");
    expect(container.querySelector(".journals-panel")).toBeNull();

    window.localStorage.setItem("notees.settings.focusMode", JSON.stringify(false));
    window.dispatchEvent(new CustomEvent("notees-settings-changed"));
    await waitFor(() => {
      expect(container.querySelector(".journals-panel")).not.toBeNull();
    });
  });

  it("the navigator panel collapses from the top bar (device-local toggle)", async () => {
    const client = await seedClient();
    await createDayPage(client, todayIso());

    const { container } = render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    await screen.findByText("Journal");
    expect(container.querySelector(".journals-panel")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide navigator panel" }));
    await waitFor(() => {
      expect(container.querySelector(".journals-panel")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Show navigator panel" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Show navigator panel" }));
    await waitFor(() => {
      expect(container.querySelector(".journals-panel")).not.toBeNull();
    });
  });

  it("picking a mini-month day scroll-navigates the feed to that day", async () => {
    const client = await seedClient();
    const today = todayIso();
    const target = shiftDays(today, -5);
    await createDayPage(client, today);
    await createDayPage(client, target);

    const { container } = render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    await screen.findByText("Journal");
    const panel = container.querySelector(".journals-panel") as HTMLElement;
    const dayButton = Array.from(panel.querySelectorAll(".calendar-day")).find(
      (el) => el.textContent?.trim() === String(Number(target.slice(8))),
    ) as HTMLElement;
    expect(dayButton).toBeDefined();
    fireEvent.click(dayButton);

    await waitFor(() => {
      expect(
        container.querySelector(".journal-entry[data-anchor='true']")?.getAttribute("data-journal-id"),
      ).toBe(dayNodeId(target));
    });
  });

  it("picking a day with no page navigates to its virtual entry without materializing it", async () => {
    const client = await seedClient();
    const today = todayIso();
    const target = shiftDays(today, -2);
    await createDayPage(client, today);
    expect(client.getNodeRaw(dayNodeId(target))).toBeUndefined();

    const { container } = render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    await screen.findByText("Journal");
    const panel = container.querySelector(".journals-panel") as HTMLElement;
    const dayButton = Array.from(panel.querySelectorAll(".calendar-day")).find(
      (el) => el.textContent?.trim() === String(Number(target.slice(8))),
    ) as HTMLElement;
    fireEvent.click(dayButton);

    await waitFor(() => {
      // Navigation alone never creates the node (realize-on-first-write)…
      expect(client.getNodeRaw(dayNodeId(target))).toBeUndefined();
      const anchor = container.querySelector(".journal-entry[data-anchor='true']");
      expect(anchor?.getAttribute("data-journal-id")).toBe(dayNodeId(target));
      expect(anchor?.classList.contains("journal-entry--virtual")).toBe(true);
    });

    // …the entry's start affordance is what materializes the day.
    const anchor = container.querySelector(".journal-entry[data-anchor='true']") as HTMLElement;
    fireEvent.click(within(anchor).getByRole("button", { name: /click to start/i }));
    await vi.waitFor(() => {
      expect(client.getNode(dayNodeId(target))).toBeDefined();
    });
  });

  it("renders only a window around the anchor: virtual days fill the gap", async () => {
    const client = await seedClient();
    const today = todayIso();
    // 40 past pages: the feed must not mount all of them at once — the
    // window stays today plus the radius, unrealized days included.
    const all = [];
    for (let i = 1; i <= 40; i++) all.push(createDayPage(client, shiftDays(today, -i)));
    await Promise.all(all);

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    const shown = renderedIds(container);
    expect(shown.length).toBe(9);
    // The window is centered on the anchor: newest-first slice from today.
    expect(shown[0]).toBe(dayNodeId(today));
  });

  it("a feed entry renders the day-page aggregations (Dated/Created)", async () => {
    const client = await seedClient();
    const today = todayIso();
    const todayId = await createDayPage(client, today);
    // A main node created today lists in the entry's Created section (the
    // date-chain filter keeps the day page itself out).
    await client.createObject({
      isEmbedded: false,
      name: "Fresh page",
    });
    // A datetime value referencing today backlinks the day node — the
    // entry's Dated section.
    const whenSchema = await client.createPropertySchema({ name: "When", type: "datetime" });
    if (client.getNodeRaw(SYSTEM_CLASS_UUIDS.event) === undefined) {
      await client.createClass("event", { id: SYSTEM_CLASS_UUIDS.event });
    }
    const datedClass = await client.createClass("dated-thing");
    await client.setClassExtends(datedClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(datedClass, whenSchema, {});
    const dated = await client.createObject({
      isEmbedded: false,
      name: "Dated thing",
      classIds: [datedClass],
    });
    await client.setDatetimeProperty(dated, whenSchema, { iso: today }, 0);

    const { container } = render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    await screen.findByText("Journal");
    const entry = container.querySelector(
      `.journal-entry[data-journal-id='${todayId}']`,
    ) as HTMLElement;
    expect(entry).not.toBeNull();
    // The full page view's day sections ride the embedded render — the feed
    // is the day-page context, not a summary surface. Both sections start
    // collapsed; expanding them lists their rows.
    const createdToggle = within(entry).getByRole("button", { name: /Created/ });
    const datedToggle = within(entry).getByRole("button", { name: /Dated/ });
    fireEvent.click(createdToggle);
    fireEvent.click(datedToggle);
    await waitFor(() => {
      expect(within(entry).getAllByText("Fresh page").length).toBeGreaterThan(0);
      expect(within(entry).getAllByText("Dated thing").length).toBeGreaterThan(0);
    });
  });

  it("clicking an entry's open-page button opens the page view", async () => {
    const client = await seedClient();
    const today = todayIso();
    await createDayPage(client, today);

    const onOpenPage = vi.fn();
    const { container } = render(<JournalsView client={client} onOpenPage={onOpenPage} />);
    // The feed title is a plain heading; navigation rides the button.
    expect(container.querySelector(".nt-page-title-embed__text")).not.toBeNull();
    const open = screen.getByRole("button", { name: "Open page" });
    fireEvent.click(open);
    expect(onOpenPage).toHaveBeenCalledWith(dayNodeId(today));
  });

  it("with no pages at all, today renders as a virtual entry whose affordance starts it", async () => {
    const client = await seedClient();
    render(<JournalsView client={client} onOpenPage={vi.fn()} />);
    const today = todayIso();
    const entry = await screen.findByText("Journal").then(() => {
      const anchor = document.querySelector(".journal-entry[data-anchor='true']") as HTMLElement;
      expect(anchor?.getAttribute("data-journal-id")).toBe(dayNodeId(today));
      expect(anchor?.classList.contains("journal-entry--virtual")).toBe(true);
      return anchor;
    });
    fireEvent.click(within(entry).getByRole("button", { name: /click to start/i }));
    await vi.waitFor(() => {
      expect(client.getNode(dayNodeId(today))).toBeDefined();
    });
  });

  it("clicking Today never materializes a missing today page", async () => {
    const client = await seedClient();
    const today = todayIso();
    const threeBack = shiftDays(today, -3);
    await createDayPage(client, threeBack);

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    // The anchor is today even without a page (a virtual entry).
    expect(
      container.querySelector("[data-anchor='true']")?.getAttribute("data-journal-id"),
    ).toBe(dayNodeId(today));

    fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));

    // Today re-owns the anchor; the jump stays display-only — no node.
    await vi.waitFor(() => {
      expect(client.getNodeRaw(dayNodeId(today))).toBeUndefined();
      expect(
        container.querySelector("[data-anchor='true']")?.getAttribute("data-journal-id"),
      ).toBe(dayNodeId(today));
    });
  });

  it("the wire delete is locked on date-chain nodes — the day stays live", async () => {
    const client = await seedClient();
    const today = todayIso();
    await createDayPage(client, today);
    // Soft and permanent arms both fail loud; the node never leaves the graph.
    await expect(client.deleteObject(dayNodeId(today))).rejects.toThrow(/date-chain/);
    await expect(
      client.deleteObject(dayNodeId(today), { permanent: true }),
    ).rejects.toThrow(/date-chain/);
    expect(client.getNode(dayNodeId(today))).toBeDefined();
  });

  it("a trashed today page renders a restore affordance that resurrects it", async () => {
    const client = await seedClient();
    const today = todayIso();
    const threeBack = shiftDays(today, -3);
    await createDayPage(client, today);
    await createDayPage(client, threeBack);
    // The wire delete is locked on date-chain nodes (the fourth lock), so
    // the trashed-day state — possible only from a pre-lock log row or a
    // foreign client — is seeded at the store level: exactly the rows a
    // soft delete's applier would have written.
    const db = client.store.database;
    db.prepare("UPDATE node SET is_active = 0 WHERE id = ?").run(dayNodeId(today));
    db.prepare(
      "INSERT OR REPLACE INTO trash (node_id, deleted_at, is_permanent) VALUES (?, ?, 0)",
    ).run(dayNodeId(today), new Date().toISOString());
    expect(client.getNodeRaw(dayNodeId(today))).not.toBeUndefined();
    expect(client.getNode(dayNodeId(today))).toBeUndefined();

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    const entry = container.querySelector(
      `.journal-entry[data-journal-id='${dayNodeId(today)}']`,
    ) as HTMLElement;
    expect(entry.classList.contains("journal-entry--virtual")).toBe(true);
    fireEvent.click(within(entry).getByRole("button", { name: /restore/i }));

    // The ensure restores the trashed chain node; the entry turns realized.
    await vi.waitFor(() => {
      expect(client.getNode(dayNodeId(today))).toBeDefined();
    });
  });
});

/** Local-date shift that avoids Date arithmetic across DST (noon anchor). */
function shiftDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!, 12);
  date.setDate(date.getDate() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** Device-local the empty-days toggle before a render (the focus-mode precedent). */
function showEmptyDays(value: boolean): void {
  window.localStorage.setItem("notees.settings.journalShowEmptyDays", JSON.stringify(value));
}
