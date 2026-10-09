/**
 * Property value display helpers shared by the table and cards views:
 * the read-only text projection of an EffectiveProperty, per value shape
 * (select ids → option labels via the schema registry, node-typed values →
 * the target's display name, multi values joined).
 */

import type { AnyClient } from "./types.js";
import type { EffectiveProperty } from "@/core/workspace-client.js";
import { displayNameFromClient, datetimeValueText } from "../dateDisplay.js";

export function isEmptyPropertyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function optionLabel(client: AnyClient, schemaId: string, optionId: unknown): string {
  if (typeof optionId !== "string") return String(optionId);
  const schema = client.listPropertySchemas().find((s) => s.id === schemaId);
  const option = schema?.options?.find((o) => o.id === optionId);
  return option?.label ?? optionId;
}

function isSelectionType(type: string | undefined): boolean {
  return type === "select" || type === "multi_select";
}

/** Node-typed schemas (datetime/object/asset): values are node refs — canonical
 *  `{ nodeId }` objects or, on v1-migrated data, BARE uuid strings (SCHEMA.md
 *  PB2 read-leniency: legacy encodings ride the log and every display reads
 *  them as refs). Scalar-typed schemas never take this path. */
const NODE_TYPED_SCHEMAS = new Set(["datetime", "object", "asset"]);

function nodeRefText(client: AnyClient, value: unknown): string {
  // Accepts both the canonical { nodeId } ref and the legacy bare-uuid
  // string; an unrecognized shape answers "" (callers fall back honestly).
  const nodeId =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? (value as { nodeId?: unknown }).nodeId
        : undefined;
  if (typeof nodeId !== "string") return "";
  return displayNameFromClient(client, nodeId) ?? nodeId;
}

/** datetime range display: `start → end`, either side open → `…`; refs resolve
 *  like the scalar node-typed branches (bare-string leniency included).
 *  Null when the value is not range-shaped. */
function dateRangeText(client: AnyClient, value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const range = value as { start?: unknown; end?: unknown };
  if (!("start" in range) && !("end" in range)) return null;
  const side = (end: unknown): string => {
    const ref =
      typeof end === "string"
        ? end
        : typeof end === "object" && end !== null
          ? (end as { nodeId?: unknown }).nodeId
          : null;
    if (typeof ref !== "string") return "…";
    return displayNameFromClient(client, ref) ?? ref;
  };
  return `${side(range.start)} → ${side(range.end)}`;
}

/**
 * SCHEMA.md "Number formats": display-only formatting for number values.
 * Values stay exact in the log — this shapes render only. `numberDecimals`
 * cuts the fraction with `numberRounding` (default "round" = half away from
 * zero, per Intl's default); `numberPad` zero-pads the integer part to N
 * digits ("0001"). Anything non-finite or non-numeric passes through.
 */
export function formatNumberValue(
  value: number,
  schema:
    | { numberPad?: number | null; numberDecimals?: number | null; numberRounding?: string | null }
    | null
    | undefined,
): string {
  if (schema === undefined || schema === null) return String(value);
  let v = value;
  if (schema.numberDecimals !== null && schema.numberDecimals !== undefined) {
    const factor = 10 ** schema.numberDecimals;
    const rounding = schema.numberRounding ?? "round";
    const scaled =
      rounding === "floor"
        ? Math.floor(v * factor)
        : rounding === "ceil"
          ? Math.ceil(v * factor)
          : rounding === "truncate"
            ? Math.trunc(v * factor)
            : Math.round(v * factor);
    v = scaled / factor;
  }
  let text = String(v);
  if (schema.numberPad !== null && schema.numberPad !== undefined) {
    const [intPart = "", fracPart] = text.split(".");
    const sign = intPart.startsWith("-") ? "-" : "";
    const digits = sign ? intPart.slice(1) : intPart;
    const padded = digits.padStart(schema.numberPad, "0");
    text = sign + padded + (fracPart !== undefined ? `.${fracPart}` : "");
  }
  return text;
}

/** The plain-text display of one property value ("" when unset). */
export function propertyDisplayText(client: AnyClient, prop: EffectiveProperty | undefined): string {
  if (prop === undefined || isEmptyPropertyValue(prop.value)) return "";
  const value = prop.value;
  const schemaType = prop.schema?.type;
  const nodeTyped = schemaType !== undefined && NODE_TYPED_SCHEMAS.has(schemaType);
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (isSelectionType(schemaType)) return optionLabel(client, prop.propertySchemaId, entry);
        if (typeof entry === "boolean") return entry ? "☑" : "☐";
        return nodeRefText(client, entry);
      })
      .filter((text) => text !== "")
      .join(", ");
  }
  if (isSelectionType(schemaType)) return optionLabel(client, prop.propertySchemaId, value);
  if (schemaType === "boolean") return value === true ? "☑" : "☐";
  if (schemaType === "datetime") {
    // The unified union rides the slot formatter (point `label HH:MM`,
    // range `start → end` with `…` for open sides).
    const text = datetimeValueText(value);
    if (text !== null) return text;
  }
  const range = dateRangeText(client, value);
  if (range !== null) return range;
  // A canonical { nodeId } ref resolves unconditionally (any schema shape);
  // a bare string resolves on node-typed schemas (legacy v1 encoding).
  if (typeof value === "object" && value !== null) {
    const resolved = nodeRefText(client, value);
    return resolved !== "" ? resolved : (JSON.stringify(value) ?? "");
  }
  if (nodeTyped && typeof value === "string") return nodeRefText(client, value);
  if (typeof value === "number") return formatNumberValue(value, prop.schema);
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

/**
 * The external navigation target of a url/email value: url
 * values pass through (http(s), protocol-relative, or any scheme the author
 * wrote — a `tel:` value rides the same href), email values become
 * `mailto:`. Null when the value is not a non-empty string — nothing to
 * link.
 */
export function propertyLinkHref(type: string | undefined, value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (type === "url") return value.trim();
  if (type === "email") return `mailto:${value.trim()}`;
  return null;
}
