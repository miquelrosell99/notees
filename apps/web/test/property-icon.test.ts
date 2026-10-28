/**
 * effectivePropertyIcon — the property-header icon derivation: the schema's
 * stored icon wins; unset/empty falls back to a per-TYPE mdi icon; a
 * schema-less row or an unknown type lands on the generic tag. Nothing is
 * stored — the fallback is a pure read-time derivation, and every fallback
 * name must exist in public/mdi-sprite.svg (sprite-verified at authoring).
 */

import { describe, expect, it } from "vitest";

import { effectivePropertyIcon } from "../src/features/metadata/propertyIcon.js";

describe("effectivePropertyIcon", () => {
  it("the stored schema icon wins over the type fallback", () => {
    expect(effectivePropertyIcon({ icon: "mdi-star", type: "text" })).toBe("mdi-star");
    expect(effectivePropertyIcon({ icon: "mdi mdi-heart-outline", type: "email" })).toBe(
      "mdi mdi-heart-outline",
    );
  });

  it("null or blank stored icon falls back to the type icon", () => {
    expect(effectivePropertyIcon({ icon: null, type: "text" })).toBe("mdi-format-text");
    expect(effectivePropertyIcon({ icon: "", type: "email" })).toBe("mdi-email-outline");
    expect(effectivePropertyIcon({ icon: "   ", type: "number" })).toBe("mdi-numeric");
  });

  it("every property type maps to its sprite-verified icon", () => {
    expect(effectivePropertyIcon({ icon: null, type: "text" })).toBe("mdi-format-text");
    expect(effectivePropertyIcon({ icon: null, type: "email" })).toBe("mdi-email-outline");
    expect(effectivePropertyIcon({ icon: null, type: "image" })).toBe("mdi-image-outline");
    expect(effectivePropertyIcon({ icon: null, type: "number" })).toBe("mdi-numeric");
    expect(effectivePropertyIcon({ icon: null, type: "select" })).toBe("mdi-format-list-checks");
    expect(effectivePropertyIcon({ icon: null, type: "multi_select" })).toBe("mdi-format-list-checkbox");
    expect(effectivePropertyIcon({ icon: null, type: "boolean" })).toBe("mdi-check-circle-outline");
    expect(effectivePropertyIcon({ icon: null, type: "datetime" })).toBe("mdi-calendar-clock");
    expect(effectivePropertyIcon({ icon: null, type: "object" })).toBe("mdi-target");
    expect(effectivePropertyIcon({ icon: null, type: "asset" })).toBe("mdi-paperclip");
  });

  it("unknown types and schema-less rows land on the generic fallback", () => {
    expect(effectivePropertyIcon({ icon: null, type: "mystery" })).toBe("mdi-tag-outline");
    expect(effectivePropertyIcon(null)).toBe("mdi-tag-outline");
    expect(effectivePropertyIcon({})).toBe("mdi-tag-outline");
  });
});
