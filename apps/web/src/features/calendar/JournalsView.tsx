/**
 * JournalsView — the journal feed: a continuous, today-centered scroll of
 * page views, one per existing day-classed page, newest first. Scrolling up
 * reveals future existing day pages, scrolling down older ones; reloading
 * re-centers on today. Each entry's date header is a plain heading; the
 * "Open page" button beside it opens that page in the full page view.
 *
 * Every day page exists in the local store, so "loading" is purely a
 * rendering window: a small slice around today mounts first and
 * IntersectionObserver sentinels grow it in both directions. Prepends
 * compensate scrollTop so the viewport stays put.
 *
 * The side panel (owner 2026-10-24): the mini-month navigator + the
 * events element (the calendar view's retired panel — the journal is the
 * day-page context the events list belongs to). Picking a day in the
 * mini-month scroll-navigates the feed to that day page, materializing it
 * through the same journal-gated ensure as the Today jump.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, dayNodeId } from "@notees/domain";

import { useDeviceSetting } from "../settings/deviceSettings.js";

import { PageView } from "../../ui/PageView.js";
import { EventsPanel } from "./EventsPanel.js";
import { MonthCalendar } from "./MonthCalendar.js";
import { rawDateKeywordOf } from "../../ui/dateDisplay.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import { todayIsoLocal } from "./calendarViewUtils.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import "./JournalsView.css";

/** Entries mounted around today before the sentinels take over. */
const INITIAL_RADIUS = 8;
/** Entries added per sentinel crossing. */
const PAGE = 10;

