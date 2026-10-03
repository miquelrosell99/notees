/**
 * JournalsView — the journal feed: a continuous, today-centered scroll of
 * page views, one per existing day-classed page, newest first. Scrolling up
 * reveals future existing day pages, scrolling down older ones; reloading
 * re-centers on today. Clicking an entry's date header opens that page in
 * the full page view.
 *
 * Every day page exists in the local store, so "loading" is purely a
 * rendering window: a small slice around today mounts first and
 * IntersectionObserver sentinels grow it in both directions. Prepends
 * compensate scrollTop so the viewport stays put.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, parseDateNodeId } from "@notees/domain";

import { PageView } from "../PageView.js";
import { Icon } from "../Icon.js";
import { rawDateKeywordOf } from "../dateDisplay.js";
import type { AnyClient } from "./Sidebar.js";
import { addDaysIso, isoOfDateParts, todayIsoLocal } from "./calendarViewUtils.js";
import { Button } from "./ui/Button.js";
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
  const anchorIndex = useMemo(() => {
    const exact = pages.findIndex((page) => sortKey(page) === todayKey);
    if (exact >= 0) return exact;
    const atOrBefore = pages.findIndex((page) => sortKey(page) <= todayKey);
    if (atOrBefore >= 0) return atOrBefore;
    return pages.length > 0 ? pages.length - 1 : 0;
  }, [pages, todayKey]);

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

  /** First mount: center today (or the anchor) at the top of the feed. */
  useLayoutEffect(() => {
    if (centeredRef.current || visible.length === 0) return;
    centeredRef.current = true;
    const el = listRef.current;
    const anchor = el?.querySelector(".journal-entry[data-anchor='true']");
    if (el !== null && el !== undefined && anchor instanceof HTMLElement) {
      el.scrollTop = anchor.offsetTop;
    }
  }, [visible.length]);

  const scrollToToday = () => {
    const el = listRef.current;
    const anchor = el?.querySelector(".journal-entry[data-anchor='true']");
    if (el !== undefined && el !== null && anchor instanceof HTMLElement) {
      el.scrollTop = anchor.offsetTop;
    }
  };

  const openToday = async () => {
    const { day } = await client.ensureDateChain(todayIsoLocal());
    onOpenPage(day);
  };

  /**
   * §34.28 #7 — the journal header date bar: ±1 day over the deterministic
   * date-node ids (ensure-chain is idempotent, so stepping into a day with
   * no page materializes it and opens it), anchored on the feed's anchor
   * entry; no pages at all falls back to today.
   */
  const anchorIso = (() => {
    const anchor = pages[anchorIndex];
    if (anchor === undefined) return todayIsoLocal();
    const parsed = parseDateNodeId(anchor.id);
    return parsed !== null ? isoOfDateParts(parsed) : todayIsoLocal();
  })();

  const openDay = (iso: string) => {
    void client.ensureDateChain(iso).then(({ day }) => onOpenPage(day));
  };

  return (
    <div className="journals-view">
      <header className="journals-view__header">
        <h1 className="journals-view__title">
          <Icon path="mdi-notebook-outline" size={1.1} />
          Journal
        </h1>
        <span className="journals-view__nav">
          <Button
            variant="ghost"
            size="sm"
            icon="mdi-chevron-left"
            aria-label="Previous day"
            onClick={() => openDay(addDaysIso(anchorIso, -1))}
          />
          {pages.length > 0 && (
            <button type="button" className="journals-view__today-btn" onClick={scrollToToday}>
              Today
            </button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon="mdi-chevron-right"
            aria-label="Next day"
            onClick={() => openDay(addDaysIso(anchorIso, 1))}
          />
        </span>
      </header>
      {pages.length === 0 ? (
        <div className="journals-empty">
          <p>Daily journal pages are created when you open today's note.</p>
          <button type="button" className="journals-empty__action" onClick={() => void openToday()}>
            Open today&rsquo;s note
          </button>
        </div>
      ) : (
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
      )}
    </div>
  );
}
