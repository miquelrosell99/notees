/**
 * buildEditableDom unit tests (jsdom). The load-bearing contract: an empty
 * AST must leave the editable with a single <br> placeholder — the editable
 * needs a real line box for the caret to render at a predictable height and
 * for point-hit caret placement (focusAtPoint) to resolve inside it. The
 * <br> contributes no textContent, so drafts, prose offsets, and the
 * rehydration signature stay byte-identical.
 *
 * Mention-label re-resolution (the stale-capture ruling): a mention token's
 * captured `text` can be stale (import-era captures baked nested-link UUIDs
 * into it). The editor layer threads a `MentionNameResolver` and renders
 * the pill — prose, spans, atoms, and DOM alike — from the label chain:
 * displayText → re-resolved current full title → captured text → raw id.
 */

import { describe, expect, it } from "vitest";

import { proseFromAst, proseSpans } from "../src/editor/prose.js";
import {
  ATOM_CLASS,
  buildEditableDom,
  editableAtoms,
  editableDomSignature,
} from "../src/editor/editable-dom.js";

const TARGET = "0192a000-0000-7000-8000-0000000000a1";
// An import-era capture: the nested link's UUID is baked into the text.
const STALE_TEXT = "Quarterly plan (0192a000-0000-7000-8000-0000000000b2)";

const ast = [
  { type: "text", text: "see " },
  { type: "mention", targetNodeId: TARGET, text: STALE_TEXT, linkId: "l1" },
  { type: "text", text: " again" },
];

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

describe("mention label re-resolution", () => {
  const resolveMentionName = (): string => "Quarterly plan";

  it("renders the resolved title in prose, spans, atoms, and the DOM pill", () => {
    const prose = proseFromAst(ast, undefined, resolveMentionName);
    expect(prose).toBe("see Quarterly plan again");

    const spans = proseSpans(ast, undefined, resolveMentionName);
    // The mention's span covers the RESOLVED label, not the stale capture
    // (14 chars vs the longer stale text — the offset math must ride the
    // label or every prose-based operation lands wrong).
    expect(spans[1]).toEqual({ tokenIndex: 1, start: 4, end: 18 });

    const atoms = editableAtoms(ast, undefined, resolveMentionName);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toMatchObject({
      tokenIndex: 1,
      start: 4,
      end: 18,
      targetNodeId: TARGET,
      text: "Quarterly plan",
      kind: "mention",
    });

    const el = document.createElement("span");
    buildEditableDom(el, ast, undefined, undefined, undefined, resolveMentionName);
    expect(el.textContent).toBe(prose); // DOM ⇄ prose: one coordinate system
    const pill = el.querySelector<HTMLElement>(`.${ATOM_CLASS}`);
    expect(pill?.textContent).toBe("Quarterly plan");
    expect(pill?.dataset.atomKey).toBe("4:18"); // DOM and atoms agree

    // The rehydration signature rides the resolved prose too.
    expect(editableDomSignature(ast, undefined, resolveMentionName)).toBe(`${prose}#1`);
  });

  it("a displayText custom label wins over the resolved title", () => {
    const labeled = [
      ast[0],
      { ...ast[1], displayText: "the plan" },
      ast[2],
    ];
    expect(proseFromAst(labeled, undefined, resolveMentionName)).toBe("see the plan again");
    const el = document.createElement("span");
    buildEditableDom(el, labeled, undefined, undefined, undefined, resolveMentionName);
    expect(el.querySelector(`.${ATOM_CLASS}`)?.textContent).toBe("the plan");
  });

  it("a broken target falls back to the captured text", () => {
    const broken = (): string | null => null;
    const prose = proseFromAst(ast, undefined, broken);
    expect(prose).toBe(`see ${STALE_TEXT} again`);
    const el = document.createElement("span");
    buildEditableDom(el, ast, undefined, undefined, undefined, broken);
    expect(el.querySelector(`.${ATOM_CLASS}`)?.textContent).toBe(STALE_TEXT);
  });

  it("a textless mention of a broken target renders the raw target id", () => {
    const textless = [{ type: "mention", targetNodeId: TARGET, linkId: "l1" }];
    const broken = (): string | null => null;
    expect(proseFromAst(textless, undefined, broken)).toBe(TARGET);
    const el = document.createElement("span");
    buildEditableDom(el, textless, undefined, undefined, undefined, broken);
    expect(el.querySelector(`.${ATOM_CLASS}`)?.textContent).toBe(TARGET);
  });

  it("without a resolver the captured text passes through verbatim", () => {
    expect(proseFromAst(ast)).toBe(`see ${STALE_TEXT} again`);
    const el = document.createElement("span");
    buildEditableDom(el, ast);
    expect(el.textContent).toBe(`see ${STALE_TEXT} again`);
    expect(el.querySelector(`.${ATOM_CLASS}`)?.textContent).toBe(STALE_TEXT);
    // And the span math rides the captured text, as before the resolver.
    expect(proseSpans(ast)[1]).toEqual({
      tokenIndex: 1,
      start: 4,
      end: 4 + STALE_TEXT.length,
    });
  });
});
