/**
 * Grouping helpers — the groupBy capability's container side. Containers
 * own the grouping semantics (they know what the key MEANS); the views only
 * render the resolved CollectionGroup structure.
 */

import type { AnyClient, CollectionGroup, NodeCollectionItem } from "./types.js";
import { formatDateName, titleOf, titleOfNode } from "../../ui/dateDisplay.js";
import { containingPageIdOf } from "./sectionViewResolve.js";
import { scheduledIsoOf } from "../calendar/calendarViewUtils.js";
import { effectivePropertyIcon } from "../metadata/propertyIcon.js";

/**
 * The resolved containing-page grouping (groupByContainingPage): the
 * collapsible page groups PLUS the page sources — items whose referencing
 * node IS the containing page (a page mentioning the target from its own
 * body). A page source never joins a group: it would be a self-named
 * one-row group, so it renders as its own top-level row, before the
 * groups (the view's `ungroupedItems` prop).
 */
export interface ContainingPageGrouping {
  standalone: NodeCollectionItem[];
  groups: CollectionGroup[];
}

/**
 * The references grouping: items group by
 * their containing page (`meta.containingPageId` — the breadcrumb of the
 * page the referencing node lives on); items without that meta group by
 * their own id; items whose source IS the containing page return in
 * `standalone` instead of a self-named group. Header click opens the page.
 * First-seen key order is kept.
 */
export function groupByContainingPage(
  client: AnyClient,
  items: NodeCollectionItem[],
  onOpenPage?: ((pageId: string) => void) | undefined,
): ContainingPageGrouping {
  const standalone: NodeCollectionItem[] = [];
  const byKey = new Map<string, NodeCollectionItem[]>();
  for (const item of items) {
    const metaPage = item.meta?.containingPageId;
    // A page referencing the target from its own body: the containing page
    // IS the source, so a group would name the row's own page after itself
    // — the row stands alone at the top level instead.
    if (typeof metaPage === "string" && metaPage === item.node.id) {
      standalone.push(item);
      continue;
    }
    const key = typeof metaPage === "string" ? metaPage : item.node.id;
    const group = byKey.get(key);
    if (group !== undefined) group.push(item);
    else byKey.set(key, [item]);
  }
  const groups = [...byKey.entries()].map(([key, groupItems]) => {
    const keyNode = client.getNode(key);
    return {
      id: key,
      // The chrome flatten, not the plain client title: the header is
      // flattened chrome, so a markdown link span in the page title renders
      // as its label text — never the raw `[label](href)` source.
      label:
        keyNode !== undefined
          ? titleOfNode(keyNode, {
              flatten: "chrome",
              resolveClassName: (classId) => titleOf(client, classId),
              resolveMentionName: (targetId) => titleOf(client, targetId),
            })
          : (titleOf(client, key) ?? "Untitled"),
      // The header icon is the key node's EFFECTIVE icon — own icon, else the
      // class-chain icon (a daily page shows its authored/class glyph, not a
      // hard-coded page default). effectiveNodeIcon never misses a live page
      // (its tail is the render-state default); the literal fallback covers
      // only a missing key node, and null (an iconless inline-block group)
      // coerces to undefined = no icon, per CollectionGroup.
      icon:
        keyNode !== undefined
          ? (client.effectiveNodeIcon(keyNode) ?? undefined)
          : "mdi-file-document-outline",
      onHeaderClick: onOpenPage === undefined ? undefined : () => onOpenPage(key),
      items: groupItems,
    };
  });
  return { standalone, groups };
}

/* ------------------------------------------------------------------------ */
/* Generic group-by — the groupBy picker's axes and the shared derivation.  */
/* ------------------------------------------------------------------------ */

/**
 * The group-by model (2026-11-25): every property type EXCEPT text is a
 * grouping axis, plus the structural pseudo-axes (page / parent / tag /
 * class / created / edited). Date-typed axes (datetime properties, created,
 * edited) carry a ZOOM (year / month / week / day) picked in the picker's
 * submenu. Group ORDER is semantic per axis: select/boolean ride the option
 * /enum order (empty groups kept ONLY where the surface asks — the cards
 * board's columns are drop targets; everywhere else they drop, the
 * 2026-11-26 ruling), numbers sort numeric, dates chronological, node references and
 * emails alphabetical; the no-value group always trails. Multi-value axes
 * (multi schemas, tags, classes) are multi-membership: an item rides EVERY
 * group it has a value for, so group counts can exceed the item count.
 */

