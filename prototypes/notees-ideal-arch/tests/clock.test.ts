import { expect, test } from "bun:test";
import { Clock, compareHlc, maxHlc } from "../src/clock";

test("clock advances and orders events", () => {
  const clock = new Clock("device-a");
  const t1 = clock.advance(1000);
  const t2 = clock.advance(1000);
  expect(compareHlc(t1, t2)).toBe(-1);
  expect(t2.logical).toBeGreaterThan(t1.logical);
});

test("clock advances with backward physical time", () => {
  const clock = new Clock("device-a");
  const t1 = clock.advance(2000);
  const t2 = clock.advance(1000);
  expect(t1.physical).toBe(2000);
  expect(t2.physical).toBe(2000);
  expect(t2.logical).toBe(t1.logical + 1);
  expect(compareHlc(t1, t2)).toBe(-1);
});

test("update merges with received clock when physical time dominates", () => {
  const clock = new Clock("device-a");
  clock.advance(1000);
  const received = { physical: 1500, logical: 5 };
  const result = clock.update(received, 2000);
  expect(result).toEqual({ physical: 2000, logical: 0 });
});

test("update merges with equal physical time and received logical ahead", () => {
  const clock = new Clock("device-a");
  const local = clock.advance(1000);
  const received = { physical: 1000, logical: 5 };
  const result = clock.update(received, 1000);
  expect(result.physical).toBe(1000);
  expect(result.logical).toBe(received.logical + 1);
});

test("update merges when local physical time dominates", () => {
  const clock = new Clock("device-a");
  clock.advance(2000);
  const received = { physical: 1000, logical: 5 };
  const result = clock.update(received, 1500);
  expect(result.physical).toBe(2000);
  expect(result.logical).toBeGreaterThan(0);
});

test("maxHlc returns the greater clock", () => {
  const a = { physical: 1000, logical: 1 };
  const b = { physical: 1000, logical: 2 };
  expect(maxHlc(a, b)).toEqual(b);
  expect(maxHlc(b, a)).toEqual(b);
});

test("maxHlc does not mutate inputs", () => {
  const a = { physical: 1000, logical: 1 };
  const b = { physical: 1000, logical: 2 };
  const result = maxHlc(a, b);
  result.logical = 999;
  expect(a.logical).toBe(1);
  expect(b.logical).toBe(2);
});

test("compareHlc orders by physical then logical", () => {
  expect(compareHlc({ physical: 1, logical: 0 }, { physical: 2, logical: 0 })).toBe(-1);
  expect(compareHlc({ physical: 2, logical: 0 }, { physical: 1, logical: 0 })).toBe(1);
  expect(compareHlc({ physical: 1, logical: 1 }, { physical: 1, logical: 2 })).toBe(-1);
  expect(compareHlc({ physical: 1, logical: 2 }, { physical: 1, logical: 1 })).toBe(1);
  expect(compareHlc({ physical: 1, logical: 1 }, { physical: 1, logical: 1 })).toBe(0);
});
