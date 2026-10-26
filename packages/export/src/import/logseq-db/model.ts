/**
 * Logseq DB entity model — decoded kvs entities resolved into the canonical
 * import model: user class/property definitions, content nodes with resolved
 * parents/orders/class titles/typed property values, journal days indexed by
 * uuid, and the skip classification ($$views subtrees, Logseq system idents,
 * asset metadata — counted for the report, never written).
 */

import { attrValues, type LqEntity } from "./decode.js";

export type LqPropValue =
  | { kind: "node"; uuid: string }
  | { kind: "date"; day: string }
  | { kind: "text"; text: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean };

export interface LqNodeProp {
  /** The Logseq property ident, e.g. ":user.property/autor-bbbb". */
  ident: string;
  title: string;
  values: LqPropValue[];
}

export interface LqNode {
  uuid: string;
  title: string | null;
  name: string | null;
  parentUuid: string | null;
  pageUuid: string | null;
  order: string | null;
  /** Resolved tag (class) titles. */
  classTitles: string[];
  journalDay: string | null;
  props: LqNodeProp[];
}

export interface LqClassDef {
  uuid: string;
  title: string;
  logseqIdent: string;
}

export interface LqPropDef {
  ident: string;
  title: string;
  valueType: string | null;
  cardinalityMany: boolean;
}

export interface LogseqDbSkipped {
  views: number;
  system: number;
  assets: number;
  /** Select-option backing entities (`:block/closed-value-property`) — counted, never imported as pages. */
  closedValues: number;
}

export interface LogseqDbModel {
  nodes: LqNode[];
  classes: LqClassDef[];
  properties: LqPropDef[];
  /** Journal-day uuid → YYYYMMDD. */
  dateByUuid: Map<string, string>;
  skipped: LogseqDbSkipped;
}