export type DateZoom = "year" | "month" | "week" | "day";

export const DATE_ZOOMS: readonly DateZoom[] = ["year", "month", "week", "day"];

export type GroupBySpec =
  | { kind: "property"; schemaId: string; zoom?: DateZoom }
  | { kind: "page" }
  | { kind: "parent" }
  | { kind: "tag" }
  | { kind: "class" }
  | { kind: "created"; zoom?: DateZoom }
  | { kind: "edited"; zoom?: DateZoom };

/** The default zoom a date axis opens on when none was picked. */
export const DEFAULT_DATE_ZOOM: DateZoom = "month";

/** Text is the ONE ungroupable property type (free-form, unbounded). */
export function isGroupablePropertyType(type: string): boolean {
  return type !== "text";
}

/** True when the axis buckets by calendar period (the zoom submenu). */
export function isDateGroupBy(spec: GroupBySpec, propertyType?: string): boolean {
  if (spec.kind === "created" || spec.kind === "edited") return true;
  return spec.kind === "property" && propertyType === "datetime";
}

/** Structural validation for persisted specs (schema existence is the caller's). */
export function parseGroupBySpec(raw: unknown): GroupBySpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const zoom = candidate.zoom;
  if (zoom !== undefined && !(DATE_ZOOMS as readonly unknown[]).includes(zoom)) return null;
  switch (candidate.kind) {
    case "page":
      return { kind: "page" };
    case "parent":
      return { kind: "parent" };
    case "tag":
      return { kind: "tag" };
    case "class":
      return { kind: "class" };
    case "created":
      return { kind: "created", ...(zoom !== undefined ? { zoom: zoom as DateZoom } : {}) };
    case "edited":
      return { kind: "edited", ...(zoom !== undefined ? { zoom: zoom as DateZoom } : {}) };
    case "property":
      if (typeof candidate.schemaId !== "string" || candidate.schemaId === "") return null;
      return {
        kind: "property",
        schemaId: candidate.schemaId,
        ...(zoom !== undefined ? { zoom: zoom as DateZoom } : {}),
      };
    default:
      return null;
  }
}

/** Stable identity for persistence keys, reset keys, and equality. */
export function groupBySpecKey(spec: GroupBySpec | null): string {
  if (spec === null) return "none";
  switch (spec.kind) {
    case "property":
      return `property:${spec.schemaId}:${spec.zoom ?? ""}`;
    case "created":
    case "edited":
      return `${spec.kind}:${spec.zoom ?? ""}`;
    default:
      return spec.kind;
  }
}

/** The picker button's text for the active axis. */
export function groupBySpecLabel(client: AnyClient, spec: GroupBySpec | null): string {
  if (spec === null) return "None";
  switch (spec.kind) {
    case "page":
      return "Page";
    case "parent":
      return "Parent";
    case "tag":
      return "Tag";
    case "class":
      return "Class";
    case "created":
      return "Created";
    case "edited":
      return "Edited";
    case "property":
      return client.listPropertySchemas().find((s) => s.id === spec.schemaId)?.name ?? "Property";
  }
}

/** One pickable axis (the pseudo-axes + the item set's groupable schemas). */
export interface GroupByAxis {
  spec: GroupBySpec;
  label: string;
  icon: string;
  /** Date-typed: the zoom submenu applies. */
  date: boolean;
}

/**
 * The axes the picker offers: the six pseudo-axes, then every groupable
 * (non-text) property schema CARRIED by the item set (the shells read —
 * cheap, and derived/bound rows count as carried). Schema registry order.
 */
