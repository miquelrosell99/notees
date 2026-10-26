/**
 * buildEditableDom unit tests (jsdom). The load-bearing contract: an empty
 * AST must leave the editable with a single <br> placeholder — the editable
 * needs a real line box for the caret to render at a predictable height and
 * for point-hit caret placement (focusAtPoint) to resolve inside it. The
 * <br> contributes no textContent, so drafts, prose offsets, and the
 * rehydration signature stay byte-identical.
 *
 * Mention-label resolution (no stored link text):
 * a mention token carries ONLY `targetNodeId` (+ optional `customLabel`) —
 * there is no captured `text` to go stale. The editor layer threads a
 * `MentionNameResolver` and renders the pill — prose, spans, atoms, and DOM
 * alike — from the label chain: customLabel → re-resolved current full
 * title → raw target id (broken target, resolver threaded). Without a
 * resolver a label-less mention is prose-invisible.
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

const ast = [
  { type: "text", text: "see " },
  { type: "mention", targetNodeId: TARGET, linkId: "l1" },
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
    // Structural anti-drift: the wire token stores no link text at all.
    expect(ast[1]).not.toHaveProperty("text");

    const prose = proseFromAst(ast, undefined, resolveMentionName);
    expect(prose).toBe("see Quarterly plan again");

    const spans = proseSpans(ast, undefined, resolveMentionName);
    // The mention's span covers the RESOLVED label (14 chars) — the offset
    // math rides the label or every prose-based operation lands wrong.
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

  it("a customLabel wins over the resolved title", () => {
    const labeled = [
      ast[0],
      { ...ast[1], customLabel: "the plan" },
      ast[2],
    ];
    expect(proseFromAst(labeled, undefined, resolveMentionName)).toBe("see the plan again");
    const el = document.createElement("span");
    buildEditableDom(el, labeled, undefined, undefined, undefined, resolveMentionName);
    expect(el.querySelector(`.${ATOM_CLASS}`)?.textContent).toBe("the plan");
  });

  it("a customLabel needs no resolution — it survives a broken target", () => {
    const labeled = [
      ast[0],
      { ...ast[1], customLabel: "the plan" },
      ast[2],
    ];
    const broken = (): string | null => null;
    expect(proseFromAst(labeled, undefined, broken)).toBe("see the plan again");
    const el = document.createElement("span");
    buildEditableDom(el, labeled, undefined, undefined, undefined, broken);
    expect(el.querySelector(`.${ATOM_CLASS}`)?.textContent).toBe("the plan");
  });

  it("a textless mention of a broken target renders the raw target id", () => {
    const textless = [{ type: "mention", targetNodeId: TARGET, linkId: "l1" }];
    const broken = (): string | null => null;
    expect(proseFromAst(textless, undefined, broken)).toBe(TARGET);
    const el = document.createElement("span");
    buildEditableDom(el, textless, undefined, undefined, undefined, broken);
    expect(el.querySelector(`.${ATOM_CLASS}`)?.textContent).toBe(TARGET);
  });

  it("without a resolver a label-less mention is prose-invisible", () => {
    expect(proseFromAst(ast)).toBe("see  again");
    const el = document.createElement("span");
    buildEditableDom(el, ast);
    expect(el.textContent).toBe("see  again");
    expect(el.querySelector(`.${ATOM_CLASS}`)?.textContent).toBe("");
    // The span math rides the same projection: zero-length at the offset.
    expect(proseSpans(ast)[1]).toEqual({
      tokenIndex: 1,
      start: 4,
      end: 4,
    });
  });
});