/** Compact journal label (YYYYMMDD) from the content-addressed date id. */
const sortKey = (page: { id: string }): string => rawDateKeywordOf(page) || page.id;

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
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  /** scrollHeight − scrollTop captured before a prepend, restored after. */
  const keepVisualRef = useRef<number | null>(null);
  const centeredRef = useRef(false);

  /** All day pages, newest first. */
  const pages = useMemo(() => {
    const day = SYSTEM_CLASS_UUIDS.day;
    return client
      .listPages()
      .filter((page) => page.classIds.includes(day))
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  }, [client, version]);

  const todayKey = todayIsoLocal().replace(/-/g, "");
  /**
   * Today's entry; else the newest entry at or before today; else the
   * oldest future entry (the closest one above today — scrolling up from
   * there reveals the rest of the future); else the top.
   */

  /** The side panel's selected day (local ISO) — the events scope anchor. */
  const [panelIso, setPanelIso] = useState(todayIsoLocal());
  /** The feed's focus day while set: overrides the today anchor. */
  const [focusIso, setFocusIso] = useState<string | null>(null);
  /** First-day-of-week device setting for the mini-month. */
  const [firstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);
  /** Pending scroll-navigate while the day page is being materialized. */
  const pendingJumpRef = useRef<string | null>(null);

  const anchorIndex = useMemo(() => {
    // A side-panel jump owns the anchor while its day page exists (owner
    // 2026-10-24); Today clears it (scrollToToday below).
    if (focusIso !== null) {
      const focusKey = focusIso.replace(/-/g, "");
      const exact = pages.findIndex((page) => sortKey(page) === focusKey);
      if (exact >= 0) return exact;
    }
    const exact = pages.findIndex((page) => sortKey(page) === todayKey);
    if (exact >= 0) return exact;
    const atOrBefore = pages.findIndex((page) => sortKey(page) <= todayKey);
    if (atOrBefore >= 0) return atOrBefore;
    return pages.length > 0 ? pages.length - 1 : 0;
  }, [pages, todayKey, focusIso]);

  const [extraBefore, setExtraBefore] = useState(0);
  const [extraAfter, setExtraAfter] = useState(0);


  const rangeStart = Math.max(0, anchorIndex - INITIAL_RADIUS - extraBefore);
  const rangeEnd = Math.min(
    pages.length,
    anchorIndex + INITIAL_RADIUS + 1 + extraAfter,
  );
  const visible = pages.slice(rangeStart, rangeEnd);
  const anchorOffset = anchorIndex - rangeStart;

  // --- windowing ------------------------------------------------------------

  const extendBefore = () => {
    if (rangeStart === 0) return;
    const el = listRef.current;
    keepVisualRef.current = el !== null ? el.scrollHeight - el.scrollTop : null;
    setExtraBefore((n) => n + PAGE);
  };
  const extendAfter = () => {
    if (rangeEnd >= pages.length) return;
    setExtraAfter((n) => n + PAGE);
  };

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === top) extendBefore();
          else extendAfter();
        }
      },
      { root: listRef.current, rootMargin: "600px" },
    );
    if (top) observer.observe(top);
    if (bottom) observer.observe(bottom);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sentinel wiring follows the visible window
  }, [rangeStart, rangeEnd, pages.length]);

  /** After a prepend, hold the viewport at the same content. */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null || keepVisualRef.current === null) return;
    el.scrollTop = el.scrollHeight - keepVisualRef.current;
    keepVisualRef.current = null;
  }, [extraBefore]);

  /**
   * The anchor's offset within the list's CONTENT. Rect-based, not
   * offsetTop: the list is not a positioned ancestor, so offsetTop would
   * measure from some higher offsetParent and overshoot — scrolling PAST
   * the entry and hiding the day page's header (owner bug 2026-10-04).
   */
  const anchorContentTop = (): number | null => {
    const el = listRef.current;
    const anchor = el?.querySelector(".journal-entry[data-anchor='true']");
    if (el === null || el === undefined || !(anchor instanceof HTMLElement)) return null;
    return anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  };

  /** First mount: center today (or the anchor) at the top of the feed. */
  useLayoutEffect(() => {
    if (centeredRef.current || visible.length === 0) return;
    centeredRef.current = true;
    const el = listRef.current;
    const top = anchorContentTop();
    if (el !== null && el !== undefined && top !== null) {
      el.scrollTop = top;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- centers once on mount
  }, [visible.length]);

  /**
   * A pending jump (owner 2026-10-22, generalized 2026-10-24): set when a
   * jump materializes a missing day page — the anchor only becomes the
   * target after the ensure's subscription re-render, so the scroll rides
   * this effect, re-measuring each render until the anchor row IS the
   * target day.
   */
  const jumpToTodayRef = useRef(false);

  useLayoutEffect(() => {
    if (!jumpToTodayRef.current && pendingJumpRef.current === null) return;
    const el = listRef.current;
    if (el === null) return;
    const top = anchorContentTop();
    if (top === null) return;
    el.scrollTop = top;
    const anchor = el.querySelector(".journal-entry[data-anchor='true']");
    const target = pendingJumpRef.current ?? todayIsoLocal();
    if (anchor?.getAttribute("data-journal-id") === dayNodeId(target)) {
      jumpToTodayRef.current = false;
      pendingJumpRef.current = null;
    }
  });

  /**
   * Jump to today: materialize today's page when it doesn't exist yet —
   * the anchor is "today or the nearest day at or before", so with a
   * missing page the jump landed on a past day (owner bug 2026-10-22:
   * clicked Today, saw the 18th). The ensure mirrors the sidebar Today
   * row and the empty-state CTA, behind the same journal-toggle gate;
   * when today's page already exists the scroll is synchronous.
   */
  const scrollToToday = () => {
    const el = listRef.current;
    if (el === null) return;
    setFocusIso(null); // Today re-owns the anchor.
    setPanelIso(todayIsoLocal());
    const todayId = dayNodeId(todayIsoLocal());
    if (pages.some((page) => page.id === todayId)) {
      const top = anchorContentTop();
      if (top !== null) el.scrollTop = top;
      return;
    }
    if (!client.isFeatureEnabled("journal")) return;
    jumpToTodayRef.current = true;
    void client.ensureDateChain(todayIsoLocal()).catch(() => {
      jumpToTodayRef.current = false;
    });
  };

  /**
   * The side panel's day pick (owner 2026-10-24): scroll-navigate the feed
   * to the day page, materializing it through the same journal-gated
   * ensure as the Today jump when it doesn't exist yet. The picked day
   * also becomes the panel's events scope anchor.
   */
  const navigateToDay = (iso: string): void => {
    setPanelIso(iso);
    const id = dayNodeId(iso);
    if (pages.some((page) => page.id === id)) {
      setFocusIso(iso);
      return;
    }
    if (!client.isFeatureEnabled("journal")) return;
    pendingJumpRef.current = iso;
    setFocusIso(iso); // anchors the window once the page lands
    void client.ensureDateChain(iso).catch(() => {
      pendingJumpRef.current = null;
    });
  };

  const openToday = async () => {
    const { day } = await client.ensureDateChain(todayIsoLocal());
    onOpenPage(day);
  };

  return (
    <div className="journals-view">
      {/* The hub chrome rides the shared SurfaceTopBar (owner 2026-10-22):
          pinned above the feed, full card width, so the feed's scrollbar
          stays at the card border. The lone action is Today — a jump that
          materializes today's page when missing (owner bug same day: a
          pure scroll-to landed on the nearest past day). Discrete
          day-steppers stay retired: day-jumping rides the calendar popup,
          the sidebar Today row, and each entry's Open-page button. */}
      <SurfaceTopBar
        icon="mdi-notebook-outline"
        title="Journal"
        actions={
          pages.length > 0 ? (
            /* The outline variant + "Jump to today" title/aria (owner
               2026-10-22, second pass): the bordered button reads
               clickable where the ghost idiom doesn't, and the short
               "Today" label names the destination, not the jump. */
            <Button
              variant="outline"
              size="sm"
              title="Jump to today"
              aria-label="Jump to today"
              onClick={scrollToToday}
            >
              Today
            </Button>
          ) : undefined
        }
      />
      {pages.length === 0 ? (
        /* The sentence-as-title follows the CalendarView EmptyState
           precedent; the CTA is the kit Button (the primary register). */
        <EmptyState
          className="journals-empty"
          title="Daily journal pages are created when you open today's note."
          actionLabel="Open today’s note"
          onAction={() => void openToday()}
        />
      ) : (
        <div className="journals-body">
        <div className="journals-list" ref={listRef}>
          {rangeStart > 0 && <div ref={topSentinelRef} className="journals-sentinel" aria-hidden="true" />}
          {visible.map((page, i) => (
            <article
              key={page.id}
              className="journal-entry"
              data-journal-id={page.id}
              data-anchor={i === anchorOffset ? "true" : undefined}
            >
              <PageView client={client} pageId={page.id} onOpenPage={onOpenPage} embedded />
            </article>
          ))}
          {rangeEnd < pages.length && (
            <div ref={bottomSentinelRef} className="journals-sentinel" aria-hidden="true" />
          )}
        </div>
        <aside className="journals-panel" aria-label="Journal navigator">
          <MonthCalendar
            selectedDate={panelIso}
            onSelectDate={navigateToDay}
            firstDayOfWeek={firstDayOfWeek}
            hasNote={(iso) => client.getNodeRaw(dayNodeId(iso)) !== undefined}
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
        </aside>
        </div>
      )}
    </div>
  );
}
