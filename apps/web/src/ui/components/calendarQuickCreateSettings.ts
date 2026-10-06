/**
 * Calendar quick-create chips — per-workspace device-local configuration.
 *
 * There is no server-side workspace-settings store in this build: every
 * workspace setting is device-local under `notees.settings.*`
 * (deviceSettings.ts). "Per workspace" therefore means a setting key keyed
 * by workspace id — `calendarQuickCreateClasses.<workspaceId>`, holding a
 * class-id array. `null`/absent means "follow defaults": the effective chip
 * set is all currently-eligible classes (every class with a date-typed
 * binding — today that is the system Task class), which keeps fresh
 * workspaces non-breaking. An explicit list may name ids that later become
 * ineligible; renderers intersect with current eligibility and stale ids
 * silently drop out (no scrubbing migration). Cross-device preference sync
 * is a separate product ruling (a future prefs-sync decision) — deliberately NOT
 * built here.
 */

import { useCallback } from "react";

import {
  readDeviceSetting,
  useDeviceSetting,
  writeDeviceSetting,
} from "./modals/deviceSettings.js";

/** The exact storage key prefix; the full key is `${PREFIX}.${workspaceId}`. */
export const QUICK_CREATE_CLASSES_PREFIX = "calendarQuickCreateClasses";

export function quickCreateClassesSettingKey(workspaceId: string): string {
  return `${QUICK_CREATE_CLASSES_PREFIX}.${workspaceId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** The stored explicit list, null when the workspace follows defaults. */
export function readQuickCreateClassesSetting(workspaceId: string): string[] | null {
  const value = readDeviceSetting<unknown>(quickCreateClassesSettingKey(workspaceId), null);
  return isStringArray(value) ? value : null;
}

/**
 * Persist the explicit list (null resets to defaults — the stored JSON null
 * reads back as absent; writeDeviceSetting already notifies listeners, so
 * open views re-render through the settings-changed event).
 */
export function writeQuickCreateClassesSetting(workspaceId: string, value: string[] | null): void {
  writeDeviceSetting<string[] | null>(quickCreateClassesSettingKey(workspaceId), value);
}

/**
 * The effective chip class ids for a render: defaults follow current
 * eligibility; an explicit list is intersected with it (stale ids drop).
 */
export function resolveQuickCreateChipClasses(
  stored: string[] | null,
  eligibleClassIds: readonly string[],
): string[] {
  if (stored === null) return [...eligibleClassIds];
  const eligible = new Set(eligibleClassIds);
  return stored.filter((id) => eligible.has(id));
}

/**
 * State-backed access mirroring useDeviceSetting: persists + notifies on
 * write, re-reads on the settings-changed/storage events (another surface —
 * the Calendar view's chips — updates live). Pass null for no workspace
 * (always null, writes are no-ops).
 */
export function useQuickCreateClassesSetting(
  workspaceId: string | null,
): [string[] | null, (value: string[] | null) => void] {
  const [raw, setRaw] = useDeviceSetting<string[] | null>(
    workspaceId === null ? `${QUICK_CREATE_CLASSES_PREFIX}.<none>` : quickCreateClassesSettingKey(workspaceId),
    null,
  );
  const value = isStringArray(raw) ? raw : null;
  const set = useCallback(
    (next: string[] | null) => {
      if (workspaceId === null) return;
      writeQuickCreateClassesSetting(workspaceId, next);
      setRaw(next);
    },
    [workspaceId, setRaw],
  );
  return [value, set];
}
