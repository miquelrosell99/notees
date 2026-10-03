/**
 * Deck builder tests (§34.26 P2/P4/P5) — the pure slide model over synthetic
 * trees: the title slide is always first; every present_as_main=1 top-level
 * child is one section slide; present_as_main=0 runs chunk into intro slides
 * by the density rule; trailing image blocks drive the split / image-full
 * layouts; embed_refs splice the target's children into the stream after the
 * referencing slide with a cycle guard; density tiers size the slide.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDeck,
  collectEmbedTargets,
  DENSITY_DENSE_MIN_CHARS,
  deckDensityOf,
  imageAssetOfBlock,
  INTRO_SLIDE_MAX_BLOCKS,
  INTRO_SLIDE_TARGET_CHARS,
  type DeckSlide,
  type DeckTreeEntry,
} from "../src/ui/presentation/deck.js";

let seq = 0;

beforeEach(() => {
  seq = 0;
});

interface EntryOptions {
  /** present_as_main render bit (default true — the store default). */
  main?: boolean;
  /** The block IS one asset_ref token with this asset id. */
  assetId?: string;
  /** The block IS one embed_ref token pointing at this node id. */
  embedId?: string;
  children?: DeckTreeEntry[];
}

function entry(text: string, opts: EntryOptions = {}): DeckTreeEntry {
  seq += 1;
  const contentAst: unknown[] = [];
  if (opts.assetId !== undefined) contentAst.push({ type: "asset_ref", assetId: opts.assetId });
  else if (opts.embedId !== undefined) contentAst.push({ type: "embed_ref", nodeId: opts.embedId });
  else if (text !== "") contentAst.push({ type: "text", text });
  return {
    node: { id: `n${seq}`, presentAsMain: opts.main ?? true, contentAst },
    children: opts.children ?? [],
  };
}

function deck(rootText: string, children: DeckTreeEntry[], resolve?: (id: string) => DeckTreeEntry | undefined) {
  const root = entry(rootText);
  return buildDeck({ node: root.node, children }, resolve ?? (() => undefined));
}

const kinds = (slides: DeckSlide[]) => slides.map((s) => s.kind);

describe("buildDeck — slide partitioning", () => {
  it("an empty page decks to the title slide alone", () => {
    const slides = deck("Solo Page", []);
    expect(slides).toEqual([{ kind: "title", nodeId: "n1" }]);
  });

  it("a text-only page (no children) decks to the title slide alone", () => {
    const slides = deck("Just a title, no blocks", []);
    expect(kinds(slides)).toEqual(["title"]);
  });

  it("each present_as_main=1 top-level child is one section slide, in order", () => {
    const alpha = entry("Alpha");
    const beta = entry("Beta");
    const gamma = entry("Gamma");
    const slides = deck("Deck", [alpha, beta, gamma]);
    expect(kinds(slides)).toEqual(["title", "section", "section", "section"]);
    const sections = slides.slice(1) as Extract<DeckSlide, { kind: "section" }>[];
    expect(sections.map((s) => s.nodeId)).toEqual([alpha.node.id, beta.node.id, gamma.node.id]);
  });

  it("a run of present_as_main=0 children becomes one sparse intro slide", () => {
    const slides = deck("Deck", [
      entry("Intro one", { main: false }),
      entry("Intro two", { main: false }),
    ]);
    expect(kinds(slides)).toEqual(["title", "intro"]);
    const intro = slides[1] as Extract<DeckSlide, { kind: "intro" }>;
    expect(intro.blockIds).toHaveLength(2);
    expect(intro.density).toBe("sparse");
    expect(intro.layout).toEqual({ type: "standard" });
  });

  it("chunks a long body run by the character budget and the block cap", () => {
    // Half the budget each: two blocks per chunk (the greedy rule closes a
    // chunk only when ADDING would exceed the target — a pair exactly at the
    // budget stays together).
    const half = "x".repeat(Math.floor(INTRO_SLIDE_TARGET_CHARS / 2));
    const run = Array.from({ length: 4 }, () => entry(half, { main: false }));
    const slides = deck("Deck", run);
    const intros = slides.slice(1) as Extract<DeckSlide, { kind: "intro" }>[];
    expect(intros).toHaveLength(2);
    expect(intros[0]!.blockIds).toHaveLength(2);
    expect(intros[1]!.blockIds).toHaveLength(2);

    // One over the budget per block: every block closes its own chunk.
    const over = "x".repeat(INTRO_SLIDE_TARGET_CHARS + 1);
    const solo = deck("Deck", [entry(over, { main: false }), entry(over, { main: false })]);
    const soloIntros = solo.slice(1) as Extract<DeckSlide, { kind: "intro" }>[];
    expect(soloIntros.map((slide) => slide.blockIds)).toHaveLength(2);
    expect(soloIntros[0]!.blockIds).toHaveLength(1);

    const capped = deck(
      "Deck",
      Array.from({ length: INTRO_SLIDE_MAX_BLOCKS + 1 }, () => entry("tiny", { main: false })),
    );
    const cappedIntros = capped.slice(1) as Extract<DeckSlide, { kind: "intro" }>[];
    expect(cappedIntros).toHaveLength(2);
    expect(cappedIntros[0]!.blockIds).toHaveLength(INTRO_SLIDE_MAX_BLOCKS);
    expect(cappedIntros[1]!.blockIds).toHaveLength(1);
  });

  it("interleaves intro runs and sections in document order", () => {
    const slides = deck("Deck", [
      entry("Opening note", { main: false }),
      entry("Section A"),
      entry("Body under A", { main: false }),
      entry("Body under B", { main: false }),
      entry("Section B"),
    ]);
    expect(kinds(slides)).toEqual(["title", "intro", "section", "intro", "section"]);
    const intro = slides[3] as Extract<DeckSlide, { kind: "intro" }>;
    expect(intro.blockIds).toHaveLength(2);
  });
});

