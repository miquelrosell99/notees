import { describe, expect, it } from "vitest";
import { badgeText, countFields } from "../src/ui/field-badge";
import type { ScannedField } from "../src/citation/ooxml";

function field(kind: ScannedField["kind"]): ScannedField {
  return { code: "x", displayText: "x", kind, embed: null };
}

describe("countFields", () => {
  it("counts citations and reports bibliography presence as 0/1", () => {
    expect(
      countFields([
        field("citation"),
        field("citation"),
        field("citation"),
        field("bibliography"),
      ]),
    ).toEqual({ citations: 3, bibliography: 1 });
  });

  it("caps the bibliography indicator at 1 even with duplicated fields", () => {
    expect(countFields([field("bibliography"), field("bibliography")])).toEqual({
      citations: 0,
      bibliography: 1,
    });
  });

  it("foreign fields never enter either counter", () => {
    expect(countFields([field("foreign"), field("foreign")])).toEqual({
      citations: 0,
      bibliography: 0,
    });
  });
});

describe("badgeText", () => {
  it("formats the header contract: N citations · M bibliography", () => {
    expect(badgeText({ citations: 2, bibliography: 1 })).toBe("2 citations · 1 bibliography");
    expect(badgeText({ citations: 0, bibliography: 0 })).toBe("0 citations · 0 bibliography");
  });
});
