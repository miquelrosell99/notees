/**
 * sorting — the multi-level sort model (2026-11-25): ONE sort vocabulary
 * for the outline and cards views (the table's column-keyed multi-sort is
 * the same ruling over its columns). A sort is an ordered list of
 * SortFieldSpecs — each level a FIELD (name, created, edited, page, parent,
 * or any non-text property) with a direction; levels apply in priority
 * order (first priority, then scheduled date, then page, …). Select
 * properties sort by their OPTION INDEX (the schema's option order — a
 * Priority desc reads Urgent first), datetimes by the value's day, numbers
 * numerically, node references by the target's title; empty values sink
 * LAST at every level (the table's contract). The comparator is stable:
 * rows equal on every level keep their container order.
 */

import { titleOf, titleOfNode } from "../../ui/dateDisplay.js";
import { containingPageIdOf } from "./sectionViewResolve.js";
import { scheduledIsoOf } from "../calendar/calendarViewUtils.js";
import { effectivePropertyIcon } from "../metadata/propertyIcon.js";
import { isGroupablePropertyType, propertyValuesOf } from "./grouping.js";
import type { AnyClient, NodeCollectionItem } from "./types.js";

export type SortDirection = "asc" | "desc";

export type SortField =
  | { kind: "name" }
  | { kind: "created" }
  | { kind: "edited" }
  | { kind: "page" }
  | { kind: "parent" }
  | { kind: "property"; schemaId: string };

export interface SortFieldSpec {
  field: SortField;
  direction: SortDirection;
}

/** Stable identity for keys and equality. */
export function sortFieldKey(field: SortField): string {
  return field.kind === "property" ? `property:${field.schemaId}` : field.kind;
}

/** The panel's label for a field. */
export function sortFieldLabel(client: AnyClient, field: SortField): string {
  switch (field.kind) {
    case "name":
      return "Name";
    case "created":
      return "Created";
    case "edited":
      return "Edited";
    case "page":
      return "Page";
    case "parent":
      return "Parent";
    case "property":
      return client.listPropertySchemas().find((s) => s.id === field.schemaId)?.name ?? "Property";
  }
}

/** One pickable sort field (the panel's add row). */
export interface SortFieldOption {
  field: SortField;
  label: string;
  icon: string;
}

/**
 * The fields the sort panel offers: Name + the structural fields (page /
 * parent / created / edited), then every non-text property schema CARRIED
 * by the item set (the shells read — the group-by axes' carried rule).
 */
export function availableSortFields(client: AnyClient, items: NodeCollectionItem[]): SortFieldOption[] {
  const carried = new Set<string>();
  for (const item of items) {
    for (const row of client.getPropertyRowShells(item.node.id)) carried.add(row.propertySchemaId);
  }
  const pseudo: SortFieldOption[] = [
    { field: { kind: "name" }, label: "Name", icon: "mdi-format-text" },
    { field: { kind: "page" }, label: "Page", icon: "mdi-file-document-outline" },
    { field: { kind: "parent" }, label: "Parent", icon: "mdi-file-tree" },
    { field: { kind: "created" }, label: "Created", icon: "mdi-calendar-plus" },
    { field: { kind: "edited" }, label: "Edited", icon: "mdi-calendar-edit" },
  ];
  const properties = client
    .listPropertySchemas()
    .filter((schema) => isGroupablePropertyType(schema.type) && carried.has(schema.id))
    .map((schema): SortFieldOption => ({
      field: { kind: "property", schemaId: schema.id },
      label: schema.name,
      icon: effectivePropertyIcon(schema),
    }));
  return [...pseudo, ...properties];
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
 * The comparable value of one field for one item (null = empty — sinks
 * last). Selects resolve to the option's INDEX in the schema's option
 * order; datetimes to the value's day (ISO — lexicographic IS
 * chronological); node references to the target's title.
 */
