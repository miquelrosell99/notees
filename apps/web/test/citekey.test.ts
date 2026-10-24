/**
 * Citekey pattern language tests (owner 2026-10-24, source-library slice 3
 * task 5): the shared compile/render module — token rendering, the :lower
 * ASCII fold, word-count limits, literals, the invalid-pattern contract
 * (compile fails, render returns null), and the owner-ruling sample. The
 * collision-suffix helper is task 6's concern — deliberately absent here.
 */

import { describe, expect, it } from "vitest";

import {
  CITEKEY_SAMPLE_ENTRY,
  DEFAULT_CITEKEY_PATTERN,
  compileCitekeyPattern,
  renderCitekeyPattern,
  type CitekeyEntry,
} from "../src/features/sources/citekey.js";

const SAMPLE: CitekeyEntry = CITEKEY_SAMPLE_ENTRY;

/** Render through the pattern, asserting it compiles. */
function render(pattern: string, entry: CitekeyEntry = SAMPLE): string {
  const compiled = compileCitekeyPattern(pattern);
  if (!compiled.ok) throw new Error(`expected "${pattern}" to compile: ${compiled.error}`);
  return compiled.render(entry);
}

/** The compile error for a pattern, asserting it does NOT compile. */
function errorOf(pattern: string): string {
  const compiled = compileCitekeyPattern(pattern);
  if (compiled.ok) throw new Error(`expected "${pattern}" to fail the compile`);
  return compiled.error;
}

describe("compileCitekeyPattern", () => {
  it("renders the default pattern for the owner-ruling sample", () => {
    expect(DEFAULT_CITEKEY_PATTERN).toBe("[auth:lower][year][title:lower:3]");
    expect(render(DEFAULT_CITEKEY_PATTERN)).toBe("lovelace1843notesonthe");
  });

  it("[auth] takes the family of the first authors element (text before the comma)", () => {
    expect(render("[auth]", { authors: ["Lovelace, Ada"], year: 1843, title: "Notes" })).toBe(
      "Lovelace",
    );
    // An author without a comma contributes the whole string.
    expect(render("[auth]", { authors: ["Ada"], year: 1843, title: "Notes" })).toBe("Ada");
    // Only the FIRST author drives [auth].
    expect(
      render("[auth]", { authors: ["Lovelace, Ada", "Menabrea, Luigi"], year: 1843, title: "Notes" }),
    ).toBe("Lovelace");
    // No authors at all renders empty (not an error).
    expect(render("[auth]", { authors: [], year: 1843, title: "Notes" })).toBe("");
  });

  it("[auth:lower] lowercases and ASCII-folds the family", () => {
    expect(render("[auth:lower]", { authors: ["Müller, Jörg"], year: 2001, title: "T" })).toBe(
      "muller",
    );
    expect(render("[auth:lower]", { authors: ["Lovelace, Ada"], year: 1843, title: "Notes" })).toBe(
      "lovelace",
    );
  });

  it("[year] renders the year; an unknown year renders empty", () => {
    expect(render("[auth:lower][year]", SAMPLE)).toBe("lovelace1843");
    expect(render("[year]", { authors: [], year: null, title: "T" })).toBe("");
    expect(render("[year]", { authors: [], year: "2024", title: "T" })).toBe("2024");
  });

  it("[title] joins every word; punctuation inside a word is dropped", () => {
    expect(render("[title]", SAMPLE)).toBe("NotesontheAnalyticalEngine");
    expect(render("[title]", { authors: [], year: null, title: "Notes, on the engine!" })).toBe(
      "Notesontheengine",
    );
  });

  it("[title:lower] folds the whole title; [title:lower:N] keeps the first N words", () => {
    expect(render("[title:lower]", SAMPLE)).toBe("notesontheanalyticalengine");
    expect(render("[title:lower:1]", SAMPLE)).toBe("notes");
    expect(render("[title:lower:3]", SAMPLE)).toBe("notesonthe");
    expect(render("[title:2]", SAMPLE)).toBe("Noteson");
    // N larger than the word count renders what exists.
    expect(render("[title:lower:100]", SAMPLE)).toBe("notesontheanalyticalengine");
  });

  it("literals pass through between tokens", () => {
    expect(render("[auth:lower]_[year]_[title:lower:2]", SAMPLE)).toBe("lovelace_1843_noteson");
    expect(render("key-[year]", SAMPLE)).toBe("key-1843");
    expect(render("", SAMPLE)).toBe("");
  });

  it("rejects unknown tokens, modifiers, and malformed word counts", () => {
    expect(errorOf("[foo]")).toMatch(/Unknown token/);
    expect(errorOf("[auth:upper]")).toMatch(/Unknown modifier/);
    expect(errorOf("[year:lower]")).toMatch(/does not take a modifier/);
    expect(errorOf("[auth:3]")).toMatch(/does not take a word count/);
    expect(errorOf("[title:lower:zero]")).toMatch(/Invalid modifier/);
    expect(errorOf("[title:0]")).toMatch(/at least 1/);
    expect(errorOf("[title:lower:3:4]")).toMatch(/Invalid token/);
    expect(errorOf("[]")).toMatch(/Invalid token/);
  });

  it("rejects unbalanced brackets", () => {
    expect(errorOf("[auth")).toMatch(/Unbalanced "\["/);
    expect(errorOf("auth]")).toMatch(/Unbalanced "\]"/);
    expect(errorOf("[auth][year")).toMatch(/Unbalanced "\["/);
  });

  it("renderCitekeyPattern returns null for an invalid pattern", () => {
    expect(renderCitekeyPattern(DEFAULT_CITEKEY_PATTERN, SAMPLE)).toBe("lovelace1843notesonthe");
    expect(renderCitekeyPattern("[nope]", SAMPLE)).toBeNull();
  });
});
