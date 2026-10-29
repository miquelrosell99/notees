/**
 * The citekey value's text in EITHER storage shape — the scalar string the
 * create form / regenerate / auto-write paths author, or the node-backed
 * carrier a manual panel edit mints (its content flattened; a dead ref reads
 * ""). The collision scans (`existingCitekeys`), the duplicate warning
 * (`findSourceByIdentifier`), the regeneration's own-key exclusion, and the
 * auto-track engine's drift compare ALL read through this one contract, so a
 * manually typed (carrier-shaped) citekey participates everywhere a
 * generated (scalar) one does. A dead carrier ref contributes "" — the row
 * reads empty, never as raw uuid text.
 */

import { plainTextExcerpt } from "@notees/domain";

import type { AnyClient } from "../collection/types.js";
import { carrierStateOf } from "../metadata/carrierState.js";

/** The citekey's current text ("" when absent, dead, or whitespace-only). */
export function citekeyTextOf(client: AnyClient, value: unknown): string {
  const state = carrierStateOf(client, value);
  if (state.kind === "carrier") {
    const node = client.getNode(state.id);
    return node === undefined ? "" : plainTextExcerpt(node.contentAst).trim();
  }
  if (state.kind === "dead") return "";
  return typeof value === "string" ? value.trim() : "";
}
