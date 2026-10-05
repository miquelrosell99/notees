import { describe, expect, it } from "vitest";

import { formatNumberValue } from "../src/ui/views/propertyDisplay.js";

describe("formatNumberValue (SCHEMA.md Number formats)", () => {
  it("passes through without a schema or formats", () => {
    expect(formatNumberValue(7, undefined)).toBe("7");
    expect(formatNumberValue(7.25, {})).toBe("7.25");
    expect(formatNumberValue(7, null)).toBe("7");
  });

  it("zero-pads the integer part to numberPad digits", () => {
    expect(formatNumberValue(1, { numberPad: 4 })).toBe("0001");
    expect(formatNumberValue(1025, { numberPad: 4 })).toBe("1025");
    expect(formatNumberValue(-7, { numberPad: 3 })).toBe("-007");
  });

  it("cuts decimals with the rounding approach (default round)", () => {
    expect(formatNumberValue(0.75, { numberDecimals: 1 })).toBe("0.8");
    expect(formatNumberValue(0.75, { numberDecimals: 1, numberRounding: "floor" })).toBe("0.7");
    expect(formatNumberValue(0.75, { numberDecimals: 1, numberRounding: "ceil" })).toBe("0.8");
    expect(formatNumberValue(-0.75, { numberDecimals: 1, numberRounding: "truncate" })).toBe("-0.7");
  });

  it("applies decimals then pad together", () => {
    expect(formatNumberValue(2.04, { numberPad: 4, numberDecimals: 1 })).toBe("0002");
    expect(formatNumberValue(155.55, { numberPad: 4, numberDecimals: 1, numberRounding: "floor" })).toBe("0155.5");
  });
});