export function groupByAxes(client: AnyClient, items: NodeCollectionItem[]): GroupByAxis[] {
  const carried = new Set<string>();
  for (const item of items) {
    for (const row of client.getPropertyRowShells(item.node.id)) carried.add(row.propertySchemaId);
  }
  const pseudo: GroupByAxis[] = [
    { spec: { kind: "page" }, label: "Page", icon: "mdi-file-document-outline", date: false },
    { spec: { kind: "parent" }, label: "Parent", icon: "mdi-file-tree", date: false },
    { spec: { kind: "tag" }, label: "Tag", icon: "mdi-tag-outline", date: false },
    { spec: { kind: "class" }, label: "Class", icon: "mdi-shape-outline", date: false },
    { spec: { kind: "created" }, label: "Created", icon: "mdi-calendar-plus", date: true },
    { spec: { kind: "edited" }, label: "Edited", icon: "mdi-calendar-edit", date: true },
  ];
  const properties = client
    .listPropertySchemas()
    .filter((schema) => isGroupablePropertyType(schema.type) && carried.has(schema.id))
    .map((schema): GroupByAxis => ({
      spec: { kind: "property", schemaId: schema.id },
      label: schema.name,
      icon: effectivePropertyIcon(schema),
      date: schema.type === "datetime",
    }));
  return [...pseudo, ...properties];
}

/** The ISO week (Thursday rule) of a local ISO day. */
export function isoWeekOf(isoDay: string): { week: number; weekYear: number } {
  const [y, m, d] = isoDay.split("-").map(Number);
  // Noon anchor: DST transitions never shift the calendar day.
  const date = new Date(y!, m! - 1, d!, 12);
  const dayNum = (date.getDay() + 6) % 7; // Monday = 0
  date.setDate(date.getDate() - dayNum + 3); // the week's Thursday
  const weekYear = date.getFullYear();
  const firstThursday = new Date(weekYear, 0, 4, 12);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { week, weekYear };
}

/** The LOCAL calendar day of a UTC ISO timestamp (createdAt/updatedAt). */
export function isoDayLocalOf(timestamp: string | null): string | null {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * The bucket key + display label of a local ISO day at a zoom level. Labels
 * ride the user's date-format setting (formatDateName's compact-digit
 * grammar: day `YYYYMMDD`, month `YYYYMM00`, year `YYYY0000`).
 */
export function zoomBucketOf(isoDay: string, zoom: DateZoom): { key: string; label: string } {
  const compact = isoDay.replace(/-/g, "");
  const year = compact.slice(0, 4);
  switch (zoom) {
    case "year":
      return { key: year, label: formatDateName(`${year}0000`) ?? year };
    case "month":
      return {
        key: compact.slice(0, 6),
        label: formatDateName(`${compact.slice(0, 6)}00`) ?? compact.slice(0, 6),
      };
    case "week": {
      const { week, weekYear } = isoWeekOf(isoDay);
      return { key: `${weekYear}-W${String(week).padStart(2, "0")}`, label: `Week ${week}, ${weekYear}` };
    }
    case "day":
      return { key: compact, label: formatDateName(compact) ?? isoDay };
  }
}

/** The no-value bucket's id (unique across axes via the axis prefix). */
const NONE_KEY = "__none__";

interface Bucket {
  key: string;
  label: string;
  icon?: string | undefined;
  onHeaderClick?: (() => void) | undefined;
  items: NodeCollectionItem[];
}

/**
 * The item's values for a property axis, flattened across rows and array
 * values. LIGHT types (select, boolean, number, datetime) ride the shells
 * read — values present, derived defaults included; HEAVY groupable types
 * (email, node refs) ride the effective read (the shells defer their
 * values). Assigned/bound-but-empty rows contribute nothing. Shared by the
 * group-by engine and the multi-level sort's value resolver.
 */
export function propertyValuesOf(client: AnyClient, nodeId: string, schemaId: string, heavy: boolean): unknown[] {
  const rows = heavy
    ? client.getEffectiveProperties(nodeId).filter((row) => row.propertySchemaId === schemaId)
    : client.getPropertyRowShells(nodeId).filter((row) => row.propertySchemaId === schemaId);
  const values: unknown[] = [];
  for (const row of rows) {
    if ((row as { deferred?: boolean }).deferred === true || row.value === null || row.value === undefined) continue;
    if (Array.isArray(row.value)) values.push(...row.value);
    else values.push(row.value);
  }
  return values;
}

/** The referenced node id of a node-typed value ({ nodeId } or a bare id). */
function nodeRefOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const nodeId = (value as Record<string, unknown>).nodeId;
    if (typeof nodeId === "string") return nodeId;
  }
  return null;
}