describe("buildDeck — layout heuristics (P4)", () => {
  it("a trailing image block with text siblings pulls aside into a split", () => {
    const slides = deck("Deck", [
      entry("Section", { children: [entry("Some text"), entry("", { assetId: "asset-1" })] }),
    ]);
    const section = slides[1] as Extract<DeckSlide, { kind: "section" }>;
    expect(section.layout).toEqual({ type: "split", imageAssetId: "asset-1" });
  });

  it("a lone image body block becomes the centered image-full layout", () => {
    const slides = deck("Deck", [entry("Section", { children: [entry("", { assetId: "asset-2" })] })]);
    const section = slides[1] as Extract<DeckSlide, { kind: "section" }>;
    expect(section.layout).toEqual({ type: "image-full", imageAssetId: "asset-2" });
  });

  it("a non-trailing image block does not trigger the pull", () => {
    const slides = deck("Deck", [
      entry("Section", { children: [entry("", { assetId: "asset-3" }), entry("Trailing text")] }),
    ]);
    const section = slides[1] as Extract<DeckSlide, { kind: "section" }>;
    expect(section.layout).toEqual({ type: "standard" });
  });

  it("an image block with extra text tokens is not an image block", () => {
    const mixed: DeckTreeEntry = {
      node: {
        id: "mx",
        presentAsMain: false,
        contentAst: [
          { type: "text", text: "caption " },
          { type: "asset_ref", assetId: "asset-4" },
        ],
      },
      children: [],
    };
    expect(imageAssetOfBlock(mixed)).toBeNull();
  });

  it("density tiers: short sparse, long dense", () => {
    const short = deck("Deck", [entry("Brief", { children: [entry("Tiny")] })]);
    expect((short[1] as Extract<DeckSlide, { kind: "section" }>).density).toBe("sparse");

    const longText = "y".repeat(DENSITY_DENSE_MIN_CHARS + 1);
    const long = deck("Deck", [entry("Heavy", { children: [entry(longText)] })]);
    expect((long[1] as Extract<DeckSlide, { kind: "section" }>).density).toBe("dense");

    expect(deckDensityOf(0)).toBe("sparse");
    expect(deckDensityOf(500)).toBe("normal");
    expect(deckDensityOf(DENSITY_DENSE_MIN_CHARS)).toBe("dense");
  });
});

describe("buildDeck — embed expansion (P5)", () => {
  it("an embed target's children splice into the stream after the referencing slide", () => {
    const targetChildren = [entry("Embedded section"), entry("Embedded body", { main: false })];
    const resolve = (id: string) => (id === "embed-target" ? entry("Target", { children: targetChildren }) : undefined);

    const slides = deck(
      "Deck",
      [entry("Before"), entry("Host section", { embedId: "embed-target" }), entry("After")],
      resolve,
    );
    expect(kinds(slides)).toEqual([
      "title",
      "section", // Before
      "section", // Host section (references the embed)
      "section", // embed-target's main child
      "intro", // embed-target's body run
      "section", // After
    ]);
  });

  it("an embed of the deck root is a cycle and renders no splice", () => {
    const root = entry("Deck");
    const slides = buildDeck(
      { node: { ...root.node, id: "root-id" }, children: [entry("Host", { embedId: "root-id" })] },
      (id) => (id === "root-id" ? { node: { ...root.node, id: "root-id" }, children: [] } : undefined),
    );
    expect(kinds(slides)).toEqual(["title", "section"]);
  });

  it("a broken embed target resolves undefined and is skipped", () => {
    const slides = deck("Deck", [entry("Host", { embedId: "missing" })]);
    expect(kinds(slides)).toEqual(["title", "section"]);
  });

  it("nested embeds expand depth-first with the shared visited guard", () => {
    const resolve = (id: string): DeckTreeEntry | undefined => {
      if (id === "outer") return entry("Outer", { children: [entry("Outer child", { embedId: "inner" })] });
      if (id === "inner") return entry("Inner", { children: [entry("Inner child")] });
      return undefined;
    };
    const slides = deck("Deck", [entry("Host", { embedId: "outer" }), entry("Host2", { embedId: "inner" })], resolve);
    // Host → outer child → inner child (expanded from outer child); Host2's
    // embed of "inner" is already visited → no second splice.
    expect(kinds(slides)).toEqual(["title", "section", "section", "section", "section"]);
  });

  it("collectEmbedTargets walks quote children and dedupes", () => {
    const quoted: DeckTreeEntry = {
      node: {
        id: "q",
        presentAsMain: false,
        contentAst: [
          { type: "quote", children: [{ type: "embed_ref", nodeId: "a" }, { type: "embed_ref", nodeId: "a" }] },
          { type: "embed_ref", nodeId: "b" },
        ],
      },
      children: [{ node: { id: "c", presentAsMain: false, contentAst: [{ type: "embed_ref", nodeId: "c1" }] }, children: [] }],
    };
    expect(collectEmbedTargets([quoted])).toEqual(["a", "b", "c1"]);
  });
});
