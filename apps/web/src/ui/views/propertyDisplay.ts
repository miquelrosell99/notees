/**
 * Property value display helpers shared by the table and cards views:
 * the read-only text projection of an EffectiveProperty, per value shape
 * (select ids → option labels via the schema registry, node-typed values →
 * the target's display name, multi values joined).
 */

import type { AnyClient } from "./types.js";
import type { EffectiveProperty } from "@/core/workspace-client.js";
import { displayNameFromClient } from "../dateDisplay.js";

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

function nodeRefText(client: AnyClient, value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const nodeId = (value as { nodeId?: unknown }).nodeId;
  if (typeof nodeId !== "string") return "";
  return displayNameFromClient(client, nodeId) ?? nodeId;
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
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        isSelectionType(prop.schema?.type)
          ? optionLabel(client, prop.propertySchemaId, entry)
          : nodeRefText(client, entry),
      )
      .filter((text) => text !== "")
      .join(", ");
  }
  if (isSelectionType(prop.schema?.type)) return optionLabel(client, prop.propertySchemaId, value);
  if (prop.schema?.type === "boolean") return value === true ? "Yes" : "No";
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { nodeId?: unknown }).nodeId === "string"
  ) {
    return nodeRefText(client, value);
  }
  if (typeof value === "number") return formatNumberValue(value, prop.schema);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The external navigation target of a url/email value (§34.32 PG14): url
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
