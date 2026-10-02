/**
 * Calendar quick-create settings tests: the per-workspace device-local
 * round-trip, key isolation between workspaces, value validation, and the
 * resolve semantics (absent = follow current eligibility; an explicit list
 * intersects with eligibility so stale ids silently drop out).
 */

import { describe, expect, it } from "vitest";

import {
  QUICK_CREATE_CLASSES_PREFIX,
  quickCreateClassesSettingKey,
  readQuickCreateClassesSetting,
  resolveQuickCreateChipClasses,
  writeQuickCreateClassesSetting,
} from "../src/ui/components/calendarQuickCreateSettings.js";

const WS_A = "ws-a";
const WS_B = "ws-b";

describe("quick-create classes setting", () => {
  it("round-trips an explicit class-id list under the per-workspace key", () => {
    expect(quickCreateClassesSettingKey(WS_A)).toBe(`${QUICK_CREATE_CLASSES_PREFIX}.ws-a`);
    expect(readQuickCreateClassesSetting(WS_A)).toBeNull(); // absent = defaults

    writeQuickCreateClassesSetting(WS_A, ["cls-1", "cls-2"]);
    expect(readQuickCreateClassesSetting(WS_A)).toEqual(["cls-1", "cls-2"]);
    // The exact storage shape (deviceSettings JSON under notees.settings.*).
    expect(localStorage.getItem(`notees.settings.${QUICK_CREATE_CLASSES_PREFIX}.ws-a`)).toBe(
      JSON.stringify(["cls-1", "cls-2"]),
    );
  });

  it("keys are isolated per workspace", () => {
    writeQuickCreateClassesSetting(WS_A, ["cls-1"]);
    expect(readQuickCreateClassesSetting(WS_B)).toBeNull();
    writeQuickCreateClassesSetting(WS_B, ["cls-9"]);
    expect(readQuickCreateClassesSetting(WS_A)).toEqual(["cls-1"]);
    expect(readQuickCreateClassesSetting(WS_B)).toEqual(["cls-9"]);
  });

  it("writing null resets to defaults (reads back as absent)", () => {
    writeQuickCreateClassesSetting(WS_A, ["cls-1"]);
    writeQuickCreateClassesSetting(WS_A, null);
    expect(readQuickCreateClassesSetting(WS_A)).toBeNull();
  });

  it("garbage in the key reads as defaults, never crashes", () => {
    localStorage.setItem(`notees.settings.${QUICK_CREATE_CLASSES_PREFIX}.ws-a`, "{not json");
    expect(readQuickCreateClassesSetting(WS_A)).toBeNull();
    localStorage.setItem(`notees.settings.${QUICK_CREATE_CLASSES_PREFIX}.ws-a`, JSON.stringify([1, 2]));
    expect(readQuickCreateClassesSetting(WS_A)).toBeNull();
  });
});

describe("resolveQuickCreateChipClasses", () => {
  it("null follows current eligibility (a copy, not the input array)", () => {
    const eligible = ["a", "b"];
    const resolved = resolveQuickCreateChipClasses(null, eligible);
    expect(resolved).toEqual(["a", "b"]);
    expect(resolved).not.toBe(eligible);
  });

  it("an explicit list intersects with eligibility; stale ids drop silently", () => {
    expect(resolveQuickCreateChipClasses(["b", "stale", "a"], ["a", "b", "c"])).toEqual(["b", "a"]);
    expect(resolveQuickCreateChipClasses(["gone"], ["a"])).toEqual([]);
  });
});
