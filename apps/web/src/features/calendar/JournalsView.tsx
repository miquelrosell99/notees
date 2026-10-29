/**
 * JournalsView — the journal feed: a continuous, today-centered scroll of
 * day entries, newest first. A day page is PERMANENTLY ADDRESSABLE
 * scaffolding, not a record that comes and goes (the owner ruling,
 * 2026-10-29): every calendar day in the window renders an entry whether or
 * not the day node exists in the log yet. A REALIZED day (the node exists
 * and is live) renders its full embedded page view; an UNREALIZED day
 * renders a slim virtual entry — the realized entries' own embedded
 * header register (muted placeholder icon + plain date title, the same
 * 46rem measure) plus one muted start affordance — and the node
 * materializes through the journal-gated `ensureDateChain` only when the
 * user actually writes (the realize-on-first-write model: display never
 * depends on node existence). The placeholder names the state plainly
 * ("Empty day — click to start"); a trashed day page (possible until the
 * delete lock and for legacy rows) restores through the same click —
 * `ensureDateChain` brings it back live.
 *
 * The window: the feed enumerates CALENDAR DAYS, not pages — a contiguous
 * run from the anchor day (today, or the focus day) back N days, plus the
 * realized future day pages above today. N grows by PAGE days per bottom
 * sentinel crossing; growth appends below the viewport, so no scroll
 * compensation rides the extend. The anchor is always present by
 * construction (it bounds the window), so navigation — Today, the
 * mini-month pick — is a pure state move: set the focus day, grow the
 * window if it sits outside, and one layout effect scrolls the anchor
 * entry to the top on the render where the anchor id changes. No
 * materialization ever gates navigation (the old pendingJump machinery
 * died with the existence-gated model).
 *
 * Reloading re-centers on today. Each realized entry's date header is a
 * plain heading; the "Open page" button beside it opens that page in the
 * full page view.
 *
 * The side panel: the mini-month navigator + the
 * events element (the calendar view's retired panel — the journal is the
 * day-page context the events list belongs to). Picking a day in the
 * mini-month scroll-navigates the feed to that day's entry (realized or
 * virtual — no node is created by navigation alone).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, dayNodeId } from "@notees/domain";

import { useDeviceSetting } from "../settings/deviceSettings.js";

import { PageView } from "../../ui/PageView.js";
import { EventsPanel } from "./EventsPanel.js";
import { MonthCalendar } from "./MonthCalendar.js";
import { rawDateKeywordOf } from "../../ui/dateDisplay.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import { Icon } from "../../ui/Icon.js";
import { definedNodeIcon } from "../../ui/iconFor.js";
import { GhostRow } from "../../ui/GhostRow.js";
import { addDaysIso, daysBetweenIsos, todayIsoLocal } from "./calendarViewUtils.js";
import { Button } from "../../components/ui/kit/Button.js";
import { SurfaceTopBar } from "../../components/ui/kit/SurfaceTopBar.js";
import { useSidePanel } from "../../components/ui/kit/SidePanel.js";
import { readDateFormat } from "../../ui/dateDisplay.js";
import "./JournalsView.css";

/** Entries mounted around the anchor before the sentinel takes over. */
const INITIAL_RADIUS = 8;
/** Days added per sentinel crossing. */
const PAGE = 10;

/**
 * A feed entry: one calendar day. `realized` — the day node exists and is
 * live (the full page view renders); `trashed` — the node exists but is
 * inactive (the restore affordance renders). Both false — the day was
 * never written: the pure virtual entry.
 */
interface DayEntry {
  iso: string;
  id: string;
  realized: boolean;
  trashed: boolean;
}

/**
 * The virtual entry's title: the user's date-format token layout applied
 * to the ISO string directly (the same recipe `formatDateName` uses for
 * stored labels) — never through `Date` parsing, which would shift the day
 * west of UTC.
 */
