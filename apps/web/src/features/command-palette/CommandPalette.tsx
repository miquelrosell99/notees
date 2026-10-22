/**
 * CommandPalette — Ctrl/Cmd+K command surface (plus the topbar search
 * trigger, via the `open` prop). A fixed-position modal (~top 18vh, 560px)
 * with an autofocused SearchField and a fuzzy subsequence filter over the
 * section registry:
 *
 *  - Recent     device-local recents (empty query only — the Sidebar's
 *               `notees.recents` contract; no sync per the owner ruling)
 *  - Random     five pages picked on open via Fisher–Yates over the
 *               already-loaded page list (asset-classed pages excluded); the
 *               group label carries a ghost refresh button that re-shuffles
 *               the SAME cached pool — deliberately no new worker query
 *               (the ruling: extra projections starve the palette on
 *               large workspaces). Empty query only; exempt from the
 *               seen-ids dedupe like Commands (#8)
 *  - Date Pages date pages matching the query: formatted/raw keywords plus a
 *               parsed-date suggestion ("feb 14" → the deterministic date
 *               chain). The `is_daily:` prefix and the Daily pages chip
 *               scope the whole palette to this section.
 *  - Pages      (client.listPages, asset-classed pages excluded)
 *  - Classes    (client.listClasses)
 *  - Properties (client.listPropertySchemas; the host's `onOpenProperty`
 *               hosts the PropertyView modal — a contribution point, like
 *               `onOpenClassCreate`)
 *  - Content    debounced ranked FTS (client.searchPage) with match
 *               snippets; block hits carry their containing-page label
 *               (label helper shared with the picker)
 *
 * Section order: the search sections rank Classes, Properties, Pages,
 * Content (owner-mandated), then Date Pages and Commands; the empty-query
 * home keeps Recent → Random → Commands. The flatten step is a stable sort
 * on the mode-dependent group rank, so score order inside a group survives.
 *  - Commands   the action registry: New page, New class… (#14, where the
 *               host provides it), a typed "Create page …" row, Merge current
 *               page into… (where the host provides it and the current node
 *               is a mergeable page), Focus mode (#12), Condensed: enter /
 *               exit (the condensed layer, where the host provides it and a
 *               page is open), Toggle theme, Sign
 *               out (a contribution point)
 *
 *  - `/` filter mode (owner 2026-10-22): a leading `/` swaps the results for
 *    a Filters section — the filter kinds (Daily pages, Pages, Blocks,
 *    Classes, With class…, Commands) narrowed by the slash text; classes the
 *    text names surface directly, and the "With class…" row browses the full
 *    class list. Applying an option renders it as a removable chip under the
 *    search field and scopes the results: kind chips restrict the sections
 *    (Commands = the action registry only), memberOf chips restrict every
 *    node section to the class's members. Chips compose (AND), dedupe, and
 *    Backspace on an empty query pops the last chip. The picker family
 *    shares the model (`features/search-filters/filterModel.ts`).
 *
 * Full keyboard navigation: ArrowUp/Down cycles, Enter selects, Esc closes;
 * the mouse hovers and clicks. Theme toggling dispatches the same
 * data-theme/localStorage flip as ThemeToggle. Rendered through the shared
 * modal chrome (Modal.css) with a palette skin on top.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, chainNodeIds, rendersAsInlineBlock, rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, SearchSnippetData, WorkspaceClient } from "@/core/workspace-client/index.js";
import type { UndoUiState } from "@/core/undo-journal.js";

import { nodeDisplayName, isDatePageNode, rawDateKeywordOf } from "../../ui/dateDisplay.js";
import { Icon } from "../../ui/Icon.js";
import { parentRenderFacts } from "../../ui/renderStateLabel.js";
import { flipTheme, toggleFocusMode } from "../settings/deviceSettings.js";
import { parseDate, isPlainYearQuery } from "../date-pickers/dateParser.js";
import {
  bestScore,
  filterChipIcon,
  filterChipLabel,
  filterKey,
  listClassOptions,
  listFilterOptions,
} from "../search-filters/filterModel.js";
import type { FilterOption, SearchFilter } from "../search-filters/filterModel.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { FilterChips } from "../../components/ui/fleet/FilterChips.js";
import { FilterMenu } from "../../components/ui/fleet/FilterMenu.js";
import { SearchField } from "../../components/ui/fleet/SearchField.js";
import "./Modal.css";
import "./CommandPalette.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** The Sidebar's device-local recents key — same contract, read-only here. */
const RECENTS_KEY = "notees.recents";
/** The Random section's row count (the original section's slice size). */
const RANDOM_PAGE_COUNT = 5;

