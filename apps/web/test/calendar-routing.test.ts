/**
 * Calendar routing tests (owner 2026-10-24 — the calendar is URL-addressable):
 * the `/calendar/<zoom>/<iso>` parse/build round-trips, the bare-path and
 * invalid-segment fallbacks, the nav-parse branch that keeps every
 * /calendar/* path on the calendar hub, the popstate handler's
 * setCalendarRoute seam, the period-title register behind the tab title,
 * and tabTitle's calendar branch (law 9 — the surface owns its title).
 */

import { describe, expect, it, vi } from "vitest";

import {
  calendarPeriodTitle,
  calendarRouteFromPath,
  isCalendarZoom,
  isIsoDay,
  navFromPath,
  pathForCalendar,
  popStateNavHandler,
  tabTitle,
  type CalendarZoom,
} from "../src/ui/app/routing.js";

describe("calendarRouteFromPath / pathForCalendar", () => {
  it("round-trips every zoom with a day", () => {
    const zooms: CalendarZoom[] = ["day", "week", "month", "year", "agenda"];
    for (const zoom of zooms) {
      const path = pathForCalendar(zoom, "2026-10-20");
      expect(path, zoom).toBe(`/calendar/${zoom}/2026-10-20`);
      expect(calendarRouteFromPath(path), zoom).toEqual({ zoom, iso: "2026-10-20" });
    }
  });

  it("round-trips a zoom without a day", () => {
    expect(calendarRouteFromPath(pathForCalendar("week"))).toEqual({ zoom: "week", iso: null });
  });

  it("the bare /calendar path parses as the bare default (still a calendar route)", () => {
    expect(calendarRouteFromPath("/calendar")).toEqual({ zoom: null, iso: null });
  });

  it("an invalid zoom segment falls back to the bare default", () => {
    expect(calendarRouteFromPath("/calendar/fortnight/2026-10-20")).toEqual({
      zoom: null,
      iso: null,
    });
  });

  it("a malformed or impossible iso is ignored (today default), the zoom survives", () => {
    expect(calendarRouteFromPath("/calendar/week/not-a-date")).toEqual({ zoom: "week", iso: null });
    expect(calendarRouteFromPath("/calendar/week/20-10-2026")).toEqual({ zoom: "week", iso: null });
    expect(calendarRouteFromPath("/calendar/week/2026-13-40")).toEqual({ zoom: "week", iso: null });
    expect(calendarRouteFromPath("/calendar/week/20260230")).toEqual({ zoom: "week", iso: null });
  });

  it("non-calendar paths are not calendar routes", () => {
    expect(calendarRouteFromPath("/pages")).toBeNull();
    expect(calendarRouteFromPath("/journal")).toBeNull();
    expect(calendarRouteFromPath("/")).toBeNull();
    expect(calendarRouteFromPath("/calendarium/week/2026-10-20")).toBeNull();
  });

  it("isCalendarZoom / isIsoDay gate the segments", () => {
    expect(isCalendarZoom("month")).toBe(true);
    expect(isCalendarZoom("fortnight")).toBe(false);
    expect(isIsoDay("2026-10-20")).toBe(true);
    expect(isIsoDay("2026-10-32")).toBe(false);
    expect(isIsoDay("2026-1-1")).toBe(false);
    expect(isIsoDay("20-10-2026")).toBe(false);
  });
});

describe("navFromPath with the calendar subroutes", () => {
  it("every /calendar/* path lands on the calendar hub", () => {
    expect(navFromPath("/calendar")).toBe("calendar");
    expect(navFromPath("/calendar/week")).toBe("calendar");
    expect(navFromPath("/calendar/week/2026-10-20")).toBe("calendar");
    expect(navFromPath("/calendar/bogus")).toBe("calendar");
  });

  it("the other hubs are untouched", () => {
    expect(navFromPath("/pages")).toBe("pages");
    expect(navFromPath("/journals")).toBe("journal");
    expect(navFromPath("/graph")).toBe("graph");
    expect(navFromPath("/unknown")).toBeNull();
  });
});

describe("popStateNavHandler's setCalendarRoute seam", () => {
  it("reports the parsed calendar route on a calendar landing, null elsewhere", () => {
    const setCalendarRoute = vi.fn();
    const handler = popStateNavHandler({
      openManager: () => {},
      closeManager: () => {},
      setNav: () => {},
      setNode: () => {},
      setSettingsSection: () => {},
      setCalendarRoute,
    });

    window.history.replaceState({}, "", "/calendar/week/2026-10-20");
    handler();
    expect(setCalendarRoute).toHaveBeenLastCalledWith({ zoom: "week", iso: "2026-10-20" });

    window.history.replaceState({}, "", "/calendar");
    handler();
    expect(setCalendarRoute).toHaveBeenLastCalledWith({ zoom: null, iso: null });

    window.history.replaceState({}, "", "/pages");
    handler();
    expect(setCalendarRoute).toHaveBeenLastCalledWith(null);
  });
});

describe("calendarPeriodTitle (the tab title's period register)", () => {
  const period = { iso: "2026-10-20", year: 2026, month0: 9, firstDayOfWeek: 1 };

  it("day names the formatted day (the default date format)", () => {
    expect(calendarPeriodTitle("day", period)).toBe("2026-10-20");
  });

  it("week names the week's date range", () => {
    const title = calendarPeriodTitle("week", period);
    expect(title.startsWith("Week of ")).toBe(true);
    // 2026-10-20 is a Tuesday; a Monday-first week runs 19 – 25 Oct.
    const fmt = (iso: string): string => {
      const [y, m, d] = iso.split("-").map(Number);
      return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
      });
    };
    expect(title).toBe(`Week of ${fmt("2026-10-19")} – ${fmt("2026-10-25")}`);
  });

  it("month and agenda name the long month + year of the visible period", () => {
    const expected = new Date(2026, 9, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
    expect(calendarPeriodTitle("month", period)).toBe(expected);
    expect(calendarPeriodTitle("agenda", period)).toBe(expected);
  });

  it("year names the year", () => {
    expect(calendarPeriodTitle("year", period)).toBe("2026");
  });
});

describe("tabTitle's calendar branch (law 9)", () => {
  const base = {
    clientPresent: true,
    selectedPageId: null,
    settingsSection: null,
    searchOpen: false,
    activeNav: "calendar" as const,
    nodeName: "",
  };

  it("the calendar's own title names the surface + period over the hub register", () => {
    expect(tabTitle({ ...base, calendarTitle: "October 2026 — Calendar" })).toBe(
      "October 2026 — Calendar",
    );
  });

  it("a null calendarTitle cedes to the hub register", () => {
    expect(tabTitle({ ...base, calendarTitle: null })).toBe("Calendar - Notees");
    expect(tabTitle(base)).toBe("Calendar - Notees");
  });

  it("an open node, the search, and the settings section still win over the calendar title", () => {
    expect(
      tabTitle({ ...base, calendarTitle: "October 2026 — Calendar", selectedPageId: "x", nodeName: "My page" }),
    ).toBe("My page - Notees");
    expect(
      tabTitle({ ...base, calendarTitle: "October 2026 — Calendar", searchOpen: true }),
    ).toBe("Search - Notees");
    expect(
      tabTitle({ ...base, calendarTitle: "October 2026 — Calendar", settingsSection: "appearance" }),
    ).toBe("Appearance - Notees");
  });
});
