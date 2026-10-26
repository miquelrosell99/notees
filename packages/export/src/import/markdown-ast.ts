/**
 * Minimal markdown → content-AST converter — the inline subset the v1
 * "body as one child block" import needs: bold/italic/strike/highlight/code
 * marks, ATX headings as heading tokens, hard breaks between lines of a
 * paragraph, blank-line paragraph separation. External links stay literal
 * `[label](href)` text per the fleet `@notees/domain` markdownLinks
 * convention (the block row renders them as link pills).
 *
 * Deliberate limits (documented, not silent): no delimiter-run ambiguity
 * resolution (same-character openers/closers like `*…*` inside `**…**` may
 * parse flatter than CommonMark), no fenced code blocks, no HTML, no
 * setext headings, no lists — those lines pass through as text.
 */

import type { ContentAst, InlineToken, Mark } from "@notees/protocol";

const MARKERS: { token: string; mark: Mark }[] = [
  { token: "**", mark: "bold" },
  { token: "__", mark: "bold" },
  { token: "~~", mark: "strike" },
  { token: "==", mark: "highlight" },
  { token: "`", mark: "code" },
  { token: "*", mark: "italic" },
  { token: "_", mark: "italic" },
];

function findEarliestMarker(text: string): { index: number; token: string; mark: Mark } | null {
  for (let i = 0; i < text.length; i++) {
    for (const m of MARKERS) {
      if (text.startsWith(m.token, i)) {
        // `**` must not be misread at the tail of a longer run scan — the
        // marker list is longest-first, so `**` wins over `*` at one index.
        return { index: i, token: m.token, mark: m.mark };
      }
    }
  }
  return null;
}

function pushText(out: InlineToken[], text: string, marks: Mark[]): void {
  if (text === "") return;
  out.push(marks.length === 0 ? { type: "text", text } : { type: "text", text, marks: [...marks] });
}

function parseInlineInto(text: string, marks: Mark[], out: InlineToken[]): void {
  const found = findEarliestMarker(text);
  if (!found) {
    pushText(out, text, marks);
    return;
  }
  pushText(out, text.slice(0, found.index), marks);
  const rest = text.slice(found.index + found.token.length);
  const close = rest.indexOf(found.token);
  if (close === -1) {
    // Unmatched opener — literal, keep scanning after it.
    pushText(out, found.token, marks);
    parseInlineInto(rest, marks, out);
    return;
  }
  const innerMarks = marks.includes(found.mark) ? marks : [...marks, found.mark];
  parseInlineInto(rest.slice(0, close), innerMarks, out);
  parseInlineInto(rest.slice(close + found.token.length), marks, out);
}

/** Convert one inline markdown string to a flat token array. */
export function markdownInlineToAst(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  parseInlineInto(text, [], out);
  // Merge adjacent text tokens carrying equal marks (unmatched markers and
  // inter-marker prose otherwise fragment into separate tokens).
  const merged: InlineToken[] = [];
  for (const token of out) {
    const prev = merged[merged.length - 1];
    if (
      token.type === "text" &&
      prev &&
      prev.type === "text" &&
      JSON.stringify(prev.marks ?? null) === JSON.stringify(token.marks ?? null)
    ) {
      prev.text += token.text;
      continue;
    }
    merged.push(token);
  }
  return merged;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;

/**
 * Convert a markdown body to a block content token stream: ATX heading lines
 * become heading tokens, runs of non-empty lines become paragraphs with
 * hard breaks between lines, blank lines separate paragraphs.
 */
export function markdownBlockAst(markdown: string): ContentAst {
  const out: ContentAst = [];
  const lines = markdown.split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    for (let i = 0; i < paragraph.length; i++) {
      if (i > 0) out.push({ type: "hard_break" });
      out.push(...markdownInlineToAst(paragraph[i]!));
    }
    paragraph = [];
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      out.push({ type: "heading", children: markdownInlineToAst(heading[2]!) });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return out;
}
