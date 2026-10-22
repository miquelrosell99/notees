/**
 * filterModel — the shared logic behind `/` filter mode (the command palette
 * and every node picker): what filters exist, how the `/`-mode option list is
 * built and narrowed, and how an applied filter derives its chip label/icon.
 *
 * Interaction contract (the hosts own state; this module is pure):
 *  - A query starting with `/` puts the host into filter mode; the text after
 *    the slash narrows the option list (subsequence fuzzy over labels and
 *    keywords; class names fold diacritics).
 *  - Applying an option yields a `SearchFilter` chip; chips compose (AND) and
 *    dedupe by `filterKey`. The "With class…" family row carries no class —
 *    the host switches to a class browse listing (`listClassOptions`) instead
 *    of applying a chip.
 *  - The palette offers every kind; pickers gate the list per `searchMode`
 *    (classes mode offers nothing; blocks mode offers no Pages kind, pages
 *    mode no Blocks kind, only all/palette see the Classes kind).
 */

import { foldSearchText } from "@notees/store";

import type { ClientNode } from "@/core/workspace-client/index.js";
import { nodeDisplayName } from "../../ui/dateDisplay.js";

/** The filter kinds. `memberOf` is the only parameterized one (a class id). */
export type SearchFilterKind = "daily" | "pages" | "blocks" | "classes" | "memberOf" | "commands";

export interface SearchFilter {
  kind: SearchFilterKind;
  /** Set only for `memberOf`: the class whose members pass. */
  classId?: string;
}

/**
 * Ordered-subsequence fuzzy score, or null when the query does not match.
 * Word-start and consecutive matches score higher; shorter targets win ties.
 * (Moved here from the command palette — it is now the shared scorer for the
 * palette sections and the `/`-mode option narrowing.)
 */
