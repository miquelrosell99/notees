/**
 * JournalsView tests: the feed lists day-classed pages newest-first; the
 * anchor is today when it exists, else the newest entry at or before today;
 * the initial window is a slice around the anchor (IntersectionObserver is
 * absent in jsdom, so it never grows); clicking an entry's title button
 * opens the page view; the empty state creates and opens today.
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
  it("lists day pages newest-first around a today anchor", async () => {
    const client = await seedClient();
    const today = todayIso();
    await Promise.all([
      createDayPage(client, today),
      createDayPage(client, shiftDays(today, -1)),
      createDayPage(client, shiftDays(today, -2)),
      createDayPage(client, shiftDays(today, -3)),
    ]);

    const onOpenPage = vi.fn();
    const { container } = render(<JournalsView client={client} onOpenPage={onOpenPage} />);

    const shown = renderedIds(container);
    expect(shown).toHaveLength(4);
    expect(shown[0]).toBe(dayNodeId(today));
    expect(shown).toEqual([...shown].sort((a, b) => isoOf(b).localeCompare(isoOf(a))));
    // The anchor sits on today's entry.
    const anchor = container.querySelector("[data-anchor='true']");
    expect(anchor?.getAttribute("data-journal-id")).toBe(dayNodeId(today));
  });

  it("anchors on the newest entry at or before today when today has no page", async () => {
    const client = await seedClient();
    const today = todayIso();
    const threeBack = shiftDays(today, -3);
    const fiveBack = shiftDays(today, -5);
    await Promise.all([createDayPage(client, threeBack), createDayPage(client, fiveBack)]);

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    const anchor = container.querySelector("[data-anchor='true']");
    expect(anchor?.getAttribute("data-journal-id")).toBe(dayNodeId(threeBack));
  });

  it("anchors on the newest entry when only future day pages exist", async () => {
    const client = await seedClient();
    const today = todayIso();
    const future = shiftDays(today, 4);
    const further = shiftDays(today, 9);
    await Promise.all([createDayPage(client, future), createDayPage(client, further)]);

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    const anchor = container.querySelector("[data-anchor='true']");
    expect(anchor?.getAttribute("data-journal-id")).toBe(dayNodeId(future));
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

  it("picking a day with no page materializes it and navigates", async () => {
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
      expect(client.getNodeRaw(dayNodeId(target))).toBeDefined();
      expect(
        container.querySelector(".journal-entry[data-anchor='true']")?.getAttribute("data-journal-id"),
      ).toBe(dayNodeId(target));
    });
  });

  it("renders only a window around the anchor for large journals", async () => {
    const client = await seedClient();
    const today = todayIso();
    // 40 past pages: the feed must not mount all of them at once.
    const all = [];
    for (let i = 1; i <= 40; i++) all.push(createDayPage(client, shiftDays(today, -i)));
    await Promise.all(all);

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    const shown = renderedIds(container);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(40);
    // The window is centered on the anchor: newest-first slice from today.
    expect(shown[0]).toBe(dayNodeId(shiftDays(today, -1)));
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

  it("empty state creates today and opens it", async () => {
    const client = await seedClient();
    const onOpenPage = vi.fn();
    render(<JournalsView client={client} onOpenPage={onOpenPage} />);
    fireEvent.click(screen.getByRole("button", { name: /open today/i }));
    await vi.waitFor(() =>
      expect(onOpenPage).toHaveBeenCalledWith(dayNodeId(todayIso())),
    );
    expect(client.getNodeRaw(dayNodeId(todayIso()))).not.toBeUndefined();
  });

  it("clicking Today with no today page materializes it and re-anchors the jump (owner bug 2026-10-22)", async () => {
    const client = await seedClient();
    const today = todayIso();
    const threeBack = shiftDays(today, -3);
    await createDayPage(client, threeBack);

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    // Without a today page the anchor is the nearest day at-or-before…
    expect(
      container.querySelector("[data-anchor='true']")?.getAttribute("data-journal-id"),
    ).toBe(dayNodeId(threeBack));

    fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));

    // …and the jump materializes today rather than landing on that past day.
    await vi.waitFor(() => {
      expect(client.getNodeRaw(dayNodeId(today))).not.toBeUndefined();
      expect(
        container.querySelector("[data-anchor='true']")?.getAttribute("data-journal-id"),
      ).toBe(dayNodeId(today));
    });
  });

  it("clicking Today resurrects a trashed today page instead of landing on a past day (owner bug 2026-10-22, second root)", async () => {
    const client = await seedClient();
    const today = todayIso();
    const threeBack = shiftDays(today, -3);
    await createDayPage(client, today);
    await createDayPage(client, threeBack);
    // Trash today's page: getNodeRaw still sees the row, so a naive
    // existence check no-ops — but every listing read filters it out.
    await client.deleteObject(dayNodeId(today));
    expect(client.getNodeRaw(dayNodeId(today))).not.toBeUndefined();
    expect(client.getNode(dayNodeId(today))).toBeUndefined();

    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));

    // The ensure restores the trashed chain node; the feed anchors on today.
    await vi.waitFor(() => {
      expect(client.getNode(dayNodeId(today))).not.toBeUndefined();
      expect(
        container.querySelector("[data-anchor='true']")?.getAttribute("data-journal-id"),
      ).toBe(dayNodeId(today));
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
