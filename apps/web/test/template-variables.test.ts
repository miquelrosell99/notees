/**
 * Template apply-time variable tests: the `{{name}}` syntax
 * (one syntax for static + dynamic), the dual extraction (Set
 * dedup, first-seen order), text-token-only substitution inside the clone
 * engine's composition (graft root + cloned children), the unknown-name
 * verbatim guard, and the dynamic values computed LOCAL (the UTC
 * `today` bug stays fixed).
 */

import { describe, expect, it } from "vitest";
import type { ContentAst } from "@notees/protocol";

import {
  composeSubtreeClone,
  composeTemplateGraft,
  extractTemplateVariables,
  substituteVariablesInAst,
  substituteVariablesInText,
  variablesInText,
  type CloneReadSurface,
} from "../src/core/clone.js";
import { computeDynamicTemplateVariables, isDynamicTemplateVariable } from "../src/ui/templates/templateVariables.js";
import type { ClientNode, EffectiveProperty } from "../src/core/workspace-client.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";

function fakeNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
  return {
    workspaceId: WS,
    isClass: false,
    presentAsMain: false,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: null,
    contentAst: [],
    icon: null,
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
    color: null,
    isActive: true,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

class FakeReads implements CloneReadSurface {
  constructor(
    private nodes: Map<string, ClientNode>,
    private childOrder: Map<string, string[]>,
  ) {}
  getNode(id: string): ClientNode | undefined {
    return this.nodes.get(id);
  }
  getChildren(id: string): ClientNode[] {
    return (this.childOrder.get(id) ?? [])
      .map((childId) => this.nodes.get(childId))
      .filter((node): node is ClientNode => node !== undefined);
  }
  getEffectiveProperties(): EffectiveProperty[] {
    return [];
  }
}

describe("variablesInText", () => {
  it("extracts names, dedupes, keeps first-seen order", () => {
    expect(variablesInText("Meet {{name}} about {{topic}} with {{name}}")).toEqual([
      "name",
      "topic",
    ]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(variablesInText("{{ name }} and {{  other  }}")).toEqual(["name", "other"]);
  });

  it("returns [] when no variable is present", () => {
    expect(variablesInText("plain prose with braces {like} this")).toEqual([]);
  });
});

describe("substituteVariablesInText", () => {
  it("replaces every known occurrence, including repeats", () => {
    expect(substituteVariablesInText("{{name}} meets {{name}}", { name: "Ada" })).toBe(
      "Ada meets Ada",
    );
  });

  it("leaves unknown names verbatim (never silently emptied)", () => {
    expect(substituteVariablesInText("{{known}} / {{unknown}}", { known: "yes" })).toBe(
      "yes / {{unknown}}",
    );
  });
});

describe("substituteVariablesInAst", () => {
  it("touches text tokens only — mentions/chips keep their fields", () => {
    const ast: ContentAst = [
      { type: "text", text: "Hello {{name}}" },
      { type: "mention", targetNodeId: "x".repeat(36), text: "{{name}}" },
    ] as ContentAst;
    const next = substituteVariablesInAst(ast, { name: "Ada" });
    expect(next[0]).toMatchObject({ type: "text", text: "Hello Ada" });
    expect(next[1]).toMatchObject({ type: "mention", text: "{{name}}" });
  });
});

describe("extractTemplateVariables", () => {
  it("walks the whole subtree (root + children), text tokens only, deduped", () => {
    const root = fakeNode({
      id: "root",
      contentAst: [{ type: "text", text: "Meeting {{name}}" }] as ContentAst,
    });
    const child = fakeNode({
      id: "child",
      parentId: "root",
      contentAst: [
        { type: "text", text: "Attendees: {{attendees}} — called {{name}}" },
        { type: "text", text: "{{ today }}" },
      ] as ContentAst,
    });
    const reads = new FakeReads(
      new Map([
        ["root", root],
        ["child", child],
      ]),
      new Map([["root", ["child"]]]),
    );
    expect(extractTemplateVariables(reads, "root")).toEqual(["name", "attendees", "today"]);
  });
});

describe("clone composition with variables", () => {
  const TEMPLATE = "00000000-0000-7000-8000-0000000000v1";
  const CHILD = "00000000-0000-7000-8000-0000000000v2";
  const TARGET = "00000000-0000-7000-8000-0000000000v3";
  let ids = 0;
  const nextId = () => `00000000-0000-7000-8000-0000000000${String(++ids).padStart(3, "0")}`;

  function fixture() {
    const root = fakeNode({
      id: TEMPLATE,
      contentAst: [{ type: "text", text: "Notes for {{name}}" }] as ContentAst,
    });
    const child = fakeNode({
      id: CHILD,
      parentId: TEMPLATE,
      contentAst: [{ type: "text", text: "Follow up with {{name}} on {{date}}" }] as ContentAst,
    });
    const target = fakeNode({ id: TARGET });
    return new FakeReads(
      new Map([
        [TEMPLATE, root],
        [CHILD, child],
        [TARGET, target],
      ]),
      new Map([
        [TEMPLATE, [CHILD]],
        [TARGET, []],
      ]),
    );
  }

  it("composeTemplateGraft substitutes the graft root and the cloned children", () => {
    const reads = fixture();
    const { ops } = composeTemplateGraft(reads, {
      templateRootId: TEMPLATE,
      objectId: TARGET,
      variables: { name: "Ada", date: "2026-10-03" },
      newId: nextId,
    });
    const update = ops.find((op) => op.opType === "object.update");
    expect(update?.payload).toMatchObject({
      objectId: TARGET,
      contentAst: [{ type: "text", text: "Notes for Ada" }],
    });
    const childCreate = ops.find(
      (op) => op.opType === "object.create" && op.payload.parentId === TARGET,
    );
    expect(childCreate?.payload).toMatchObject({
      contentAst: [{ type: "text", text: "Follow up with Ada on 2026-10-03" }],
    });
  });

  it("composeSubtreeClone substitutes every cloned node's text tokens", () => {
    const reads = fixture();
    const { ops } = composeSubtreeClone(reads, {
      rootId: TEMPLATE,
      variables: { name: "Ada", date: "today" },
      newId: nextId,
    });
    const texts = ops
      .filter((op) => op.opType === "object.create")
      .map((op) => (op.payload.contentAst ?? []).map((t) => (t as { text?: string }).text));
    expect(texts).toEqual([["Notes for Ada"], ["Follow up with Ada on today"]]);
  });

  it("without the variables option the AST copies verbatim", () => {
    const reads = fixture();
    const { ops } = composeTemplateGraft(reads, {
      templateRootId: TEMPLATE,
      objectId: TARGET,
      newId: nextId,
    });
    const update = ops.find((op) => op.opType === "object.update");
    expect(update?.payload).toMatchObject({
      contentAst: [{ type: "text", text: "Notes for {{name}}" }],
    });
  });
});

describe("computeDynamicTemplateVariables (local, never UTC)", () => {
  // 2026-10-03 15:04:05 local (month/day constructor = local by design).
  const NOW = new Date(2026, 9, 3, 15, 4, 5);

  it("today is the LOCAL date (the UTC bug stays fixed)", () => {
    const values = computeDynamicTemplateVariables(["today"], {}, NOW);
    expect(values.today).toBe("2026-10-03");
  });

  it("time is local HH:MM", () => {
    expect(computeDynamicTemplateVariables(["time"], {}, NOW).time).toBe("15:04");
  });

  it("datetime carries a local ISO shape with offset", () => {
    const value = computeDynamicTemplateVariables(["datetime"], {}, NOW).datetime!;
    expect(value).toMatch(/^2026-10-03T15:04:00[+-]\d{2}:\d{2}$/);
  });

  it("current_page comes from the context", () => {
    expect(
      computeDynamicTemplateVariables(["current_page"], { currentPageName: "Home" }, NOW)
        .current_page,
    ).toBe("Home");
  });

  it("static names are not computed and classify as static", () => {
    expect(computeDynamicTemplateVariables(["name"], {}, NOW)).toEqual({});
    expect(isDynamicTemplateVariable("name")).toBe(false);
    expect(isDynamicTemplateVariable("today")).toBe(true);
  });
});