export function sortValueOf(client: AnyClient, item: NodeCollectionItem, field: SortField): string | number | null {
  const node = item.node;
  switch (field.kind) {
    case "name":
      return titleOf(client, node.id, { flatten: "chrome" }) ?? null;
    case "created":
      return node.createdAt ?? null;
    case "edited":
      return node.updatedAt ?? null;
    case "page": {
      const metaPage = item.meta?.containingPageId;
      const pageId = typeof metaPage === "string" ? metaPage : containingPageIdOf(client, node.id);
      return pageId !== undefined ? (titleOf(client, pageId, { flatten: "chrome" }) ?? null) : null;
    }
    case "parent":
      return node.parentId !== null ? (titleOf(client, node.parentId, { flatten: "chrome" }) ?? null) : null;
    case "property": {
      const schema = client.listPropertySchemas().find((s) => s.id === field.schemaId);
      if (schema === undefined || !isGroupablePropertyType(schema.type)) return null;
      const heavy = schema.type === "email" || schema.type === "object" || schema.type === "asset" || schema.type === "image";
      const values = propertyValuesOf(client, node.id, schema.id, heavy);
      if (schema.type === "select" || schema.type === "multi_select") {
        const options = schema.options ?? [];
        for (const value of values) {
          if (typeof value !== "string") continue;
          const index = options.findIndex((option) => option.id === value);
          if (index !== -1) return index;
        }
        return null;
      }
      if (schema.type === "number" || schema.type === "integer") {
        const value = values.find((entry) => typeof entry === "number");
        return typeof value === "number" ? value : null;
      }
      if (schema.type === "boolean") {
        const value = values.find((entry) => typeof entry === "boolean");
        return value === undefined ? null : value ? 1 : 0;
      }
      if (schema.type === "datetime") {
        for (const value of values) {
          const day = scheduledIsoOf(value);
          if (day !== null) return day;
        }
        return null;
      }
      if (schema.type === "email") {
        const value = values.find((entry) => typeof entry === "string");
        return typeof value === "string" ? value : null;
      }
      // Node references (object / asset / image): the target's title.
      for (const value of values) {
        const ref = nodeRefOf(value);
        if (ref !== null) {
          const target = client.getNode(ref);
          return target !== undefined
            ? (titleOfNode(target, { flatten: "chrome", resolveClassName: (classId) => titleOf(client, classId), resolveMentionName: (targetId) => titleOf(client, targetId) }) ?? null)
            : (titleOf(client, ref, { flatten: "chrome" }) ?? null);
        }
      }
      return null;
    }
  }
}

/**
 * The stable multi-level comparator: each level compares in turn (empty
 * values sink last regardless of direction — the table's contract);
 * numbers compare numerically, everything else case-insensitively with
 * numeric collation. Rows equal on every level keep their container order.
 */
export function compareBySortSpecs(
  client: AnyClient,
  specs: readonly SortFieldSpec[],
  a: NodeCollectionItem,
  b: NodeCollectionItem,
): number {
  for (const spec of specs) {
    const valueA = sortValueOf(client, a, spec.field);
    const valueB = sortValueOf(client, b, spec.field);
    const emptyA = valueA === null || valueA === "";
    const emptyB = valueB === null || valueB === "";
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    if (emptyA && emptyB) continue;
    const direction = spec.direction === "asc" ? 1 : -1;
    if (typeof valueA === "number" && typeof valueB === "number") {
      if (valueA !== valueB) return (valueA - valueB) * direction;
      continue;
    }
    const compared = String(valueA).localeCompare(String(valueB), undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (compared !== 0) return compared * direction;
  }
  return 0;
}

/** Sort every sibling level of a tree by the specs (the outline's tree path). */
export function sortTreeBySpecs(
  client: AnyClient,
  items: NodeCollectionItem[],
  specs: readonly SortFieldSpec[],
): NodeCollectionItem[] {
  return [...items]
    .sort((a, b) => compareBySortSpecs(client, specs, a, b))
    .map((item) => ({
      ...item,
      children: item.children !== undefined ? sortTreeBySpecs(client, item.children, specs) : item.children,
    }));
}
