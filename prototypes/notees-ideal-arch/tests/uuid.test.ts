import { expect, test } from "bun:test";
import { uuidv7 } from "../src/uuid";

test("generates uuidv7 strings", () => {
  const id = uuidv7();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