/**
 * Derive the groups for a group-by spec over the item set. Every item lands
 * in at least one group (the no-value group catches the rest), so the views
 * render groups alone. `noneLabel` overrides the trailing group's label
 * (the cards board keeps its historical "None" column).
 *
 * Empty groups: by default buckets with no items DROP (owner ruling
 * 2026-11-26 — the section-scoped hub surfaces drowned in dead headers: one
 * open task rendered five 0-count status groups; the vocabulary lives in
 * the Group by picker, not the chrome). `keepEmpty: true` preserves the
 * original law — every select option / boolean arm keeps its group even at
 * 0 — for the surfaces that need the fixed scaffold (the cards board: its
 * empty columns are the drop targets).
 */
export function groupsForSpec(
  client: AnyClient,
  items: NodeCollectionItem[],
  spec: GroupBySpec,
  opts: { noneLabel?: string; keepEmpty?: boolean } = {},
): CollectionGroup[] {
  const buckets: Bucket[] = [];
  const byKey = new Map<string, Bucket>();
  const ensure = (key: string, label: string, icon?: string, onHeaderClick?: () => void): Bucket => {
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const bucket: Bucket = { key, label, icon, onHeaderClick, items: [] };
    byKey.set(key, bucket);
    buckets.push(bucket);
    return bucket;
  };
  const noneLabelOf = (fallback: string): string => opts.noneLabel ?? fallback;

  if (spec.kind === "property") {
    const schema = client.listPropertySchemas().find((s) => s.id === spec.schemaId);
    if (schema === undefined || !isGroupablePropertyType(schema.type)) return [];
    const heavy = schema.type === "email" || schema.type === "object" || schema.type === "asset" || schema.type === "image";
    const valuesOf = (item: NodeCollectionItem): unknown[] => propertyValuesOf(client, item.node.id, schema.id, heavy);
    const multi = schema.multi === true || schema.type === "multi_select";

    if (schema.type === "select" || schema.type === "multi_select") {
      const options = schema.options ?? [];
      const valid = new Set(options.map((option) => option.id));
      // Every option owns its group up front, in the schema's option order
      // (the keepEmpty arms; empty buckets drop at the return unless the
      // surface asked to keep them).
      for (const option of options) ensure(option.id, option.label);
      for (const item of items) {
        const hits = [...new Set(valuesOf(item).filter((value): value is string => typeof value === "string" && valid.has(value)))];
        if (hits.length === 0) ensure(NONE_KEY, noneLabelOf(`No ${schema.name}`)).items.push(item);
        else if (multi) for (const hit of hits) ensure(hit, "").items.push(item);
        else ensure(hits[0]!, "").items.push(item);
      }
    } else if (schema.type === "boolean") {
      ensure("true", "True");
      ensure("false", "False");
      for (const item of items) {
        const value = valuesOf(item).find((entry) => typeof entry === "boolean");
        if (value === true) ensure("true", "").items.push(item);
        else if (value === false) ensure("false", "").items.push(item);
        else ensure(NONE_KEY, noneLabelOf(`No ${schema.name}`)).items.push(item);
      }
    } else if (schema.type === "number" || schema.type === "integer") {
      for (const item of items) {
        const hits = [...new Set(valuesOf(item).filter((value): value is number => typeof value === "number"))];
        if (hits.length === 0) ensure(NONE_KEY, noneLabelOf(`No ${schema.name}`)).items.push(item);
        else for (const hit of hits) ensure(String(hit), String(hit)).items.push(item);
      }
      buckets.sort((a, b) => (a.key === NONE_KEY ? 1 : b.key === NONE_KEY ? -1 : Number(a.key) - Number(b.key)));
    } else if (schema.type === "datetime") {
      const zoom = spec.zoom ?? DEFAULT_DATE_ZOOM;
      for (const item of items) {
        const days = [
          ...new Set(valuesOf(item).map((value) => scheduledIsoOf(value)).filter((day): day is string => day !== null)),
        ];
        if (days.length === 0) ensure(NONE_KEY, noneLabelOf(`No ${schema.name}`)).items.push(item);
        else
          for (const day of days) {
            const bucket = zoomBucketOf(day, zoom);
            ensure(bucket.key, bucket.label).items.push(item);
          }
      }
      buckets.sort((a, b) => (a.key === NONE_KEY ? 1 : b.key === NONE_KEY ? -1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    } else {
      // email (exact value, alphabetical) and the node-reference types
      // (object / asset / image — one group per referenced node).
      const nodeRefs = schema.type !== "email";
      for (const item of items) {
        const hits = [
          ...new Set(
            valuesOf(item)
              .map((value) => (nodeRefs ? nodeRefOf(value) : typeof value === "string" ? value : null))
              .filter((value): value is string => value !== null),
          ),
        ];
        if (hits.length === 0) ensure(NONE_KEY, noneLabelOf(`No ${schema.name}`)).items.push(item);
        else
          for (const hit of hits) {
            if (nodeRefs) {
              const target = client.getNode(hit);
              ensure(
                hit,
                target !== undefined
                  ? (titleOfNode(target, { flatten: "chrome", resolveClassName: (classId) => titleOf(client, classId), resolveMentionName: (targetId) => titleOf(client, targetId) }) ?? "Untitled")
                  : (titleOf(client, hit) ?? "Untitled"),
                target !== undefined ? (client.effectiveNodeIcon(target) ?? undefined) : undefined,
              ).items.push(item);
            } else ensure(hit, hit).items.push(item);
          }
      }
      buckets.sort((a, b) => (a.key === NONE_KEY ? 1 : b.key === NONE_KEY ? -1 : a.label.localeCompare(b.label)));
    }
  } else if (spec.kind === "created" || spec.kind === "edited") {
    const zoom = spec.zoom ?? DEFAULT_DATE_ZOOM;
    for (const item of items) {
      const stamp = spec.kind === "created" ? item.node.createdAt : item.node.updatedAt;
      const day = isoDayLocalOf(stamp);
      if (day === null) ensure(NONE_KEY, noneLabelOf("No date")).items.push(item);
      else {
        const bucket = zoomBucketOf(day, zoom);
        ensure(bucket.key, bucket.label).items.push(item);
      }
    }
    buckets.sort((a, b) => (a.key === NONE_KEY ? 1 : b.key === NONE_KEY ? -1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  } else {
    // The node-reference pseudo-axes: page / parent / tag / class.
    const multi = spec.kind === "tag" || spec.kind === "class";
    const keysOf = (item: NodeCollectionItem): string[] => {
      switch (spec.kind) {
        case "page": {
          const metaPage = item.meta?.containingPageId;
          const pageId = typeof metaPage === "string" ? metaPage : containingPageIdOf(client, item.node.id);
          return pageId !== undefined ? [pageId] : [];
        }
        case "parent":
          return item.node.parentId !== null ? [item.node.parentId] : [];
        case "tag":
          return [...item.node.tagIds];
        case "class":
          return [...item.node.classIds];
      }
    };
    const noneFallback = { page: "No page", parent: "No parent", tag: "No tag", class: "No class" }[spec.kind];
    for (const item of items) {
      const hits = keysOf(item);
      if (hits.length === 0) ensure(NONE_KEY, noneLabelOf(noneFallback)).items.push(item);
      else for (const hit of (multi ? hits : hits.slice(0, 1))) ensure(hit, "").items.push(item);
    }
    // Labels + icons resolve AFTER bucketing (one read per referenced node),
    // then the groups sort alphabetically with the no-value group trailing.
    for (const bucket of buckets) {
      if (bucket.key === NONE_KEY || bucket.label !== "") continue;
      const target = client.getNode(bucket.key);
      bucket.label =
        target !== undefined
          ? (titleOfNode(target, { flatten: "chrome", resolveClassName: (classId) => titleOf(client, classId), resolveMentionName: (targetId) => titleOf(client, targetId) }) ?? "Untitled")
          : (titleOf(client, bucket.key) ?? "Untitled");
      bucket.icon = target !== undefined ? (client.effectiveNodeIcon(target) ?? undefined) : undefined;
    }
    buckets.sort((a, b) => (a.key === NONE_KEY ? 1 : b.key === NONE_KEY ? -1 : a.label.localeCompare(b.label)));
  }

  return (opts.keepEmpty === true ? buckets : buckets.filter((bucket) => bucket.items.length > 0)).map((bucket) => ({
    id: `${spec.kind === "property" ? `prop:${spec.schemaId}` : spec.kind}:${bucket.key}`,
    label: bucket.label,
    icon: bucket.icon,
    onHeaderClick: bucket.onHeaderClick,
    items: bucket.items,
  }));
}