const USER_CLASS_PREFIX = ":user.class/";
const USER_PROP_PREFIX = ":user.property/";
const LOGSEQ_CLASS_PREFIX = ":logseq.class/";
const LOGSEQ_PROP_PREFIX = ":logseq.property/";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function buildLogseqDbModel(entities: Map<number, LqEntity>): LogseqDbModel {
  const titleOf = (eid: number): string | null => {
    const o = entities.get(eid);
    return o ? asString(o[":block/title"]) ?? asString(o[":block/name"]) : null;
  };
  const uuidOf = (eid: number): string | null => {
    const o = entities.get(eid);
    const u = o?.[":block/uuid"];
    return typeof u === "string" ? u : null;
  };
  const parentEid = (o: LqEntity): number | null => {
    const p = o[":block/parent"];
    return typeof p === "number" ? p : null;
  };

  const model: LogseqDbModel = {
    nodes: [],
    classes: [],
    properties: [],
    dateByUuid: new Map(),
    skipped: { views: 0, system: 0, assets: 0, closedValues: 0 },
  };

  // --- definitions -------------------------------------------------------
  const propDefByIdent = new Map<string, LqPropDef>();
  for (const o of entities.values()) {
    const ident = asString(o[":db/ident"]);
    if (!ident) continue;
    if (ident.startsWith(USER_PROP_PREFIX)) {
      const def: LqPropDef = {
        ident,
        title: asString(o[":block/title"]) ?? ident,
        valueType: asString(o[":logseq.property/type"]),
        cardinalityMany: o[":db/cardinality"] === ":db.cardinality/many",
      };
      model.properties.push(def);
      propDefByIdent.set(ident, def);
    } else if (ident.startsWith(USER_CLASS_PREFIX)) {
      const uuid = asString(o[":block/uuid"]);
      if (uuid) {
        model.classes.push({
          uuid,
          title: asString(o[":block/title"]) ?? ident,
          logseqIdent: ident,
        });
      }
    } else if (ident.startsWith(LOGSEQ_CLASS_PREFIX) || ident.startsWith(LOGSEQ_PROP_PREFIX)) {
      model.skipped.system += 1;
    }
  }

  // --- journal days ------------------------------------------------------
  const journalEids = new Set<number>();
  for (const [eid, o] of entities) {
    const day = o[":block/journal-day"];
    if (day === undefined) continue;
    journalEids.add(eid);
    const uuid = asString(o[":block/uuid"]);
    if (uuid) model.dateByUuid.set(uuid, String(day));
  }

  // --- assets ------------------------------------------------------------
  const assetEids = new Set<number>();
  for (const [eid, o] of entities) {
    if (":logseq.property.asset/checksum" in o || ":logseq.property.asset/type" in o) {
      assetEids.add(eid);
      model.skipped.assets += 1;
    }
  }

  // --- closed values -------------------------------------------------------
  // Select-option backing entities (`:block/closed-value-property`)
  // are vocabulary, not content: counted for the report, never imported as
  // pages. Property-value resolution still reads their titles from the
  // entities map below (resolvePropValue → titleOf), independent of the
  // node classification.
  const closedValueEids = new Set<number>();
  for (const [eid, o] of entities) {
    if (":block/closed-value-property" in o) {
      closedValueEids.add(eid);
      model.skipped.closedValues += 1;
    }
  }

  // --- $$$views subtrees --------------------------------------------------
  const inViews = new Set<number>();
  const ancestorChain = (eid: number): number[] => {
    const chain: number[] = [];
    let cur = parentEid(entities.get(eid) ?? {});
    const guard = new Set<number>([eid]);
    while (cur !== null && !guard.has(cur)) {
      guard.add(cur);
      chain.push(cur);
      cur = parentEid(entities.get(cur) ?? {});
    }
    return chain;
  };
  for (const [eid, o] of entities) {
    if (asString(o[":block/title"]) === "$$$views") inViews.add(eid);
  }
  for (const [eid] of entities) {
    if (inViews.has(eid)) continue;
    if (ancestorChain(eid).some((a) => inViews.has(a))) inViews.add(eid);
  }
  model.skipped.views = inViews.size;

  // --- nodes ---------------------------------------------------------------
  const resolvePropValue = (ident: string, raw: unknown): LqPropValue => {
    const def = propDefByIdent.get(ident);
    const valueType = def?.valueType ?? null;
    if (valueType === ":node") {
      const uuid = typeof raw === "number" ? uuidOf(raw) : null;
      return uuid ? { kind: "node", uuid } : { kind: "text", text: String(raw) };
    }
    if (valueType === ":date") {
      const target = typeof raw === "number" ? entities.get(raw) : undefined;
      const day = target?.[":block/journal-day"];
      return day !== undefined
        ? { kind: "date", day: String(day) }
        : { kind: "text", text: String(raw) };
    }
    // Checkbox stores booleans; a defensive string form normalizes (real
    // exports carry booleans, but never guess wrong on the string shape).
    if (valueType === ":checkbox" && (raw === "true" || raw === "false")) {
      return { kind: "boolean", value: raw === "true" };
    }
    if (typeof raw === "boolean") return { kind: "boolean", value: raw };
    if (valueType === ":number" && typeof raw === "number") {
      return { kind: "number", value: raw };
    }
    if (typeof raw === "string") return { kind: "text", text: raw };
    // Closed values and other entity refs: resolve to the target's title.
    if (typeof raw === "number") {
      const title = titleOf(raw);
      if (title !== null) return { kind: "text", text: title };
      return { kind: "number", value: raw };
    }
    return { kind: "text", text: String(raw) };
  };

  for (const [eid, o] of entities) {
    const uuid = asString(o[":block/uuid"]);
    if (!uuid) continue;
    if (journalEids.has(eid) || assetEids.has(eid) || closedValueEids.has(eid) || inViews.has(eid)) {
      continue;
    }
    const ident = asString(o[":db/ident"]);
    if (
      ident &&
      (ident.startsWith(USER_PROP_PREFIX) ||
        ident.startsWith(USER_CLASS_PREFIX) ||
        ident.startsWith(LOGSEQ_CLASS_PREFIX) ||
        ident.startsWith(LOGSEQ_PROP_PREFIX))
    ) {
      // definitions and logseq system entities are never importable nodes
      // (system ones were counted in skipped.system above)
      continue;
    }

    const classTitles: string[] = [];
    for (const t of attrValues(o[":block/tags"])) {
      if (typeof t !== "number") continue;
      const title = titleOf(t);
      if (title !== null) classTitles.push(title);
    }

    const props: LqNodeProp[] = [];
    for (const [attr, value] of Object.entries(o)) {
      if (!attr.startsWith(USER_PROP_PREFIX)) continue;
      const def = propDefByIdent.get(attr);
      props.push({
        ident: attr,
        title: def?.title ?? attr,
        values: attrValues(value).map((v) => resolvePropValue(attr, v)),
      });
    }

    const parentUuid =
      typeof o[":block/parent"] === "number" ? uuidOf(o[":block/parent"] as number) : null;
    const pageUuid =
      typeof o[":block/page"] === "number" ? uuidOf(o[":block/page"] as number) : null;

    model.nodes.push({
      uuid,
      title: asString(o[":block/title"]),
      name: asString(o[":block/name"]),
      parentUuid,
      pageUuid,
      order: asString(o[":block/order"]),
      classTitles,
      journalDay: null,
      props,
    });
  }

  return model;
}