export function fuzzyScore(query: string, target: string): number | null {
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

export function bestScore(query: string, label: string, keywords: string): number | null {
  const labelScore = fuzzyScore(query, label);
  const keywordScore = fuzzyScore(query, keywords);
  return labelScore !== null && keywordScore !== null
    ? Math.max(labelScore, keywordScore)
    : (labelScore ?? keywordScore);
}

/** Stable identity for a filter — chips dedupe on this. */
export function filterKey(filter: SearchFilter): string {
  return filter.kind === "memberOf" ? `memberOf:${filter.classId ?? ""}` : filter.kind;
}

/**
 * The host surface: the palette (`"palette"`) or a picker `searchMode`.
 * Gates which filter kinds the option list offers.
 */
export type FilterSurfaceMode = "palette" | "pages" | "classes" | "all" | "blocks";

export interface FilterOption {
  /** Stable row id (option identity within the menu). */
  id: string;
  /** The filter the option applies (the "With class…" family row carries kind `memberOf` with no classId). */
  filter: SearchFilter;
  label: string;
  description: string;
  icon: string;
}

/** One row of the base option list (before class expansion). */
interface BaseOption {
  kind: SearchFilterKind;
  label: string;
  description: string;
  keywords: string;
  icon: string;
  offer: (mode: FilterSurfaceMode) => boolean;
}

const BASE_OPTIONS: BaseOption[] = [
  {
    kind: "daily",
    label: "Daily pages",
    description: "Only date-chain day pages",
    keywords: "daily date journal day",
    icon: "mdi-calendar",
    offer: (mode) => mode !== "classes",
  },
  {
    kind: "pages",
    label: "Pages",
    description: "Only pages with document chrome",
    keywords: "page document main",
    icon: "mdi-file-document-outline",
    offer: (mode) => mode === "palette" || mode === "pages" || mode === "all",
  },
  {
    kind: "blocks",
    label: "Blocks",
    description: "Only inline blocks",
    keywords: "block inline body",
    icon: "mdi-format-text",
    offer: (mode) => mode === "palette" || mode === "blocks" || mode === "all",
  },
  {
    kind: "classes",
    label: "Classes",
    description: "Only classes",
    keywords: "class type schema",
    icon: "mdi-shape-outline",
    offer: (mode) => mode === "palette" || mode === "all",
  },
  {
    kind: "memberOf",
    label: "With class…",
    description: "Browse classes to filter by",
    keywords: "class with member tagged",
    icon: "mdi-shape-plus",
    offer: (mode) => mode !== "classes",
  },
  {
    kind: "commands",
    label: "Commands",
    description: "Only commands and actions",
    keywords: "command action run",
    icon: "mdi-apple-keyboard-command",
    offer: (mode) => mode === "palette",
  },
];

/** Cap the class rows appended to a narrowed option list. */
const MAX_CLASS_OPTIONS = 8;
/** Cap the class browse listing (the "With class…" sub-state). */
const MAX_CLASS_BROWSE = 50;

const folded = (text: string): string => foldSearchText(text.toLowerCase());

/**
 * Build the `/`-mode option list for a surface: the offered base options
 * fuzzy-narrowed by the slash text, plus one row per class the slash text
 * names (the "With class…" family made concrete). The bare "With class…"
 * family row appears only on an empty slash text — where it switches the host
 * into the class browse — typing a class name surfaces the classes directly.
 */
export function listFilterOptions(args: {
  narrowText: string;
  classes: ClientNode[];
  mode: FilterSurfaceMode;
}): FilterOption[] {
  const { narrowText, classes, mode } = args;
  const narrow = narrowText.trim();
  const options: FilterOption[] = [];
  for (const base of BASE_OPTIONS) {
    if (!base.offer(mode)) continue;
    // The family row is the empty-text entry into the class browse; a
    // non-empty slash text lists the matching classes themselves instead.
    if (base.kind === "memberOf" && narrow !== "") continue;
    if (narrow !== "" && bestScore(narrow, base.label, base.keywords) === null) continue;
    options.push({
      id: base.kind,
      filter: { kind: base.kind },
      label: base.label,
      description: base.description,
      icon: base.icon,
    });
  }
  if (narrow !== "") {
    const fold = folded(narrow);
    for (const cls of classes) {
      const name = nodeDisplayName(cls);
      if (name === "" || !folded(name).includes(fold)) continue;
      options.push({
        id: `memberOf:${cls.id}`,
        filter: { kind: "memberOf", classId: cls.id },
        label: `Class: ${name}`,
        description: "Only nodes with this class",
        icon: cls.icon ?? "mdi-shape-outline",
      });
      if (options.length >= BASE_OPTIONS.length + MAX_CLASS_OPTIONS) break;
    }
  }
  return options;
}

/**
 * The class browse listing (the "With class…" sub-state): every class whose
 * folded name contains the slash text, alphabetical, capped.
 */
export function listClassOptions(classes: ClientNode[], narrowText: string): FilterOption[] {
  const fold = folded(narrowText.trim());
  return classes
    .map((cls) => ({ cls, name: nodeDisplayName(cls) }))
    .filter((entry) => entry.name !== "" && (fold === "" || folded(entry.name).includes(fold)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_CLASS_BROWSE)
    .map((entry) => ({
      id: `memberOf:${entry.cls.id}`,
      filter: { kind: "memberOf" as const, classId: entry.cls.id },
      label: entry.name,
      description: "Only nodes with this class",
      icon: entry.cls.icon ?? "mdi-shape-outline",
    }));
}

/** The chip's text: `Class: <name>` for memberOf, the plain label otherwise. */
export function filterChipLabel(filter: SearchFilter, classes: ClientNode[]): string {
  if (filter.kind === "memberOf") {
    const cls = classes.find((entry) => entry.id === filter.classId);
    const name = cls !== undefined ? nodeDisplayName(cls) : "";
    return name !== "" ? `Class: ${name}` : "With class";
  }
  const base = BASE_OPTIONS.find((entry) => entry.kind === filter.kind);
  return base?.label ?? filter.kind;
}

/** The chip's icon: the class's own icon for memberOf, the kind icon otherwise. */
export function filterChipIcon(filter: SearchFilter, classes: ClientNode[]): string {
  if (filter.kind === "memberOf") {
    const cls = classes.find((entry) => entry.id === filter.classId);
    return cls?.icon ?? "mdi-shape-outline";
  }
  const base = BASE_OPTIONS.find((entry) => entry.kind === filter.kind);
  return base?.icon ?? "mdi-filter-outline";
}
