/**
 * Citekey tracking — the Zotero-parity pin model and the ONE sync engine
 * behind both passive surfaces:
 *
 *  - the OPEN-BACKFILL GUARD (PageView's effect): a source-lineage page
 *    opened without a citekey gets one generated from the workspace pattern
 *    — the pre-tracking library and imports that bypassed the create
 *    form backfill on open, so the "@{{citekey}}" display template and the
 *    hub rows read a real value;
 *  - the CHANGE WATCHER (App's subscription): an UNPINNED citekey re-renders
 *    from the node's current metadata (authors / publicationDate / title —
 *    the dual-track read contract `citekeyEntryOf`) whenever a change lands
 *    on the node, and the value is rewritten the moment the render drifts
 *    from what is stored.
 *
 * The PIN model: pinning freezes a citekey against auto-rewrites (the
 * Zotero/BBT pinned-key semantics). The flag rides the EXISTING per-value
 * `metadata` record on the citekey's property value (the SCHEMA.md
 * "any other keys ride as authored" contract — no new op, no fixture gate):
 * `metadata: { pinned: true }` on the authored value row. Absent (or not
 * `true`) = unpinned, the default — backfilled and auto-generated keys
 * start unpinned, so they track. A manual panel edit pins automatically
 * (a hand-typed key is a deliberate choice, the BBT precedent) — see
 * TextPropertyRow's edit paths.
 *
 * The engine's gates, in order (every gate is a cheap read; the library
 * walk happens only for source-lineage nodes):
 *  1. class nodes never carry a tracked citekey (a class is schema, not a
 *     library entry);
 *  2. the node's class LINEAGE must reach `source` (the quick-create
 *     keying, never a hardcoded node set);
 *  3. the Sources FEATURE is on (an absent row or explicit enabled:false —
 *     the family toggle — is the ONLY off switch; generation has no toggle
 *     of its own, the owner ruling 2026-10-29: the opt-out is pinning or a
 *     hand-edit, never a default-off switch);
 *  4. a PINNED citekey is never touched;
 *  5. the pattern render from current metadata (collision-suffixed against
 *     the live library minus the node's own keys, the
 *     `citekeyRegenerationFor` contract) — an EMPTY render (no authors/
 *     family, no title, no date) is not an error: nothing writes;
 *  6. the render EQUALS the current value → nothing writes (idempotent —
 *     re-runs, re-opens, and the watcher's own write settling here).
 *
 * The write rides the ordinary `property.set` (single-value slot, idx 0,
 * scalar string — the shape generated citekeys always had), so it undoes
 * like one and syncs like one. When the replaced value was a node-backed
 * carrier (the manual-edit shape), the orphaned carrier is trashed — it
 * held the old key text and nothing references it after the replace.
 */

import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { AnyClient } from "../collection/types.js";
import { isCitationFamilyClass, readSourceSettings } from "../modals/quickCreate.js";
import { citekeyRegenerationFor } from "./citekeyRegenerate.js";
import { citekeyTextOf } from "./citekeyValue.js";

/** The reserved per-value metadata key marking a citekey pinned. */
export const CITEKEY_PINNED_METADATA_KEY = "pinned";

/** The pin-write metadata: pin flips ride a value rewrite (LWW at the row). */
export function citekeyPinMetadata(pinned: boolean): Record<string, unknown> {
  return { [CITEKEY_PINNED_METADATA_KEY]: pinned };
}

/**
 * The pinned read: true when ANY effective citekey row's authored metadata
 * pins it. Only `true` pins — an explicit `false` (the unpin write) or
 * absent metadata reads unpinned.
 */
export function citekeyIsPinned(
  rows: ReadonlyArray<{ propertySchemaId: string; metadata: Record<string, unknown> | null }>,
): boolean {
  return rows.some(
    (row) =>
      row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey &&
      row.metadata?.[CITEKEY_PINNED_METADATA_KEY] === true,
  );
}

/**
 * The sync engine — one recompute-and-mend pass over ONE node. Callers:
 * PageView's open guard (per opened page) and App's change watcher (per
 * affected node). Returns true when it WROTE; every early-out is a no-op
 * read. Never throws for ordinary absence — a vanished node/schema reads
 * as nothing-to-do.
 */
export async function syncSourceCitekey(client: AnyClient, nodeId: string): Promise<boolean> {
  const node = client.getNode(nodeId);
  if (node === undefined || node.isClass) return false;
  if (node.classIds.length === 0) return false;
  if (!node.classIds.some((classId) => isCitationFamilyClass(client, classId))) return false;
  if (!readSourceSettings(client).sourcesEnabled) return false;

  const citekeyRows = client
    .getEffectiveProperties(nodeId)
    .filter((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey);
  if (citekeyIsPinned(citekeyRows)) return false;

  const currentRow = citekeyRows.find(
    (row) => citekeyTextOf(client, row.value) !== "",
  );
  const current = currentRow === undefined ? "" : citekeyTextOf(client, currentRow.value);

  const generated = citekeyRegenerationFor(client, node).value;
  if (generated === "" || generated === current) return false;

  // The manual-edit carrier an auto-rewrite replaces is orphaned by the
  // scalar write — trash it (restorable, undo-eligible, like any block).
  const replacedState =
    currentRow === undefined
      ? { kind: "scalar" as const }
      : (() => {
          const raw =
            typeof currentRow.value === "object" &&
            currentRow.value !== null &&
            "nodeId" in (currentRow.value as Record<string, unknown>)
              ? String((currentRow.value as { nodeId: unknown }).nodeId ?? "")
              : null;
          return raw === null ? ({ kind: "scalar" as const }) : ({ kind: "carrier" as const, id: raw });
        })();

  await client.setProperty(nodeId, SYSTEM_PROPERTY_UUIDS.citekey, generated, 0);
  if (replacedState.kind === "carrier" && client.getNode(replacedState.id) !== undefined) {
    await client.deleteObject(replacedState.id);
  }
  return true;
}
