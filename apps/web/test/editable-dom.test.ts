/**
 * buildEditableDom unit tests (jsdom). The load-bearing contract: an empty
 * AST must leave the editable with a single <br> placeholder — the editable
 * needs a real line box for the caret to render at a predictable height and
 * for point-hit caret placement (focusAtPoint) to resolve inside it. The
 * <br> contributes no textContent, so drafts, prose offsets, and the
 * rehydration signature stay byte-identical.
 */

import { describe, expect, it } from "vitest";

import { buildEditableDom } from "../src/editor/editable-dom.js";

describe("buildEditableDom", () => {
  it("empty AST leaves exactly one <br> placeholder", () => {
    const el = document.createElement("span");
    buildEditableDom(el, []);
    expect(el.childNodes.length).toBe(1);
    expect(el.firstChild?.nodeName).toBe("BR");
    expect(el.textContent).toBe("");
  });

  it("non-empty AST renders no placeholder", () => {
    const el = document.createElement("span");
    buildEditableDom(el, [{ type: "text", text: "hello" }]);
    expect(el.querySelector("br")).toBeNull();
    expect(el.textContent).toBe("hello");
  });

  it("rebuild of a non-empty editable clears the text and restores the placeholder", () => {
    const el = document.createElement("span");
    buildEditableDom(el, [{ type: "text", text: "hello" }]);
    buildEditableDom(el, []);
    expect(el.childNodes.length).toBe(1);
    expect(el.firstChild?.nodeName).toBe("BR");
    expect(el.textContent).toBe("");
  });
});
