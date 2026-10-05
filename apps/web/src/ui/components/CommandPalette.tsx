/**
 * CommandPalette — Ctrl/Cmd+K command surface (plus the topbar search
 * trigger, via the `open` prop). A fixed-position modal (~top 18vh, 560px)
 * with an autofocused SearchField and a fuzzy subsequence filter over the
 * section registry (§34.30 M6):
 *
 *  - Recent     device-local recents (empty query only — the Sidebar's
 *               `notees.recents` contract; no sync per the §34.29 #8 ruling)
 *  - Random     five pages picked on open via Fisher–Yates over the
 *               already-loaded page list (asset-classed pages excluded); the
 *               group label carries a ghost refresh button that re-shuffles
 *               the SAME cached pool — deliberately no new worker query
 *               (the v1 ruling: extra projections starve the palette on
 *               large workspaces). Empty query only; exempt from the
 *               seen-ids dedupe like Commands (#8)
 *  - Date Pages date pages matching the query: formatted/raw keywords plus a
 *               parsed-date suggestion ("feb 14" → the deterministic date
 *               chain; §34.28 #12). The `is_daily:` prefix scopes the whole
 *               palette to this section.
 *  - Pages      (client.listPages, asset-classed pages excluded)
 *  - Classes    (client.listClasses)
 *  - Content    debounced ranked FTS (client.searchPage) with M3 match
 *               snippets; block hits carry their containing-page label
 *               (M4, label helper shared with M8's picker work)
 *  - Commands   the action registry: New page, a typed "Create page …" row,
 *               Toggle theme, Sign out (M6's contribution point)
 *
 * Full keyboard navigation: ArrowUp/Down cycles, Enter selects, Esc closes;
 * the mouse hovers and clicks. Theme toggling dispatches the same
 * data-theme/localStorage flip as ThemeToggle. Rendered through the shared
 * modal chrome (Modal.css) with a palette skin on top.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, chainNodeIds, rendersAsInlineBlock, rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, SearchSnippetData, WorkspaceClient } from "@/core/workspace-client.js";
import type { UndoUiState } from "@/core/undo-journal.js";

import { displayNameForSettings, isDatePageNode, rawDateKeywordOf } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { toggleFocusMode } from "./modals/deviceSettings.js";
import { parseDate } from "./pickers/dateParser.js";
import { Button } from "./ui/Button.js";
import { SearchField } from "./ui/SearchField.js";
import "./Modal.css";
import "./CommandPalette.css";

type AnyClient = WorkspaceClient | WorkerClient;

const THEME_KEY = "notees.theme";
/** The Sidebar's device-local recents key — same contract, read-only here. */
const RECENTS_KEY = "notees.recents";
/** The Random section's row count (the v1 section's slice size). */
const RANDOM_PAGE_COUNT = 5;

type Group = "Recent" | "Random" | "Date Pages" | "Pages" | "Classes" | "Content" | "Commands";

interface PaletteItem {
  key: string;
  group: Group;
  label: string;
  icon: string;
  keywords: string;
  /** Right-side hint — the containing page for block content hits (M4/M8). */
  meta?: string | undefined;
  /** Match-context excerpt under the label (the Content group). */
  snippet?: SearchSnippetData | null;
  run: () => void;
}

/** One action registry entry (M6's contribution point shape). */
interface PaletteAction {
  key: string;
  label: string;
  icon: string;
  keywords: string;
  run: () => void;
}

/**
 * Ordered-subsequence fuzzy score, or null when the query does not match.
 * Word-start and consecutive matches score higher; shorter targets win ties.
 */
function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (q === "") return 0;
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]!;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found === -1) return null;
    score += 1;
    if (found === 0 || /[\s\-_/.@·]/.test(t[found - 1]!)) score += 3;
    if (found === lastMatch + 1) score += 2;
    lastMatch = found;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

function bestScore(query: string, label: string, keywords: string): number | null {
  const labelScore = fuzzyScore(query, label);
  const keywordScore = fuzzyScore(query, keywords);
  return labelScore !== null && keywordScore !== null
    ? Math.max(labelScore, keywordScore)
    : (labelScore ?? keywordScore);
}

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage unavailable (private mode); the flip just won't persist.
  }
}

