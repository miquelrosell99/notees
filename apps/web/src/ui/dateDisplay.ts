/**
 * Date-page display — apply the user's `dateFormat` device setting to the
 * stored compact date labels (day `YYYYMMDD`, month `YYYYMM00`, year
 * `YYYY0000`). The domain's deriveDisplayName formats date names with a
 * fixed slash layout; display points that can read the device setting route
 * through here so the user's preference actually applies (the page header
 * is the main one — the stored name itself must stay compact for
 * chronological sorting and the compact lookup contract).
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
import { untitledLabelOf } from "./renderStateLabel.js";

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
 * deliberately NOT a test (owner ruling 2026-10-08): date formatting
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

/**
 * The display name for a node, with the user's dateFormat applied to date
 * pages; everything else defers to deriveDisplayName (title-is-content:
 * the title is the node's own text, there is no name field). Date identity
 * comes from the deterministic id first — migrated date pages may carry
 * the compact label in their content with no other marker, and the excerpt
 * must not leak through as a raw YYYYMMDD.
 *
 * Pass `resolveClassName` to include inline class chips' resolved labels in
 * the excerpt (flattened chrome: browser tab title, table cells) — without
 * it a bare chip contributes nothing (domain-pure default).
 */
export function nodeDisplayName(
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
 * The plain-text chrome label of a node: `nodeDisplayName` PLUS the two
 * chrome flattens dense surfaces need — markdown link spans reduced to
 * their label (per text token, BEFORE the 80-char cap, so a long href can
 * never crowd the label out; the domain's splitMarkdownLinks is the
 * canonical render grammar) and, via `resolveClassName`, inline class chips
 * resolved to the class's current name (without a resolver a bare chip
 * contributes nothing). This is the breadcrumb / sidebar-row derivation:
 * strings, never interactive or styled markup.
 */
export function plainTitleOf(
  node: NodeLike,
  resolveClassName?: (classId: string) => string | null,
): string {
  const strippedAst = (node.contentAst ?? []).map((token) =>
    token.type === "text"
      ? { ...token, text: splitMarkdownLinks(token.text).map((segment) => segment.text).join("") }
      : token,
  );
  return nodeDisplayName({ ...node, contentAst: strippedAst }, resolveClassName);
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

/**
 * Setting-aware drop-in for client.getDisplayName — the single funnel for
 * name rendering in the UI (titles, mention chips, links, date properties,
 * pickers, breadcrumbs, exports). Date pages format per the user's
 * dateFormat; every other node defers to the client (deriveDisplayName).
 * The client's own method stays pure because it also runs in the worker,
 * where device settings do not exist.
 */
export function displayNameFromClient(
  client: Pick<
    { getNode(id: string): NodeLike | undefined },
    "getNode"
  > & { getDisplayName(id: string): string | null },
  id: string,
): string | null {
  const node = client.getNode(id);
  if (node === undefined) return client.getDisplayName(id);
  return nodeDisplayName(node);
}

/**
 * The never-a-bare-UUID label seam (owner 2026-10-23): the live display
 * name; else the RAW read's derived name — an archived or trashed node
 * KEEPS its name (only permanent deletion leaves no row); a live node with
 * empty content reads "Untitled <render-state>" (renderStateLabel's
 * convention). Null ONLY when no row exists at all — a dangling reference
 * (e.g. a binding to a permanently deleted class, the retired class-class
 * debt) — and callers hide the chip or pick their own placeholder: identity
 * is never user-facing.
 */
export function labelFromClient(
  client: Pick<{ getNode(id: string): NodeLike | undefined }, "getNode"> & {
    /** Optional: clients/mocks without the raw read degrade to getDisplayName
     *  (which resolves raw itself where supported). */
    getNodeRaw?(id: string): NodeLike | undefined;
    getDisplayName(id: string): string | null;
    /** Optional: mocks without the parentlessRole read keep the pre-flag
     *  label; both client classes carry it. */
    effectiveClassParentlessBlock?(classId: string): boolean;
  },
  id: string,
): string | null {
  const facts = (n: NodeLike): Parameters<typeof untitledLabelOf>[0] => ({
    isClass: n.isClass === true || n.isClass === 1,
    isEmbedded: n.isEmbedded === true || n.isEmbedded === 1,
    parentId: n.parentId ?? null,
    classIds: n.classIds ?? [],
  });
  const resolver = client.effectiveClassParentlessBlock?.bind(client);
  const live = client.getNode(id);
  if (live !== undefined) return nodeDisplayName(live) || untitledLabelOf(facts(live), resolver);
  if (client.getNodeRaw !== undefined) {
    const raw = client.getNodeRaw(id);
    if (raw !== undefined)
      return deriveDisplayName(raw) || untitledLabelOf(facts(raw), resolver);
  }
  return client.getDisplayName(id);
}

/**
 * The full-title siblings (owner ruling: node links and mention chips
 * render the COMPLETE title — a link must read as the page's whole title,
 * never a truncation). Date pages keep the exact same deterministic-id
 * formatting branch; every other node defers to fullTitleOf, the uncapped
 * title-is-content derivation (dense chrome keeps reading
 * displayNameFromClient, which stays capped).
 */
export function fullTitleForSettings(node: NodeLike): string {
  const fromId = parseDateNodeId(node.id);
  if (fromId !== null) {
    const year = String(fromId.year);
    const month = pad2(fromId.month);
    const day = pad2(fromId.day);
    if (fromId.precision === "year") return year;
    if (fromId.precision === "month") return `${year}/${month}`;
    return formatDateName(`${year}${month}${day}`) ?? fullTitleOf(node);
  }
  return fullTitleOf(node);
}

export function fullTitleFromClient(
  client: Pick<
    { getNode(id: string): NodeLike | undefined },
    "getNode"
  > & { getDisplayName(id: string): string | null },
  id: string,
): string | null {
  const node = client.getNode(id);
  if (node === undefined) return client.getDisplayName(id);
  return fullTitleForSettings(node);
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
