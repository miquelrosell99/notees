/**
 * Node titles for display — the unified `titleOf` / `titleOfNode` funnel
 * (one entry point, four explicit axes: budget / flatten / read / empty —
 * see the seam block below) plus the date-page formatting utilities (the
 * user's `dateFormat` device setting applied to the stored compact date
 * labels; the domain's derivations stay pure because they also run in the
 * worker, where device settings do not exist).
 */

import {
  deriveDisplayName,
  fullTitleOf,
  isRangeDatetimeValue,
  isValidTimeOfDay,
  parseDateNodeId,
  dateNodeLabel,
  splitMarkdownLinks,
  type NodeLike,
} from "@notees/domain";

import { readDeviceSetting } from "../features/settings/deviceSettings.js";
import { untitledLabelOf, type RenderStateLabelInput } from "./renderStateLabel.js";

export type DateFormat =
  | "YYYY/MM/DD"
  | "YYYY-MM-DD"
  | "DD/MM/YYYY"
  | "DD-MM-YYYY"
  | "MM/DD/YYYY"
  | "MM-DD-YYYY";

const DATE_FORMATS: readonly DateFormat[] = [
  "YYYY/MM/DD",
  "YYYY-MM-DD",
  "DD/MM/YYYY",
  "DD-MM-YYYY",
  "MM/DD/YYYY",
  "MM-DD-YYYY",
];

/** The device setting, validated against the known formats. */
export function readDateFormat(): DateFormat {
  const value = readDeviceSetting<string | null>("dateFormat", null);
  return DATE_FORMATS.includes(value as DateFormat) ? (value as DateFormat) : "YYYY-MM-DD";
}

/**
 * Format an ISO timestamp (created_at/updated_at, UTC on the wire) as a
 * LOCAL calendar date in the user's display format — the single helper the
 * Created/Updated stamps ride everywhere (footer, tables). Null when the
 * timestamp is missing/unparseable.
 */
export function formatIsoDate(
  iso: string | null,
  format: DateFormat = readDateFormat(),
): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const year = String(date.getFullYear());
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return format.replace(/YYYY/g, year).replace(/MM/g, month).replace(/DD/g, day);
}

/**
 * Format a stored date-node name for display, honoring the user's format.
 * Day names apply the setting's token layout; month/year names have no
 * setting layout (the options are day-oriented) and keep the canonical
 * `YYYY/MM` / `YYYY` shapes. Null when the name is not a compact date label.
 */
export function formatDateName(
  name: string,
  format: DateFormat = readDateFormat(),
): string | null {
  const digits = name.replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  if (month === "00") return year;
  if (day === "00") return `${year}/${month}`;
  return format.replace(/YYYY/g, year).replace(/MM/g, month).replace(/DD/g, day);
}

/**
 * True when the node IS a date page: the deterministic date id is the
 * primary test, then the date classes. The compact-label NAME shape is
 * deliberately NOT a test: date formatting
 * applies only to date-classed nodes — an ordinary page whose title
 * happens to be 8 digits is not a date page. Migrated date pages carry the
 * deterministic date id, so the id test covers them.
 */