function displayTitleOf(iso: string): string {
  const [year, month, day] = iso.split("-");
  return readDateFormat()
    .replace(/YYYY/g, year!)
    .replace(/MM/g, month!)
    .replace(/DD/g, day!);
}

export function JournalsView({
  client,
  onOpenPage,
}: {
  client: AnyClient;
  onOpenPage: (nodeId: string) => void;
}) {
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  /** Live day-classed pages by ISO (listPages filters `is_active = 1`). */
  const pagesByIso = useMemo(() => {
    const day = SYSTEM_CLASS_UUIDS.day;
    const map = new Map<string, { id: string }>();
    for (const page of client.listPages()) {
      if (page.classIds.includes(day)) {
        const key = rawDateKeywordOf(page);
        if (key !== "") map.set(
          `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
          page,
        );
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads resolve through the client notification (version)
  }, [client, version]);

  /**
   * The day class's effective icon — the placeholder icon renders EXACTLY
   * what a realized day page's header resolves (definedNodeIcon over a
   * synthetic day-classed node), so a user-edited day class icon flows to
   * the ghost entries too; null (nothing defined anywhere) renders no icon
   * span, the realized header's own register.
   */
  const dayClassIcon = useMemo(() => {
    const classesById = new Map<string, string | null>(
      client.listClasses().map((cls) => [cls.id, cls.icon]),
    );
    return definedNodeIcon({ icon: "", classIds: [SYSTEM_CLASS_UUIDS.day] }, classesById);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads resolve through the client notification (version)
  }, [client, version]);

  const todayIso = todayIsoLocal();
  /** The side panel's device-local collapse (the calendar view's old register). */
  const [panelCollapsed, setPanelCollapsed] = useDeviceSetting("journalPanelCollapsed", false);
  /** Focus mode hides every side panel. */
  const [focusMode] = useDeviceSetting("focusMode", false);
  /** The side panel's selected day (local ISO) — the events scope anchor. */
  const [panelIso, setPanelIso] = useState(todayIso);
  /** The feed's focus day while set: overrides the today anchor. */
  const [focusIso, setFocusIso] = useState<string | null>(null);
  /** First-day-of-week device setting for the mini-month. */
  const [firstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);
  /**
   * The empty-days toggle (device-local, default OFF = hiding): hiding
   * collapses the gaps — the feed lists written days plus the anchor day;
   * showing renders every calendar day in the window.
   */
  const [showEmptyDays, setShowEmptyDays] = useDeviceSetting("journalShowEmptyDays", false);
  /** Days beyond the initial radius revealed by the bottom sentinel. */
  const [extraBefore, setExtraBefore] = useState(0);

  const anchorIso = focusIso ?? todayIso;
  /** The oldest written day — the floor cap when hiding (nothing deeper can ever appear). */
  const oldestRealizedIso = useMemo(() => {
    let min: string | null = null;
    for (const iso of pagesByIso.keys()) {
      if (min === null || iso < min) min = iso;
    }
    return min;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads resolve through the client notification (version)
  }, [pagesByIso, version]);
  /**
   * The window: realized future day pages above the cap, then every
   * calendar day from the cap (the newer of today and the anchor) back to
   * the floor (the anchor minus the radius, never stopping short of today
   * — a far-future focus must not drop the days between today and the
   * floor). The anchor is always inside by construction. With the toggle
   * off, the unrealized days FILTER OUT at render: the underlying day
   * window stays contiguous (the sentinel's growth math is unchanged) but
   * only written days and the anchor day mount.
   */
  const entries = useMemo<DayEntry[]>(() => {
    const capIso = anchorIso > todayIso ? anchorIso : todayIso;
    const radiusFloor = addDaysIso(anchorIso, -(INITIAL_RADIUS + extraBefore));
    const floorIso = radiusFloor > todayIso ? todayIso : radiusFloor;
    const future = [...pagesByIso.keys()]
      .filter((iso) => iso > capIso)
      .sort((a, b) => b.localeCompare(a));
    const list: DayEntry[] = future.map((iso) => {
      const page = pagesByIso.get(iso)!;
      return { iso, id: page.id, realized: true, trashed: false };
    });
    const span = daysBetweenIsos(floorIso, capIso);
    for (let i = 0; i <= span; i++) {
      const iso = addDaysIso(capIso, -i);
      const page = pagesByIso.get(iso);
      if (page !== undefined) {
        list.push({ iso, id: page.id, realized: true, trashed: false });
      } else {
        const id = dayNodeId(iso);
        list.push({
          iso,
          id,
          realized: false,
          trashed: client.getNodeRaw(id) !== undefined,
        });
      }
    }
    if (showEmptyDays) return list;
    return list.filter(
      (entry) => entry.realized || entry.trashed || entry.iso === anchorIso,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads resolve through the client notification (version)
  }, [client, pagesByIso, anchorIso, todayIso, extraBefore, showEmptyDays, version]);

  const anchorId = dayNodeId(anchorIso);
  const anchorIndex = entries.findIndex((entry) => entry.iso === anchorIso);

  // --- windowing ------------------------------------------------------------

  /**
   * The past is unbounded — every calendar day back exists as a potential
   * entry — so the sentinel rides the list's tail: a crossing reveals PAGE
   * older days (appended below the viewport, never disturbing the scroll).
   * HIDING changes the growth: the window jumps STRAIGHT to the next
   * written day older than the floor (plus one page of margin), so every
   * crossing mounts at least one new entry — a gap of empty days can never
   * starve the sentinel (IntersectionObserver only re-fires on a
   * visibility CHANGE, and a crossing that mounts nothing would leave the
   * sentinel where it is, silent). When no written day is older than the
   * floor the floor cap is reached and the sentinel retires.
   */
  const extendPast = () => {
    if (showEmptyDays) {
      setExtraBefore((n) => n + PAGE);
      return;
    }
    setExtraBefore((n) => {
      const floorIso = addDaysIso(anchorIso, -(INITIAL_RADIUS + n));
      const older = [...pagesByIso.keys()]
        .filter((iso) => iso < floorIso)
        .sort((a, b) => b.localeCompare(a));
      const next = older[0];
      if (next === undefined) return n + PAGE; // floor cap reached; the sentinel retires
      const needed = daysBetweenIsos(next, anchorIso) - INITIAL_RADIUS;
      return Math.max(n + PAGE, needed + PAGE);
    });
  };

  /**
   * The floor cap: hiding with every written day already inside the window
   * (or none at all) means nothing deeper can appear — the sentinel
   * retires instead of paging an ever-deeper empty window.
   */
  const floorReached =
    !showEmptyDays &&
    (oldestRealizedIso === null || addDaysIso(anchorIso, -(INITIAL_RADIUS + extraBefore)) <= oldestRealizedIso);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const bottom = bottomSentinelRef.current;
    if (bottom === null) return;
    const observer = new IntersectionObserver(
      (entriesObserved) => {
        for (const entry of entriesObserved) {
          if (entry.isIntersecting && entry.target === bottom) extendPast();
        }
      },
      { root: listRef.current, rootMargin: "600px" },
    );
    observer.observe(bottom);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sentinel wiring follows the visible window
  }, [entries.length]);

  /**
   * The anchor's offset within the list's CONTENT. Rect-based, not
   * offsetTop: the list is not a positioned ancestor, so offsetTop would
   * measure from some higher offsetParent and overshoot — scrolling PAST
   * the entry and hiding the day page's header.
   */
  const anchorContentTop = (): number | null => {
    const el = listRef.current;
    const anchor = el?.querySelector(".journal-entry[data-anchor='true']");
    if (el === null || el === undefined || !(anchor instanceof HTMLElement)) return null;
    return anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  };

  /**
   * Scroll the anchor entry to the top of the feed whenever the anchor
   * DAY changes (first mount, Today, a mini-month pick) — the anchor is
   * present by construction, so no async materialization can delay the
   * scroll. Deliberately NOT keyed on version: a client notification
   * re-renders entries in place and must never yank the viewport.
   */
  const lastScrolledAnchorRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (lastScrolledAnchorRef.current === anchorId) return;
    const el = listRef.current;
    const top = anchorContentTop();
    if (el !== null && el !== undefined && top !== null) {
      el.scrollTop = top;
      lastScrolledAnchorRef.current = anchorId;
    }
  }, [anchorId, entries.length]);

  /**
   * Jump to today: a pure state move — today always has an entry (virtual
   * if the day was never written, restore-armed if it was trashed), so
   * Today re-owns the anchor and the layout effect scrolls. No node is
   * created by the jump itself (realize-on-first-write).
   */
  const scrollToToday = () => {
    setFocusIso(null); // Today re-owns the anchor.
    setPanelIso(todayIso);
  };

  /**
   * The side panel's day pick: scroll-navigate the feed to that day's
   * entry. A day outside the current window grows the past radius first
   * (one state batch — the anchor effect scrolls once the entry exists).
   * The picked day also becomes the panel's events scope anchor.
   * Navigation never materializes a node.
   */
  const navigateToDay = (iso: string): void => {
    setPanelIso(iso);
    if (iso < todayIso) {
      const needed = daysBetweenIsos(iso, todayIso) - INITIAL_RADIUS;
      if (needed > extraBefore) setExtraBefore(needed + PAGE);
    }
    setFocusIso(iso);
  };

  /**
   * The virtual entry's ghost realize: the day's first real write — ensure
   * the chain (creating the node, or restoring a pre-lock trashed one) and
   * add the day's first empty block, so the entry swaps to the full
   * editable page view with a row ready to type into (the ghost's own
   * contract — the click IS the add). Behind the journal feature gate.
   */
  const startDay = (iso: string): void => {
    if (!client.isFeatureEnabled("journal")) return;
    void client
      .ensureDateChain(iso)
      .then(({ day }) => client.createObject({ parentId: day, contentAst: [] }))
      .catch(() => {});
  };

  /**
   * The navigator panel + its top-bar toggle as ONE component-level unit
   * (useSidePanel): the side is declared once — "right", the body's panel
   * column — and the toggle lands in the bar's far-right trailing slot on
   * the same side, so the two can never drift apart (the regression this
   * replaces: the toggle led the bar, left of the title, while the panel
   * rendered in the right column).
   */
  const navigatorPanel = useSidePanel({
    side: "right",
    open: !panelCollapsed,
    onToggle: () => setPanelCollapsed(!panelCollapsed),
    label: "navigator panel",
    className: "journals-panel",
    children: (
      <>
        <MonthCalendar
          selectedDate={panelIso}
          onSelectDate={navigateToDay}
          firstDayOfWeek={firstDayOfWeek}
          hasNote={(iso) => pagesByIso.has(iso)}
          onSelectMonth={(year, month) => {
            void client.ensureDateChain(`${year}-${String(month).padStart(2, "0")}-01`).then(({ month: monthId }) => onOpenPage(monthId));
          }}
          onSelectYear={(year) => {
            void client
              .ensureDateChain(`${year}-01-01`)
              .then(({ year: yearId }) => onOpenPage(yearId));
          }}
        />
        <EventsPanel client={client} selectedIso={panelIso} onOpenPage={onOpenPage} />
      </>
    ),
  });

  return (
    <div className="journals-view">
      {/* The hub chrome rides the shared SurfaceTopBar:
          pinned above the feed, full card width, so the feed's scrollbar
          stays at the card border. The navigator-panel toggle TRAILS the
          bar at the far right (useSidePanel links it to the right-column
          panel — one side declared once). The ACTIONS ride the empty-days
          toggle (the eye pair — the fleet's show/hide register: eye-off =
          the gaps are collapsed, the default; the open eye = every
          calendar day renders) and Today — a jump that re-owns the today
          anchor (today always has an entry under the permanent-address
          model). Discrete day-steppers stay retired: day-jumping rides
          the calendar popup, the sidebar Today row, and each entry's
          Open-page button. */}
      <SurfaceTopBar
        icon="mdi-notebook-outline"
        title="Journal"
        actions={
          <>
            {/* The icon toggle-button composition (the GraphView register):
               ghost sm + aria-pressed + the active state-layer; the icon
               names the state, the stable accessible name carries the
               setting, the tooltip names the action. */}
            <Button
              variant="ghost"
              size="sm"
              icon={showEmptyDays ? "mdi-eye-outline" : "mdi-eye-off-outline"}
              active={showEmptyDays}
              aria-pressed={showEmptyDays}
              aria-label="Empty days"
              title={showEmptyDays ? "Hide empty days" : "Show empty days"}
              onClick={() => setShowEmptyDays(!showEmptyDays)}
            />
            {/* The outline variant + "Jump to today" title/aria: the bordered button reads
               clickable where the ghost idiom doesn't, and the short
               "Today" label names the destination, not the jump. */}
            <Button
              variant="outline"
              size="sm"
              title="Jump to today"
              aria-label="Jump to today"
              onClick={scrollToToday}
            >
              Today
            </Button>
          </>
        }
        trailing={navigatorPanel.toggle}
      />
      <div className="journals-body">
        <div className="journals-list" ref={listRef}>
          {entries.map((entry, i) => (
            <article
              key={entry.id}
              className={`journal-entry${entry.realized ? "" : " journal-entry--virtual"}`}
              data-journal-id={entry.id}
              data-anchor={i === anchorIndex ? "true" : undefined}
            >
              {entry.realized ? (
                <PageView client={client} pageId={entry.id} onOpenPage={onOpenPage} embedded />
              ) : (
                /* The virtual entry mirrors the realized embedded register
                   (PageChrome's compact branch): the header rides DIRECTLY
                   under .nt-page — the journal zeroes the page padding
                   (.journal-entry .nt-page), so the entry's chrome sits at
                   the capped column's edge. The placeholder icon renders
                   EXACTLY the realized day pages' icon (the day class's
                   effective icon, resolved the same way — user edits flow
                   through); nothing defined → no icon span, the realized
                   header's own register. The add affordance IS the
                   outliner's GhostRow: the block gutter + "+ Add block"
                   the body rows wear, at the block left edge (the old
                   free-floating sentence read as stray text, not an
                   affordance). The click realizes the ghost — ensure the
                   chain and add the day's first empty block (a pre-lock
                   trashed day restores through the same ensure). */
                <div className="nt-page">
                  <div className="page-header-section">
                    <header className="nt-page-header">
                      <div className="page-header__title-row">
                        {dayClassIcon !== null && (
                          <span className="page-icon-btn journal-virtual-icon" aria-hidden="true">
                            <Icon path={dayClassIcon} size={1.4} className="page-icon-large" />
                          </span>
                        )}
                        <span className="nt-page-title-wrap">
                          <span className="nt-page-title-embed">
                            <span className="nt-page-title-embed__text">
                              {displayTitleOf(entry.iso)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </header>
                  </div>
                  {client.isFeatureEnabled("journal") && (
                    <GhostRow parentId={entry.id} onRealize={() => startDay(entry.iso)} />
                  )}
                </div>
              )}
            </article>
          ))}
          {!floorReached && (
            <div ref={bottomSentinelRef} className="journals-sentinel" aria-hidden="true" />
          )}
        </div>
        {/* Focus mode hides every side panel; the linked useSidePanel unit
            owns the collapsed state itself (open = !panelCollapsed). */}
        {!focusMode && navigatorPanel.panel}
      </div>
    </div>
  );
}
