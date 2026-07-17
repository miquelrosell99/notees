import { expect, test } from "bun:test";
import { Clock, compareHlc } from "../src/clock";

test("clock advances and orders events", () => {
  const clock = new Clock("device-a");
  const t1 = clock.advance(1000);
  const t2 = clock.advance(1000);
  expect(compareHlc(t1, t2)).toBe(-1);
  expect(t2.logical).toBeGreaterThan(t1.logical);
});