export function isDatePageNode(node: {
  id: string;
  name: string | null;
  classIds?: readonly string[];
}): boolean {
  if (parseDateNodeId(node.id) !== null) return true;
  const DATE_CLASSES = [
    "00000000-0000-0000-0001-000000000003", // year
    "00000000-0000-0000-0001-000000000004", // month
    "00000000-0000-0000-0001-000000000005", // day
  ];
  return node.classIds?.some((c) => DATE_CLASSES.includes(c)) === true;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// --- the unified title seam --------------------------------
//
// Every "display name of a node" in the UI derives from ONE funnel with four
// explicit axes — no more per-ruling helper proliferation (the bug class
// where a surface picked the wrong sibling and leaked raw markdown). The
// axes, each with a default matching the old most-common helper:
//
//   budget   "capped" (default, DISPLAY_NAME_MAX — dense chrome) | "full"
//            (the complete title — node links / mention chips)
//   flatten  "raw" (default — the excerpt as authored) | "chrome" (flattened
//            chrome: markdown link spans reduced to their label text, inline
//            class chips resolved to the class's current name — strings,
//            never interactive markup; breadcrumbs, sidebar rows, headers)
//   read     "live" (default — getNode, else the client's getDisplayName) |
//            "fallback" (live → getNodeRaw → getDisplayName — the
//            never-a-bare-UUID seam: an archived/trashed node KEEPS its name)
//   empty    "blank" (default — "" for empty content, callers pick their
//            placeholder) | "untitled" ("Untitled page/class/block", the
//            renderStateLabel convention)
//
// The seam has two entries: `titleOf(client, id, opts)` (the client funnel —
// resolvers come from the client) and `titleOfNode(node, opts)` (node in
// hand, no client). The DOMAIN derivations (deriveDisplayName/fullTitleOf)
// stay pure for the worker and for values that FEED THE LOG — this seam is
// presentation-only and applies the user's dateFormat device setting, which
// never crosses into the worker.

export type TitleBudget = "capped" | "full";
export type TitleFlatten = "raw" | "chrome";
export type TitleRead = "live" | "fallback";
export type TitleEmpty = "blank" | "untitled";

export type TitleOpts = {
  /** "capped" (default): the dense-chrome 80-char budget. "full": the
   *  complete title (node links / mention chips never truncate). */
  budget?: TitleBudget | undefined;
  /** "raw" (default): the excerpt as authored. "chrome": flattened chrome —
   *  markdown link spans reduced to their label text (per text token, BEFORE
   *  the cap, so a long href can never crowd the label out) and inline class
   *  chips resolved to the class's current name. */
  flatten?: TitleFlatten | undefined;
  /** "live" (default): the live read; a missing node defers to the client's
   *  getDisplayName. "fallback": live → raw read → getDisplayName — an
   *  archived or trashed node KEEPS its name (only permanent deletion leaves
   *  no row). */
  read?: TitleRead | undefined;
  /** "blank" (default): empty content reads "". "untitled": empty content
   *  reads "Untitled page/class/block" (the renderStateLabel convention). */
  empty?: TitleEmpty | undefined;
};

/** The minimal client shape the funnel needs (WorkspaceClient and the test
 *  mocks both satisfy it). The two optional reads power the "fallback" read
 *  and the parentlessRole-aware "Untitled" label. */
export type TitleClient = {
  getNode(id: string): NodeLike | undefined;
  getDisplayName(id: string): string | null;
  getNodeRaw?(id: string): NodeLike | undefined;
  effectiveClassParentlessBlock?(classId: string): boolean;
};

type TitleNodeOpts = TitleOpts & {
  /** Class-chip resolver for the "chrome" flatten (the client funnel builds
   *  it from the client automatically). */
  resolveClassName?: ((classId: string) => string | null) | undefined;
  /** The parentlessRole "block" demote for the "untitled" label (the client
   *  funnel builds it from the client automatically). */
  isParentlessBlockClass?: ((classId: string) => boolean) | undefined;
};

function factsOf(n: NodeLike): RenderStateLabelInput {
  return {
    isClass: n.isClass === true || n.isClass === 1,
    isEmbedded: n.isEmbedded === true || n.isEmbedded === 1,
    parentId: n.parentId ?? null,
    classIds: n.classIds ?? [],
  };
}

/** The settings-aware title derivation over one node (the funnel core). */
function titleFromNode(node: NodeLike, opts: TitleNodeOpts): string {
  const flattenChrome = opts.flatten === "chrome";
  const strippedAst = flattenChrome
    ? (node.contentAst ?? []).map((token) =>
        token.type === "text"
          ? { ...token, text: splitMarkdownLinks(token.text).map((segment) => segment.text).join("") }
          : token,
      )
    : node.contentAst;
  const effectiveNode = flattenChrome ? { ...node, contentAst: strippedAst ?? [] } : node;
  const resolveClassName = opts.resolveClassName;
  const name =
    opts.budget === "full"
      ? fullTitleForSettings(effectiveNode, resolveClassName)
      : nodeDisplayName(effectiveNode, resolveClassName);
  if (name !== "") return name;
  return opts.empty === "untitled"
    ? untitledLabelOf(factsOf(node), opts.isParentlessBlockClass)
    : "";
}

/**
 * The client funnel: the title for `id`, axes per `opts` (see TitleOpts).
 * Null ONLY when no row exists at all (permanent deletion / a dangling
 * reference) — identity is never user-facing, so callers hide the chip or
 * pick their own placeholder on null.
 */
export function titleOf(client: TitleClient, id: string, opts: TitleOpts = {}): string | null {
  const nodeOpts: TitleNodeOpts = {
    ...opts,
    resolveClassName:
      opts.flatten === "chrome"
        ? (classId) => client.getDisplayName(classId)
        : undefined,
    isParentlessBlockClass:
      opts.empty === "untitled" ? client.effectiveClassParentlessBlock?.bind(client) : undefined,
  };
  const live = client.getNode(id);
  if (live !== undefined) return titleFromNode(live, nodeOpts);
  if (opts.read === "fallback" && client.getNodeRaw !== undefined) {
    const raw = client.getNodeRaw(id);
    if (raw !== undefined) return titleFromNode(raw, nodeOpts);
  }
  return client.getDisplayName(id);
}

/**
 * The node funnel: the title for a node already in hand (no client lookup).
 * Pass `resolveClassName` for the "chrome" flatten's class chips and
 * `isParentlessBlockClass` for the parentlessRole-aware "untitled" label
 * when no client defaults exist.
 */
export function titleOfNode(
  node: NodeLike,
  opts: TitleNodeOpts = {},
): string {
  return titleFromNode(node, opts);
}

/**
 * The capped settings-aware derivation — the funnel core's budget:"capped"
 * branch. Module-private on purpose: presentation reads the funnel
 * (`titleOf` / `titleOfNode`); the domain's deriveDisplayName stays the
 * worker/log-feeding seam.
 */
function nodeDisplayName(
  node: NodeLike,
  resolveClassName?: (classId: string) => string | null,
): string {
  const fromId = parseDateNodeId(node.id);
  if (fromId !== null) {
    const year = String(fromId.year);
    const month = pad2(fromId.month);
    const day = pad2(fromId.day);
    if (fromId.precision === "year") return year;
    if (fromId.precision === "month") return `${year}/${month}`;
    return (
      formatDateName(`${year}${month}${day}`) ?? deriveDisplayName(node, resolveClassName)
    );
  }
  return deriveDisplayName(node, resolveClassName);
}

/**
 * The full-title settings-aware derivation — the funnel core's budget:"full"
 * branch (node links and mention chips render the COMPLETE
 * title — a link must read as the page's whole title, never a truncation).
 * Module-private on purpose; presentation reads the funnel.
 */
function fullTitleForSettings(
  node: NodeLike,
  resolveClassName?: (classId: string) => string | null,
): string {
  const fromId = parseDateNodeId(node.id);
  if (fromId !== null) {
    const year = String(fromId.year);
    const month = pad2(fromId.month);
    const day = pad2(fromId.day);
    if (fromId.precision === "year") return year;
    if (fromId.precision === "month") return `${year}/${month}`;
    return formatDateName(`${year}${month}${day}`) ?? fullTitleOf(node, resolveClassName);
  }
  return fullTitleOf(node, resolveClassName);
}

/**
 * The compact storage label of a date page (YYYYMMDD / YYYYMM00 / YYYY0000)
 * when its id is a deterministic date id — the raw form users type when
 * searching. Null for non-date nodes.
 */
export function rawDateKeywordOf(node: { id: string }): string {
  const parsed = parseDateNodeId(node.id);
  if (parsed === null) return "";
  return dateNodeLabel(
    { year: parsed.year, month: parsed.month, day: parsed.day },
    parsed.precision,
  );
}

// --- datetime property values (SCHEMA.md "Datetime" — the unified date type) ----

/**
 * One anchored endpoint's label: the date-node formatting pipeline
 * (settings-aware for day refs via the user's dateFormat; the canonical
 * `YYYY` / `YYYY/MM` shapes for year/month refs), with ` HH:MM` appended when
 * a valid wall-clock time rides the slot. A non-date ref passes through.
 */
export function datetimeSlotText(slot: { nodeId: string; time?: unknown }): string {
  const label = dateLabelFromId(slot.nodeId);
  return isValidTimeOfDay(slot.time) ? `${label} ${slot.time}` : label;
}

/**
 * The user-facing text of one datetime VALUE (the union): a point renders its
 * single slot; a range renders `start → end` with `…` for an open side
 * (either side may be null). Legacy bare-uuid refs read leniently, on both
 * the point and the range arms. Null when the value carries no date ref at
 * all — callers fall back honestly.
 */
export function datetimeValueText(value: unknown): string | null {
  if (isRangeDatetimeValue(value)) {
    const range = value as { start?: unknown; end?: unknown };
    const side = (slot: unknown): string => {
      if (slot === null || slot === undefined) return "…";
      if (typeof slot === "string") return dateLabelFromId(slot);
      if (typeof slot === "object") return datetimeSlotText(slot as { nodeId: string; time?: unknown });
      return "…";
    };
    return `${side(range.start)} → ${side(range.end)}`;
  }
  const ref =
    typeof value === "string"
      ? value.length > 0
        ? value
        : null
      : typeof value === "object" && value !== null && typeof (value as { nodeId?: unknown }).nodeId === "string"
        ? (value as { nodeId: string }).nodeId
        : null;
  if (ref === null) return null;
  const time =
    typeof value === "object" && value !== null
      ? (value as { time?: unknown }).time
      : undefined;
  return datetimeSlotText({ nodeId: ref, time });
}

/**
 * The settings-aware label of a date-node id (the id-first branch of
 * nodeDisplayName, usable without a node lookup — property values
 * reference chain nodes that always carry deterministic ids).
 */
function dateLabelFromId(id: string): string {
  const parsed = parseDateNodeId(id);
  if (parsed === null) return id;
  const year = String(parsed.year);
  const month = pad2(parsed.month);
  const day = pad2(parsed.day);
  if (parsed.precision === "year") return year;
  if (parsed.precision === "month") return `${year}/${month}`;
  return formatDateName(`${year}${month}${day}`) ?? `${year}-${month}-${day}`;
}