type Group = "Recent" | "Random" | "Date Pages" | "Pages" | "Classes" | "Properties" | "Content" | "Commands";

interface PaletteItem {
  key: string;
  group: Group;
  label: string;
  icon: string;
  keywords: string;
  /** Right-side hint — the containing page for block content hits. */
  meta?: string | undefined;
  /** Match-context excerpt under the label (the Content group). */
  snippet?: SearchSnippetData | null;
  run: () => void;
}

/** One action registry entry (contribution-point shape). */
interface PaletteAction {
  key: string;
  label: string;
  icon: string;
  keywords: string;
  run: () => void;
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

/** One mdi glyph per property type (mirrors the Class View's TYPE_GLYPHS). */
const PROPERTY_TYPE_GLYPHS: Record<string, string> = {
  text: "mdi-format-letter-case",
  number: "mdi-pound",
  url: "mdi-link-variant",
  email: "mdi-email-outline",
  datetime: "mdi-calendar",
  select: "mdi-form-select",
  object: "mdi-target",
  image: "mdi-image",
  boolean: "mdi-check-circle-outline",
};

/** Containing-page breadcrumb for a block hit. */
function containingPageLabel(client: AnyClient, node: ClientNode): string | null {
  let currentId = node.parentId;
  let guard = 0;
  while (currentId !== null && guard < 64) {
    const parent = client.getNode(currentId);
    if (parent === undefined) return null;
    if (rendersWithDocumentChrome(parent)) return nodeDisplayName(parent) || "Untitled";
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
 * Fisher–Yates over a copy (the shufflePages precedent, #8) — pure with
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
      label: nodeDisplayName(page) || "Untitled",
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
  onOpenClassCreate = undefined,
  onOpenProperty = undefined,
  currentNodeId = undefined,
  onOpenMerge = undefined,
  condensedActive = undefined,
  onToggleCondensed = undefined,
  onOpenSearch = undefined,
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
  /** #14 — open the class-creation modal (blank + system deploy); the row
   *  appears only where the host provides it. */
  onOpenClassCreate?: (() => void) | undefined;
  /** Open a property schema's PropertyView inspector — the row appears only
   *  where the host provides it (a contribution point, like the class create). */
  onOpenProperty?: ((propertySchemaId: string) => void) | undefined;
  /**
   * The node currently open in the host — the merge action's source. The
   * "Merge current page into…" row appears only where the host provides both
   * this and `onOpenMerge`, and the current node is a mergeable page (a
   * non-class node rendering with document chrome — classes and inline
   * blocks are not mergeable).
   */
  currentNodeId?: string | undefined;
  /** Open the merge-into modal for `currentNodeId` — a contribution point. */
  onOpenMerge?: (() => void) | undefined;
  /**
   * The condensed layer (owner 2026-10-15): the "Condensed: enter/exit" row
   * appears only where the host provides this and an eligible page is open
   * (the host gates the callback on its selection) — the conditional-row
   * pattern of the merge action. `condensedActive` names the row and icon
   * (the active page's per-page pref, the TopBar toggle's twin surface).
   */
  condensedActive?: boolean | undefined;
  onToggleCondensed?: (() => void) | undefined;
  /**
   * The full-page search handoff: with a non-empty query the footer row
   * "Search all for …" appears and navigates to /search carrying the query
   * — a contribution point, like the class create.
   */
  onOpenSearch?: ((query: string) => void) | undefined;
  onSignOut: () => void;
  /** The session undo journal state; rows appear only when available. */
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
   * (the ruling: extra projections starve the palette on large
   * workspaces). The rows are display data captured at pick time, so a
   * refresh never re-runs the sync-sections memo.
   */
  const [randomRows, setRandomRows] = useState<PaletteItem[]>([]);
  const randomPoolRef = useRef<readonly string[]>([]);
  /** Debounced FTS content group: tagged with the query they answer. */
  const [contentItems, setContentItems] = useState<Array<PaletteItem & { queryTag: string }>>([]);
  const [contentLoading, setContentLoading] = useState(false);
  const contentGeneration = useRef(0);
  /**
   * `/` filter mode: the applied chips (compose AND, dedupe by filterKey)
   * and the "With class…" browse sub-state (the class listing replaces the
   * option list until a class is picked or the slash text is cleared).
   */
  const [activeFilters, setActiveFilters] = useState<SearchFilter[]>([]);
  const [filterBrowse, setFilterBrowse] = useState<"options" | "classes">("options");
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

  // Query parsing: the `is_daily:` prefix scopes the palette to date pages;
  // a leading `/` enters filter mode (the slash text narrows the filter
  // options, the results list steps aside); the rest is the fuzzy/FTS text.
  const filterMode = query.startsWith("/");
  const narrowText = filterMode ? query.slice(1) : "";

  // Chip state: kind chips gate whole sections; memberOf chips restrict
  // every node section to the classes' members.
  const chip = useMemo(
    () => ({
      daily: activeFilters.some((f) => f.kind === "daily"),
      pages: activeFilters.some((f) => f.kind === "pages"),
      blocks: activeFilters.some((f) => f.kind === "blocks"),
      classes: activeFilters.some((f) => f.kind === "classes"),
      commands: activeFilters.some((f) => f.kind === "commands"),
      memberOf: activeFilters.flatMap((f) =>
        f.kind === "memberOf" && f.classId !== undefined ? [f.classId] : [],
      ),
    }),
    [activeFilters],
  );
  const anyChip = activeFilters.length > 0;
  const memberOfSet = useMemo(() => new Set(chip.memberOf), [chip.memberOf]);
  const hasMemberOf = chip.memberOf.length > 0;

  const dailyOnly = /^is_daily:\s*/i.test(query) || chip.daily;
  const text = filterMode ? "" : query.replace(/^is_daily:\s*/i, "").trim();
  /** The empty-query home: no slash, no prefix, no chips — Recent/Random live here. */
  const home = !filterMode && !dailyOnly && text === "" && !anyChip;

  // The class cache doubles as the chip label/icon + filter menu source.
  const classesCache = useMemo(() => client.listClasses(), [client, cacheVersion]);

  // --- synchronous sections -------------------------------------------------

  const syncItems = useMemo<PaletteItem[]>(() => {
    const classes = classesCache;
    const assetClassId =
      classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
    const memberOfMatch = (node: ClientNode) =>
      !hasMemberOf || node.classIds.some((id) => memberOfSet.has(id));
    const pages = client
      .listPages()
      .filter((page) => !page.classIds.includes(assetClassId))
      .filter(memberOfMatch);
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

    if (home) {
      const recentPool: Array<{ id: string; label: string; keywords: string; icon: string; run: () => void }> = [];
      const seenRecent = new Set<string>();
      for (const id of recentIds.slice(0, 8)) {
        if (seenRecent.has(id)) continue;
        seenRecent.add(id);
        const node = client.getNode(id);
        if (node === undefined || node.classIds.includes(assetClassId)) continue;
        recentPool.push({
          id: node.id,
          label: nodeDisplayName(node) || "Untitled",
          icon: node.icon ?? "mdi-file-document-outline",
          keywords: rawDateKeywordOf(node),
          run: () => onOpenNode(node.id),
        });
      }
      addFuzzy("Recent", recentPool);
    }

    if (!chip.commands && !chip.classes && !chip.blocks && (dailyOnly || text !== "")) {
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
          label: nodeDisplayName(page) || "Untitled",
          icon: page.icon ?? "mdi-calendar",
          // The raw compact label stays a keyword: display is formatted, but
          // users still type YYYYMMDD to find a date page.
          keywords: rawDateKeywordOf(page),
          run: () => onOpenNode(page.id),
        });
      }
      addFuzzy("Date Pages", datePool);
    }

    // Pages answer a non-empty query, the Pages chip — or a With-class chip
    // alone (its members are the natural candidate set at an empty query).
    if (!chip.commands && !chip.classes && !chip.blocks && !dailyOnly && (chip.pages || hasMemberOf || text !== "")) {
      addFuzzy(
        "Pages",
        pages.map((page) => ({
          id: page.id,
          label: nodeDisplayName(page) || "Untitled page",
          icon: page.icon ?? "mdi-file-document-outline",
          keywords: rawDateKeywordOf(page),
          run: () => onOpenNode(page.id),
        })),
      );
    }

    if (!anyChip && !dailyOnly && text !== "") {
      addFuzzy(
        "Classes",
        classes.map((cls) => ({
          id: cls.id,
          label: nodeDisplayName(cls) || "Untitled class",
          icon: cls.icon ?? "mdi-shape-outline",
          keywords: `${nodeDisplayName(cls)}`,
          run: () => onOpenNode(cls.id),
        })),
      );
      if (onOpenProperty !== undefined) {
        // Property schemas are registry rows, not nodes; the type name stays
        // a keyword so "date"/"select"/… finds the family.
        addFuzzy(
          "Properties",
          client.listPropertySchemas().map((schema) => ({
            id: schema.id,
            label: schema.name,
            icon: PROPERTY_TYPE_GLYPHS[schema.type] ?? "mdi-format-list-bulleted",
            keywords: `${schema.type} property`,
            run: () => onOpenProperty(schema.id),
          })),
        );
      }
    }

    if (chip.classes && !chip.commands) {
      // The Classes chip: only the class section answers.
      addFuzzy(
        "Classes",
        classes.map((cls) => ({
          id: cls.id,
          label: nodeDisplayName(cls) || "Untitled class",
          icon: cls.icon ?? "mdi-shape-outline",
          keywords: `${nodeDisplayName(cls)}`,
          run: () => onOpenNode(cls.id),
        })),
      );
    }

    // Action registry: static rows + a query-scoped typed creation +
    // the session journal's Undo/Redo rows (present only when the
    // journal has something to (re)apply; the row IS the label). With node
    // chips active the registry would only be noise — only the Commands
    // chip (or no chips at all) builds it. The typed create row needs a
    // class path the palette's `onNewPage(title)` does not have, so it
    // stays hidden under a memberOf chip.
    if (!anyChip || chip.commands) {
      const actions: PaletteAction[] = [
        {
          key: "new-page",
          label: "New page",
          icon: "mdi-file-plus-outline",
          keywords: "new create page add",
          run: () => onNewPage(),
        },
        ...(onOpenClassCreate !== undefined
          ? [
              {
                key: "new-class",
                label: "New class…",
                icon: "mdiShapePlus",
                keywords: "new create class add deploy system",
                run: () => onOpenClassCreate(),
              },
            ]
          : []),
        ...(onOpenMerge !== undefined && currentNodeId !== undefined
          ? (() => {
              const current = client.getNode(currentNodeId);
              const mergeable =
                current !== undefined &&
                !current.isClass &&
                rendersWithDocumentChrome(current, parentRenderFacts(client, current));
              return mergeable
                ? [
                    {
                      key: "merge-page",
                      label: "Merge current page into…",
                      icon: "mdiMerge",
                      keywords: "merge combine absorb move into",
                      run: () => onOpenMerge(),
                    },
                  ]
                : [];
            })()
          : []),
        ...(text !== "" && !hasMemberOf
          ? [
              {
                key: "create-titled",
                // A bare year the date system doesn't claim reads as a year
                // page ("Create year "1711""), not a generic numbered page.
                label: isPlainYearQuery(text) ? `Create year "${text}"` : `Create page "${text}"`,
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
        ...(onToggleCondensed !== undefined
          ? [
              {
                key: "toggle-condensed",
                label: condensedActive === true ? "Condensed: exit" : "Condensed: enter",
                icon: condensedActive === true ? "mdiUnfoldMoreHorizontal" : "mdiUnfoldLessHorizontal",
                keywords: "condensed stretchtext excerpt summary layer view",
                run: () => onToggleCondensed(),
              },
            ]
          : []),
        {
          key: "toggle-theme",
          label: themeIsDark ? "Toggle theme: switch to light" : "Toggle theme: switch to dark",
          icon: themeIsDark ? "mdi-white-balance-sunny" : "mdi-weather-night",
          keywords: "theme dark light appearance",
          run: () => {
            flipTheme();
          },
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
    }

    return items;
    // cacheVersion rides through classesCache (the memo re-derives the
    // sections when the worker cache refreshes).
  }, [client, classesCache, home, dailyOnly, text, chip, anyChip, hasMemberOf, memberOfSet, onOpenNode, onNewPage, onOpenClassCreate, onOpenProperty, currentNodeId, onOpenMerge, onToggleCondensed, condensedActive, onSignOut, onClose, recentIds, undoState, onUndo, onRedo]);

  // --- `/` filter mode: the option list -------------------------------------

  const filterOptions = useMemo<FilterOption[]>(() => {
    if (!filterMode) return [];
    return filterBrowse === "classes"
      ? listClassOptions(classesCache, narrowText)
      : listFilterOptions({ narrowText, classes: classesCache, mode: "palette" });
  }, [filterMode, filterBrowse, narrowText, classesCache]);

  const applyFilterOption = (option: FilterOption) => {
    if (option.filter.kind === "memberOf" && option.filter.classId === undefined) {
      // The "With class…" family row: swap the menu to the class browse.
      setFilterBrowse("classes");
      setQuery("/");
      setActiveIndex(0);
      return;
    }
    const key = filterKey(option.filter);
    setActiveFilters((prev) =>
      prev.some((f) => filterKey(f) === key) ? prev : [...prev, option.filter],
    );
    setQuery("");
    setFilterBrowse("options");
    setActiveIndex(0);
  };

  const chipItems = activeFilters.map((filter) => ({
    id: filterKey(filter),
    label: filterChipLabel(filter, classesCache),
    icon: filterChipIcon(filter, classesCache),
  }));

  // --- Content section: debounced ranked FTS with snippets ------------------

  useEffect(() => {
    if (!open) return;
    const mine = ++contentGeneration.current;
    if (dailyOnly || text === "" || chip.commands || chip.classes) {
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
              .filter((node) => !chip.blocks || rendersAsInlineBlock(node, parentRenderFacts(client, node)))
              .filter((node) => !chip.pages || rendersWithDocumentChrome(node, parentRenderFacts(client, node)))
              .filter((node) => !hasMemberOf || node.classIds.some((id) => memberOfSet.has(id)))
              .map((node) => ({
                queryTag: text,
                key: `content:${node.id}`,
                group: "Content" as const,
                label: nodeDisplayName(node) || "Untitled",
                icon: rendersWithDocumentChrome(node, parentRenderFacts(client, node))
                  ? (node.icon ?? "mdi-file-document-outline")
                  : "mdi-format-text",
                keywords: "",
                meta: rendersAsInlineBlock(node, parentRenderFacts(client, node))
                  ? (containingPageLabel(client, node) ?? undefined)
                  : undefined,
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
  }, [open, dailyOnly, text, chip, hasMemberOf, memberOfSet, client, onOpenNode, cacheVersion]);

  // Dedupe + flatten: the cross-group node-id dedupe, stale content pages
  // (answered query ≠ current) dropped, content ids already surfaced as
  // title/date matches skipped. A stable sort on the mode-dependent group
  // rank then orders the sections (score order inside a group survives):
  // search answers Classes → Properties → Pages → Content, then Date Pages
  // and Commands; the empty-query home keeps Recent → Random → Commands.
  const filtered = useMemo(() => {
    const seenIds = new Set<string>();
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
    for (const item of syncItems) push(item);
    if (home) out.push(...randomRows);
    for (const item of contentItems) {
      if (item.queryTag !== text) continue;
      push(item);
    }
    const emptyQuery = home;
    const groupRank = (group: Group): number => {
      if (emptyQuery) return group === "Recent" ? 0 : group === "Random" ? 1 : 2;
      switch (group) {
        case "Classes": return 0;
        case "Properties": return 1;
        case "Pages": return 2;
        case "Content": return 3;
        case "Date Pages": return 4;
        default: return 5;
      }
    };
    return out.sort((a, b) => groupRank(a.group) - groupRank(b.group));
  }, [syncItems, contentItems, text, randomRows, home]);

  /** One flat list drives the keyboard: filter options in `/` mode, results otherwise. */
  const flatCount = filterMode ? filterOptions.length : filtered.length;
  const clampedActive = Math.min(activeIndex, Math.max(0, flatCount - 1));

  // Reset on open; keep the active row visible while arrowing. The Random
  // pool is captured here too — the cached page list, asset-classed pages
  // excluded (the same read the Pages section uses) — and the section's
  // display rows are picked from it. The chips and the filter browse reset
  // with the query.
  //
  // Deps deliberately EXCLUDE the callbacks: App hands this component fresh
  // inline arrow identities every render, and during a background catch-up
  // the shell re-renders constantly — with them in the deps this reset ran
  // on every render and wiped the typed query from under the user (found
  // by the post-fix smoke: the fast boot left catch-up running through
  // the search step). The open-transition + client change are the only
  // moments that should reset the palette.
  const onOpenNodeRef = useRef(onOpenNode);
  onOpenNodeRef.current = onOpenNode;
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setQuery("");
    setActiveIndex(0);
    setContentItems([]);
    setActiveFilters([]);
    setFilterBrowse("options");
    const classes = client.listClasses();
    const assetClassId =
      classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
    const pool = client.listPages().filter((page) => !page.classIds.includes(assetClassId));
    randomPoolRef.current = pool.map((page) => page.id);
    setRandomRows(pickRandomRows(client, randomPoolRef.current, onOpenNodeRef.current));
  }, [open, client]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
    // jsdom implements no scrollIntoView — guard the optional call.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [clampedActive]);

  /**
   * Random refresh (#8): re-shuffle the open-time pool — the same cached id
   * list, never a fresh worker query.
   */
  const refreshRandomPages = () => {
    setRandomRows(pickRandomRows(client, randomPoolRef.current, onOpenNode));
  };

  if (!open) return null;

  const select = (item: PaletteItem) => {
    onClose();
    item.run();
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (flatCount === 0 ? 0 : (index + 1) % flatCount));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (flatCount === 0 ? 0 : (index - 1 + flatCount) % flatCount));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filterMode) {
        const option = filterOptions[clampedActive];
        if (option !== undefined) applyFilterOption(option);
      } else {
        const item = filtered[clampedActive];
        if (item !== undefined) select(item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (!filterMode && event.key === "Backspace" && query === "" && activeFilters.length > 0) {
      // The token-field contract: Backspace on an empty query pops the last chip.
      setActiveFilters((prev) => prev.slice(0, -1));
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
        onKeyDown={(event) => {
          // The input handler covers focus-in-input; this covers focus that
          // has Tabbed onto a row — Escape closes from anywhere inside.
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <SearchField
          autoFocus
          className="search-field--borderless"
          value={query}
          placeholder="Search pages, classes, actions… (/ for filters · is_daily: for dates)"
          aria-label="Command palette search"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            if (!event.target.value.startsWith("/")) setFilterBrowse("options");
          }}
          onKeyDown={onInputKeyDown}
        />
        <FilterChips
          items={chipItems}
          onRemove={(id) =>
            setActiveFilters((prev) => prev.filter((filter) => filterKey(filter) !== id))
          }
          className="nt-palette-chips"
        />
        <div className="nt-palette-results" ref={listRef}>
          {filterMode ? (
            <FilterMenu
              title={filterBrowse === "classes" ? "Classes" : "Filters"}
              options={filterOptions}
              activeIndex={clampedActive}
              onSelect={(id) => {
                const option = filterOptions.find((entry) => entry.id === id);
                if (option !== undefined) applyFilterOption(option);
              }}
              onHover={setActiveIndex}
            />
          ) : (
            <>
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
                <div className="nt-palette-empty">
                  {anyChip
                    ? "Nothing matches these filters. Remove a filter or type to search within them."
                    : "No results. Try a different search."}
                </div>
              )}
            </>
          )}
        </div>
        {text !== "" && onOpenSearch !== undefined && (
          <button
            type="button"
            className="nt-palette-search-all"
            onClick={() => {
              onClose();
              onOpenSearch(text);
            }}
          >
            <Icon path="mdi-magnify" size={0.8} />
            <span>Search all for "{text}"</span>
          </button>
        )}
        <div className="nt-palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          <span>/ filters</span>
          <span>is_daily: dates</span>
        </div>
      </div>
    </div>
  );
}