/** Snippet excerpt with the match spans highlighted (the shared nt-search-* styles). */
function SnippetLine({ snippet }: { snippet: SearchSnippetData }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  snippet.matches.forEach((match, index) => {
    if (match.start > cursor) parts.push(snippet.text.slice(cursor, match.start));
    parts.push(
      <mark key={index} className="nt-search-mark">
        {snippet.text.slice(match.start, match.start + match.length)}
      </mark>,
    );
    cursor = match.start + match.length;
  });
  if (cursor < snippet.text.length) parts.push(snippet.text.slice(cursor));
  return <span className="nt-search-snippet nt-palette-snippet">{parts}</span>;
}

/** Containing-page breadcrumb for a block hit (M8's label semantics). */
function containingPageLabel(client: AnyClient, node: ClientNode): string | null {
  let currentId = node.parentId;
  let guard = 0;
  while (currentId !== null && guard < 64) {
    const parent = client.getNode(currentId);
    if (parent === undefined) return null;
    if (rendersWithDocumentChrome(parent)) return displayNameForSettings(parent) || "Untitled";
    currentId = parent.parentId;
    guard += 1;
  }
  return null;
}

function readRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Fisher–Yates over a copy (the v1 shufflePages precedent, #8) — pure with
 * respect to the input so a refresh can re-shuffle the same cached pool.
 */
function shuffledIds(ids: readonly string[]): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The Random section's five rows (#8): a fresh Fisher–Yates pick over the
 * open-time pool, display data captured per pick (the handler closes over
 * the pick-time `onOpenNode`, exactly like the memo-built rows). Rows
 * resolve through `client.getNode` so a node deleted since the pick drops
 * out quietly.
 */
function pickRandomRows(
  client: AnyClient,
  pool: readonly string[],
  onOpenNode: (nodeId: string) => void,
): PaletteItem[] {
  const rows: PaletteItem[] = [];
  for (const id of shuffledIds(pool).slice(0, RANDOM_PAGE_COUNT)) {
    const page = client.getNode(id);
    if (page === undefined) continue;
    rows.push({
      key: `random:${page.id}`,
      group: "Random",
      label: displayNameForSettings(page) || "Untitled",
      icon: page.icon ?? "mdi-file-document-outline",
      keywords: rawDateKeywordOf(page),
      run: () => onOpenNode(page.id),
    });
  }
  return rows;
}

function toIsoDate(parsed: { type: "day" | "month" | "year"; year: number; month?: number; day?: number }): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const month = parsed.month ?? 1;
  const day = parsed.day ?? 1;
  return `${parsed.year}-${pad(month)}-${pad(day)}`;
}

