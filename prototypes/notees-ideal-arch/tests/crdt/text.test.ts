import { expect, test } from "bun:test";
import { TextCrdt } from "../../src/crdt/text";

test("text crdt converges concurrent edits", () => {
  const t1 = new TextCrdt();
  t1.insert(0, "Hello ");

  const t2 = new TextCrdt();
  t2.applyUpdate(t1.getState());
  t2.insert(6, "world");

  t1.applyUpdate(t2.getState());
  expect(t1.toPlaintext()).toBe("Hello world");
});
