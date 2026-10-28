import { describe, expect, it } from "vitest";
import {
  CARD_FAMILY_SEED,
  CARD_PROPERTY_UUIDS,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
} from "../src/seeds";

describe("memorization card family seeds", () => {
  it("the card class display name is Memorization card (TS key unchanged)", () => {
    expect(SYSTEM_CLASS_DISPLAY_NAMES.card).toBe("Memorization card");
    expect(SYSTEM_CLASS_UUIDS.card).toBe("00000000-0000-0000-0001-000000000011");
  });

  it("card family schemas are six, class-bound, unpinned, unique uuids", () => {
    expect(CARD_FAMILY_SEED).toHaveLength(6);
    const uuids = CARD_FAMILY_SEED.map((s) => CARD_PROPERTY_UUIDS[s.property]);
    expect(new Set(uuids).size).toBe(6);
    for (const spec of CARD_FAMILY_SEED) {
      const schema = (SYSTEM_PROPERTY_SPECS as Record<string, unknown>)[spec.property];
      expect(schema).toMatchObject({ type: spec.type, bindTo: "card" });
      expect((schema as { pinned?: boolean }).pinned ?? false).toBe(false);
      // The seed UUID map and the load-bearing family export never drift apart.
      expect(SYSTEM_PROPERTY_UUIDS[spec.property]).toBe(CARD_PROPERTY_UUIDS[spec.property]);
    }
  });

  it("card family uuids do not collide with the task family namespace", () => {
    for (const uuid of Object.values(CARD_PROPERTY_UUIDS)) {
      expect(uuid.startsWith("00000000-0000-0000-0004-")).toBe(true);
    }
  });
});
