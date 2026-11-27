/**
 * The reading tracker (proposal 2026-11-26, Phase 1) — the feature's data
 * seed and the shared vocabulary it syncs through.
 *
 * Four user-extensible properties, created ONCE when the Sources settings
 * toggle flips on (`ensureReadingTracker`, idempotent — presence-guarded per
 * schema), scoped to the source family and bound on `source` so every one of
 * the 39 type-classes inherits them. The schema ids are FIXED across
 * workspaces (the task-family reserved-id precedent): the tracker is a
 * fleet feature, and stable ids let every surface (hub, detail, CLI, the
 * kosync mirror) address the vocabulary without a name lookup.
 *
 * The semantics (the owner's design, validated by the Phase-0 dogfood in
 * Notas):
 *
 *  - `Estado` (select, shown in node rows) — Pendiente / Leyendo /
 *    Consumido / Abandonado: the lifecycle, exclusive by construction.
 *    Consumido means FINISHED, always; an abandon never wears the done badge.
 *  - `Primera lectura` (datetime, day) — set on the first completion, then
 *    NEVER overwritten (fill-once forever): ever-read can never be erased.
 *  - `Última lectura` (datetime, day) — set on every completion (LWW): the
 *    recency fact.
 *  - `Abandonado el` (datetime, day) — set on abandon, CLEARED on resume: a
 *    mirror of the state, never a stale date on a finished book.
 *
 * The `readingTracker` sources-settings key gates the UI affordances; the
 * properties themselves survive a toggle-off (the family-toggle precedent —
 * visibility, never absence).
 */

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";

/** The tracker's stable schema ids (reserved for the feature; never minted). */
export const READING_TRACKER = {
  estado: "0bedf00d-0000-4000-8000-000000000001",
  options: {
    pendiente: "0bedf00d-0000-4000-8000-000000000010",
    leyendo: "0bedf00d-0000-4000-8000-000000000011",
    consumido: "0bedf00d-0000-4000-8000-000000000012",
    abandonado: "0bedf00d-0000-4000-8000-000000000013",
  },
  primeraLectura: "0bedf00d-0000-4000-8000-000000000002",
  ultimaLectura: "0bedf00d-0000-4000-8000-000000000003",
  abandonadoEl: "0bedf00d-0000-4000-8000-000000000004",
} as const;

export function readingTrackerEnabled(client: AnyClient): boolean {
  const row = client.listFeatureRows().find((entry) => entry.feature === "sources");
  return row?.settings?.readingTracker === true;
}

/**
 * Idempotent seed: create the four schemas (presence-guarded), scope them to
 * the source family, bind them on `source` (inherits down the extends chain),
 * and flag `Estado` for the node-row preview. Safe to call on every enable —
 * and by any other surface that wants the vocabulary present.
 */
export async function ensureReadingTracker(client: AnyClient): Promise<void> {
  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  const existing = new Set(client.listPropertySchemas().map((schema) => schema.id));

  if (!existing.has(READING_TRACKER.estado)) {
    await client.createPropertySchema({
      id: READING_TRACKER.estado,
      name: "Estado",
      type: "select",
      scopeClassIds: [SOURCE],
      options: [
        { id: READING_TRACKER.options.pendiente, label: "Pendiente" },
        { id: READING_TRACKER.options.leyendo, label: "Leyendo" },
        { id: READING_TRACKER.options.consumido, label: "Consumido" },
        { id: READING_TRACKER.options.abandonado, label: "Abandonado" },
      ],
    });
  }
  const dates: Array<{ id: string; name: string }> = [
    { id: READING_TRACKER.primeraLectura, name: "Primera lectura" },
    { id: READING_TRACKER.ultimaLectura, name: "Última lectura" },
    { id: READING_TRACKER.abandonadoEl, name: "Abandonado el" },
  ];
  for (const schema of dates) {
    if (existing.has(schema.id)) continue;
    await client.createPropertySchema({
      id: schema.id,
      name: schema.name,
      type: "datetime",
      datePrecision: "day",
      scopeClassIds: [SOURCE],
    });
  }
  for (const schemaId of [
    READING_TRACKER.estado,
    READING_TRACKER.primeraLectura,
    READING_TRACKER.ultimaLectura,
    READING_TRACKER.abandonadoEl,
  ]) {
    await client.setClassProperty(SOURCE, schemaId, {
      ...(schemaId === READING_TRACKER.estado ? { showInNodeRows: true } : {}),
    });
  }
}

export type ReadingState = "pendiente" | "leyendo" | "consumido" | "abandonado";

/**
 * One write path for the reading-state gestures (detail pane, future hub
 * affordances): the Estado option LWW, the dates per their semantics
 * (primera fill-once, última overwrite, abandonado-el mirror), all through
 * the client's ordinary property writes so each undoes like one.
 */
export async function setReadingState(
  client: AnyClient,
  nodeId: string,
  state: ReadingState,
): Promise<void> {
  const held = new Set(
    client
      .getEffectiveProperties(nodeId)
      .filter((row) => row.source === "authored" && row.value !== null && row.value !== undefined && row.value !== "")
      .map((row) => row.propertySchemaId),
  );
  await client.setProperty(nodeId, READING_TRACKER.estado, READING_TRACKER.options[state], 0);
  if (state === "pendiente") {
    // Leaving the lifecycle: only the abandon mirror clears; the read dates
    // are completion facts and survive (a pendiente re-queue keeps history).
    if (held.has(READING_TRACKER.abandonadoEl)) await client.unsetProperty(nodeId, READING_TRACKER.abandonadoEl, 0);
    return;
  }
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await client.ensureDateChain(iso);
  if (state === "leyendo") {
    if (held.has(READING_TRACKER.abandonadoEl)) await client.unsetProperty(nodeId, READING_TRACKER.abandonadoEl, 0);
    return;
  }
  // consumido | abandonado: the date rides the day chain.
  const schema = state === "consumido" ? READING_TRACKER.ultimaLectura : READING_TRACKER.abandonadoEl;
  await client.setDatetimeProperty(nodeId, schema, { iso });
  if (state === "consumido" && !held.has(READING_TRACKER.primeraLectura)) {
    await client.setDatetimeProperty(nodeId, READING_TRACKER.primeraLectura, { iso });
  }
}

/** The node's current state (the Estado option id → key), or null when unset. */
export function readingStateOf(
  client: AnyClient,
  nodeId: string,
): ReadingState | null {
  const row = client
    .getEffectiveProperties(nodeId)
    .find((entry) => entry.propertySchemaId === READING_TRACKER.estado && entry.source === "authored");
  const value = row?.value;
  if (typeof value !== "string") return null;
  for (const [state, id] of Object.entries(READING_TRACKER.options)) {
    if (value === id) return state as ReadingState;
  }
  return null;
}
