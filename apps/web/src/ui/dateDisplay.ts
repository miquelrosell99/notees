/**
 * Date-page display — apply the user's `dateFormat` device setting to the
 * stored compact date labels (day `YYYYMMDD`, month `YYYYMM00`, year
 * `YYYY0000`). The domain's deriveDisplayName formats date names with a
 * fixed slash layout; display points that can read the device setting route
 * through here so the user's preference actually applies (the page header
 * is the main one — the stored name itself must stay compact for
 * chronological sorting and the v1 lookup contract).
 */

import { deriveDisplayName, parseDateNodeId, dateNodeLabel, plainTextExcerpt, type NodeLike } from "@notees/domain";

import { readDeviceSetting } from "./components/modals/deviceSettings.js";

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
 * True when the node's CONTENT holds a compact date label (title-is-content:
 * migrated date pages carry YYYYMMDD-style text as their content).
 */
export function isDateNamed(node: { name: string | null; contentAst?: unknown }): boolean {
  if (node.name !== null && formatDateName(node.name) !== null) return true;
  const excerpt = node.contentAst
    ? plainTextExcerpt(node.contentAst as never)
    : "";
  return excerpt !== "" && formatDateName(excerpt) !== null;
}

/**
 * True when the node IS a date page: the deterministic date id is the
 * primary test (migrated pages may carry the compact label in their
 * CONTENT with a null name), then the date classes, then the name shape.
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
  if (node.classIds?.some((c) => DATE_CLASSES.includes(c)) === true) return true;
  return isDateNamed(node);
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
 */
export function displayNameForSettings(node: NodeLike): string {
  const fromId = parseDateNodeId(node.id);
  if (fromId !== null) {
    const year = String(fromId.year);
    const month = pad2(fromId.month);
    const day = pad2(fromId.day);
    if (fromId.precision === "year") return year;
    if (fromId.precision === "month") return `${year}/${month}`;
    return (
      formatDateName(`${year}${month}${day}`) ?? deriveDisplayName(node)
    );
  }
  return deriveDisplayName(node);
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
  return displayNameForSettings(node);
}