export function CommandPalette({
  client,
  open,
  onRequestOpen,
  onClose,
  onOpenNode,
  onNewPage,
  onSignOut,
  undoState,
  onUndo,
  onRedo,
  cacheVersion,
}: {
  client: AnyClient;
  open: boolean;
  /** Ctrl/Cmd+K when closed: the App lifts `open`, so ask it to open. */
  onRequestOpen: () => void;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  /** Create (and open) a new page; a title carries the palette query. */
  onNewPage: (title?: string) => void;
  onSignOut: () => void;
  /** §34.64 — the session undo journal state; rows appear only when available. */
  undoState: UndoUiState;
  onUndo: () => void;
  onRedo: () => void;
  /**
   * Bumped by the App on every client notification: the sync sections re-read
   * the client caches, and the debounced Content fetch re-runs so results
   * never freeze at a stale page.
   */
  cacheVersion: number;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(readRecents);
  /**
   * Random section (#8): the five rows picked on open, plus the id pool they
   * came from. The pool is captured once per open (the cached `listPages`
   * read); refresh re-shuffles THAT list — deliberately no new worker query
   * (the v1 ruling: extra projections starve the palette on large
   * workspaces). The rows are display data captured at pick time, so a
   * refresh never re-runs the sync-sections memo.
   */
  const [randomRows, setRandomRows] = useState<PaletteItem[]>([]);
  const randomPoolRef = useRef<readonly string[]>([]);
  /** Debounced FTS content group (M4): tagged with the query they answer. */
  const [contentItems, setContentItems] = useState<Array<PaletteItem & { queryTag: string }>>([]);
  const [contentLoading, setContentLoading] = useState(false);
  const contentGeneration = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Global Ctrl/Cmd+K toggle (capture so browser-default find-in-page loses).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) onClose();
        else onRequestOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onRequestOpen, onClose]);

  // Device-local recents: refresh whenever any surface writes the list
  // (same `notees:recents` broadcast contract as the Sidebar).
  useEffect(() => {
    const refresh = () => setRecentIds(readRecents());
    window.addEventListener("notees:recents", refresh);
    return () => window.removeEventListener("notees:recents", refresh);
  }, []);

  // Query parsing: the `is_daily:` prefix scopes the palette to date pages
  // (§34.28 #12); the rest is the fuzzy/FTS text.
  const dailyOnly = /^is_daily:\s*/i.test(query);
  const text = query.replace(/^is_daily:\s*/i, "").trim();

  // --- synchronous sections -------------------------------------------------

  const syncItems = useMemo<PaletteItem[]>(() => {
    const classes = client.listClasses();
    const assetClassId =
      classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
    const pages = client
      .listPages()
      .filter((page) => !page.classIds.includes(assetClassId));
    const themeIsDark = document.documentElement.dataset.theme !== "light";
    const focusIsOn = document.documentElement.dataset.focus === "true";
    const items: PaletteItem[] = [];
    /** Fuzzy-pass one candidate pool into a group; `always` keeps rows on an empty query. */
    const addFuzzy = (
      group: Group,
      pool: Array<{ id: string; label: string; keywords: string; icon: string; run: () => void; meta?: string }>,
    ) => {
      const matched = pool
        .map((entry) => ({ entry, score: bestScore(text, entry.label, entry.keywords) }))
        .filter((m): m is { entry: (typeof pool)[number]; score: number } => m.score !== null)
        .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
      // Same node may enter one pool twice (a parsed-date suggestion AND the
      // fuzzy pass both reach the chain's day page) — the higher score wins.
      const seenInPool = new Set<string>();
      for (const { entry } of matched) {
        if (seenInPool.has(entry.id)) continue;
        seenInPool.add(entry.id);
        items.push({
          key: `${group}:${entry.id}`,
          group,
          label: entry.label,
          icon: entry.icon,
          keywords: entry.keywords,
          meta: entry.meta,
          run: entry.run,
        });
      }
    };

    if (!dailyOnly && text === "") {
      const recentPool: Array<{ id: string; label: string; keywords: string; icon: string; run: () => void }> = [];
      const seenRecent = new Set<string>();
      for (const id of recentIds.slice(0, 8)) {
        if (seenRecent.has(id)) continue;
        seenRecent.add(id);
        const node = client.getNode(id);
        if (node === undefined || node.classIds.includes(assetClassId)) continue;
        recentPool.push({
          id: node.id,
          label: displayNameForSettings(node) || "Untitled",
          icon: node.icon ?? "mdi-file-document-outline",
          keywords: rawDateKeywordOf(node),
          run: () => onOpenNode(node.id),
        });
      }
      addFuzzy("Recent", recentPool);
    }

    if (dailyOnly || text !== "") {
      // Parsed-date suggestion: formatted keywords ("feb 14", "2026-02-09",
      // "yesterday") map onto the deterministic date chain — offered even
      // when the chain nodes do not exist yet (ensureDateChain creates them).
      const parsed = text === "" ? null : parseDate(text);
      const datePool: Array<{ id: string; label: string; keywords: string; icon: string; run: () => void }> = [];
      if (parsed !== null) {
        const iso = toIsoDate(parsed);
        const ids = chainNodeIds(iso);
        const refId = parsed.type === "year" ? ids.year : parsed.type === "month" ? ids.month : ids.day;
        datePool.push({
          id: refId,
          label: `${client.getNode(refId) !== undefined ? "Open" : "Create"} date page: ${parsed.label}`,
          keywords: text,
          icon: "mdi-calendar",
          run: () => {
            onClose();
            void client.ensureDateChain(iso).then((chain) => {
              onOpenNode(parsed.type === "year" ? chain.year : parsed.type === "month" ? chain.month : chain.day);
            });
          },
        });
      }
      for (const page of pages) {
        if (!isDatePageNode(page)) continue;
        datePool.push({
          id: page.id,
          label: displayNameForSettings(page) || "Untitled",
          icon: page.icon ?? "mdi-calendar",
          // The raw compact label stays a keyword: display is formatted, but
          // users still type YYYYMMDD to find a date page.
          keywords: rawDateKeywordOf(page),
          run: () => onOpenNode(page.id),
        });
      }
      addFuzzy("Date Pages", datePool);
    }

    if (!dailyOnly && text !== "") {
      addFuzzy(
        "Pages",
        pages.map((page) => ({
          id: page.id,
          label: displayNameForSettings(page) || "Untitled page",
          icon: page.icon ?? "mdi-file-document-outline",
          keywords: rawDateKeywordOf(page),
          run: () => onOpenNode(page.id),
        })),
      );
      addFuzzy(
        "Classes",
        classes.map((cls) => ({
          id: cls.id,
          label: displayNameForSettings(cls) || "Untitled class",
          icon: cls.icon ?? "mdi-shape-outline",
          keywords: `${displayNameForSettings(cls)}`,
          run: () => onOpenNode(cls.id),
        })),
      );
    }

    // Action registry (M6): static rows + a query-scoped typed creation +
    // the session journal's Undo/Redo rows (§34.64 — present only when the
    // journal has something to (re)apply; the row IS the label).
    const actions: PaletteAction[] = [
      {
        key: "new-page",
        label: "New page",
        icon: "mdi-file-plus-outline",
        keywords: "new create page add",
        run: () => onNewPage(),
      },
      ...(text !== ""
        ? [
            {
              key: "create-titled",
              label: `Create page "${text}"`,
              icon: "mdi-file-plus",
              keywords: `new create page add ${text}`,
              run: () => onNewPage(text),
            },
          ]
        : []),
      ...(undoState.undoLabel !== null
        ? [
            {
              key: "undo",
              label: undoState.undoLabel,
              icon: "mdi-undo-variant",
              keywords: "undo revert journal",
              run: onUndo,
            },
          ]
        : []),
      ...(undoState.redoLabel !== null
        ? [
            {
              key: "redo",
              label: undoState.redoLabel,
              icon: "mdi-redo-variant",
              keywords: "redo repeat journal",
              run: onRedo,
            },
          ]
        : []),
      {
        key: "toggle-focus",
        label: focusIsOn ? "Focus mode: exit" : "Focus mode: enter",
        icon: focusIsOn ? "mdiFullscreenExit" : "mdiEyeOutline",
        keywords: "focus mode distraction minimal writing dim",
        run: () => {
          toggleFocusMode();
        },
      },
      {
        key: "toggle-theme",
        label: themeIsDark ? "Toggle theme: switch to light" : "Toggle theme: switch to dark",
        icon: themeIsDark ? "mdi-white-balance-sunny" : "mdi-weather-night",
        keywords: "theme dark light appearance",
        run: () => toggleTheme(),
      },
      {
        key: "sign-out",
        label: "Sign out",
        icon: "mdi-logout-variant",
        keywords: "sign out logout exit account",
        run: () => onSignOut(),
      },
    ];
    const matchedActions = actions
      .map((action) => ({ action, score: bestScore(text, action.label, action.keywords) }))
      .filter((m): m is { action: PaletteAction; score: number } => m.score !== null)
      .sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label));
    for (const { action } of matchedActions) {
      items.push({
        key: `action:${action.key}`,
        group: "Commands",
        label: action.label,
        icon: action.icon,
        keywords: action.keywords,
        run: action.run,
      });
    }

    return items;
    // cacheVersion: the cached reads resolve asynchronously after their seed;
    // re-derive the sections when the worker cache refreshes.
  }, [client, dailyOnly, text, onOpenNode, onNewPage, onSignOut, onClose, recentIds, cacheVersion, undoState, onUndo, onRedo]);

  // --- Content section (M4): debounced ranked FTS with snippets -------------

  useEffect(() => {
    if (!open) return;
    const mine = ++contentGeneration.current;
    if (dailyOnly || text === "") {
      setContentItems([]);
      setContentLoading(false);
      return;
    }
    setContentLoading(true);
    const timer = setTimeout(() => {
      Promise.resolve(client.searchPage(text, { limit: 8 }))
        .then((page) => {
          if (contentGeneration.current !== mine) return;
          const classes = client.listClasses();
          const assetClassId =
            classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
          setContentItems(
            page.nodes
              .filter((node) => !node.classIds.includes(assetClassId))
              .map((node) => ({
                queryTag: text,
                key: `content:${node.id}`,
                group: "Content" as const,
                label: displayNameForSettings(node) || "Untitled",
                icon: rendersWithDocumentChrome(node)
                  ? (node.icon ?? "mdi-file-document-outline")
                  : "mdi-format-text",
                keywords: "",
                meta: rendersAsInlineBlock(node) ? (containingPageLabel(client, node) ?? undefined) : undefined,
                snippet: client.getSearchSnippet(node.id, text),
                run: () => onOpenNode(node.id),
              })),
          );
        })
        .catch(() => {
          if (contentGeneration.current === mine) setContentItems([]);
        })
        .finally(() => {
          if (contentGeneration.current === mine) setContentLoading(false);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [open, dailyOnly, text, client, onOpenNode, cacheVersion]);

  // Dedupe + flatten: sync sections first (group order), stale content pages
  // (answered query ≠ current) dropped, content ids already surfaced as
  // title/date matches skipped.
  const filtered = useMemo(() => {
    const seenIds = new Set<string>();
    let randomInserted = false;
    const out: PaletteItem[] = [];
    const push = (item: PaletteItem) => {
      // Commands carry no node id; Random re-picks per open and always shows
      // its five — neither participates in the cross-group dedupe.
      if (item.group !== "Commands" && item.group !== "Random") {
        const id = item.key.slice(item.key.indexOf(":") + 1);
        if (seenIds.has(id)) return;
        seenIds.add(id);
      }
      out.push(item);
    };
    for (const item of syncItems) {
      // Section registry order: the Random group sits after the node
      // sections (Recent) and before Commands (#8). Commands is always
      // present, so the post-loop fallback is defensive only.
      if (!randomInserted && item.group === "Commands" && text === "" && !dailyOnly) {
        out.push(...randomRows);
        randomInserted = true;
      }
      push(item);
    }
    if (!randomInserted && text === "" && !dailyOnly) out.push(...randomRows);
    for (const item of contentItems) {
      if (item.queryTag !== text) continue;
      push(item);
    }
    return out;
  }, [syncItems, contentItems, text, randomRows, dailyOnly]);

  const clampedActive = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  /**
   * Random refresh (#8): re-shuffle the open-time pool — the same cached id
   * list, never a fresh worker query.
   */
  const refreshRandomPages = () => {
    setRandomRows(pickRandomRows(client, randomPoolRef.current, onOpenNode));
  };

  // Reset on open; keep the active row visible while arrowing. The Random
  // pool is captured here too — the cached page list, asset-classed pages
  // excluded (the same read the Pages section uses) — and the section's
  // display rows are picked from it.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setContentItems([]);
    const classes = client.listClasses();
    const assetClassId =
      classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
    const pool = client.listPages().filter((page) => !page.classIds.includes(assetClassId));
    randomPoolRef.current = pool.map((page) => page.id);
    setRandomRows(pickRandomRows(client, randomPoolRef.current, onOpenNode));
  }, [open, client, onOpenNode]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
    // jsdom implements no scrollIntoView — guard the optional call.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [clampedActive]);

  if (!open) return null;

  const select = (item: PaletteItem) => {
    onClose();
    item.run();
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[clampedActive];
      if (item !== undefined) select(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  let lastGroup: PaletteItem["group"] | null = null;
  let flatIndex = -1;

  return (
    <div className="nt-modal-backdrop nt-palette-backdrop" onClick={onClose}>
      <div
        className="nt-modal nt-palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <SearchField
          autoFocus
          value={query}
          placeholder="Search pages, classes, actions… (is_daily: for dates)"
          aria-label="Command palette search"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onInputKeyDown}
        />
        <div className="nt-palette-results" ref={listRef}>
          {filtered.map((item) => {
            flatIndex += 1;
            const index = flatIndex;
            const groupLabel = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key} className="nt-palette-group">
                {groupLabel !== null && (
                  <div className="nt-palette-group-label-row">
                    <span className="nt-palette-group-label">{groupLabel}</span>
                    {groupLabel === "Random" && (
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="mdiRefresh"
                        aria-label="Refresh random pages"
                        title="Refresh random pages"
                        onClick={(event) => {
                          // The row select gesture must not fire alongside.
                          event.stopPropagation();
                          refreshRandomPages();
                        }}
                      />
                    )}
                  </div>
                )}
                <button
                  type="button"
                  className="nt-palette-item"
                  data-active={index === clampedActive}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(item)}
                >
                  <span className="nt-palette-item-top">
                    <Icon path={item.icon} size={0.9} className="nt-palette-item-icon" />
                    <span className="nt-palette-item-label">{item.label}</span>
                    {item.meta !== undefined && (
                      <span className="nt-palette-item-meta">{item.meta}</span>
                    )}
                  </span>
                  {item.snippet !== null && item.snippet !== undefined && (
                    <SnippetLine snippet={item.snippet} />
                  )}
                </button>
              </div>
            );
          })}
          {contentLoading && <div className="nt-palette-searching">Searching content…</div>}
          {filtered.length === 0 && !contentLoading && (
            <div className="nt-palette-empty">No results. Try a different search.</div>
          )}
        </div>
        <div className="nt-palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          <span>is_daily: dates</span>
        </div>
      </div>
    </div>
  );
}
