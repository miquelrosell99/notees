/**
 * Content grammar — flat token stream (normative: SCHEMA.md "Content grammar").
 *
 * A block node's content is ONE flat, ordered token array. There are no
 * block-level "segments": paragraph spacing, quotes, queries, whiteboards,
 * assets, and embeds are all TOKENS in the same stream. Block-scale tokens
 * (query/whiteboard/asset_ref/embed_ref) render inline-scale or full-width
 * island as a display decision. The design law applies: nothing in the grammar
 * prohibits where a token may appear; rendering defines presentation.
 *
 * Storage: the array serializes to JSON inside the block's per-node Y.Text
 * CRDT (v1 port — canonical wire carrier contentDeltaB64; contentAst is the
 * readable carrier). Plaintext for FTS is derived by the applier, never stored
 * as truth.
 */

import { z } from "zod";

import { queryAstSchema } from "./query-ast.js";

const uuid = z.string().uuid();

export const MARKS = ["bold", "italic", "strike", "highlight", "code"] as const;
export type Mark = (typeof MARKS)[number];

/** Free verb, or bound to a property schema (create-and-bind gesture). */
export const typedLinkVerbSchema = z.union([
  z.string().min(1).max(128),
  z.object({ propertySchemaId: uuid }).strict(),
]);

export const typedLinkMarkSchema = z
  .object({
    type: z.literal("typed_link"),
    verb: typedLinkVerbSchema,
    /** The marked word exactly as written. */
    text: z.string().min(1),
    metadata: z
      .object({
        /** e.g. PDF page/section, auto-filled from the current selection. */
        locator: z.string().max(1024).optional(),
        /** Ordered nearest-first token IDs — RECORD, DON'T RESOLVE. */
        candidateSpans: z.array(z.string().min(1)).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const mentionTokenSchema = z
  .object({
    type: z.literal("mention"),
    targetNodeId: uuid,
    /** Captured surface text (non-authoritative; display resolves the target name). */
    text: z.string().min(1),
    /** One-off display override ("the Republic"). Auto-rename does not apply to overrides. */
    displayText: z.string().min(1).max(512).optional(),
    /** Stable per-link instance id (node_link assertion key: origin, target,
     * created, click/access times — owner-requested link analytics). */
    linkId: uuid.optional(),
  })
  .strict();

/**
 * Class chip — RENDER-ONLY reference to a class node (owner decision,
 * 2026-09-25): inserting or deleting a chip does NOT mutate the block's
 * class_ids. Assignment is a separate gesture; a lint may suggest it.
 */
export const classChipTokenSchema = z
  .object({
    type: z.literal("class_chip"),
    classId: uuid,
    /** Optional one-off wording; default renders the class's current name. */
    displayText: z.string().min(1).max(512).optional(),
  })
  .strict();

export const textTokenSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    marks: z.array(z.enum(MARKS)).optional(),
  })
  .strict();

export const externalLinkTokenSchema = z
  .object({
    type: z.literal("external_link"),
    href: z.string().min(1).max(4096),
    text: z.string().min(1),
  })
  .strict();

export const mathTokenSchema = z
  .object({
    type: z.literal("math"),
    expression: z.string().min(1).max(4096),
  })
  .strict();

export const hardBreakTokenSchema = z
  .object({ type: z.literal("hard_break") })
  .strict();

export const assetRefTokenSchema = z
  .object({
    type: z.literal("asset_ref"),
    assetId: uuid,
  })
  .strict();

/**
 * Embed — RENDER THE LIVE SUBTREE, NEVER A CLONE: live updates and
 * editing-through-the-embed then ride the standard notification/op path.
 * Cycle guard (depth cap + visited set) is a renderer obligation.
 *
 * `view` (§34.34 B8, additive 2026-10-04) selects the presentation between
 * the two-point mention↔embed spectrum: absent (or the default "embed") =
 * the full live transclusion; "small_card" / "wide_card" = the intermediate
 * card references (a bounded card with the target's identity; navigation
 * rides the standard open gesture — cards never transclude). Unknown values
 * are rejected outright by the strict schema.
 */
export const EMBED_VIEW_MODES = ["embed", "small_card", "wide_card"] as const;
export type EmbedViewMode = (typeof EMBED_VIEW_MODES)[number];
export const embedViewModeSchema = z.enum(EMBED_VIEW_MODES);

export const embedRefTokenSchema = z
  .object({
    type: z.literal("embed_ref"),
    nodeId: uuid,
    view: embedViewModeSchema.optional(),
  })
  .strict();

/**
 * Block-scale: live query view. queryAst is the versioned QueryAST model
 * (local ./query-ast.ts — the AST lives in protocol because the content
 * grammar embeds it; @notees/query re-exports it). The union keeps it
 * loose-optional for forward compatibility: ASTs this build knows parse as
 * the real model; newer or foreign AST versions still apply as plain
 * records (the AST evolves by version, the content grammar must not reject
 * them).
 */
export const queryTokenSchema = z
  .object({
    type: z.literal("query"),
    queryAst: z.union([z.lazy(() => queryAstSchema), z.record(z.unknown())]),
    view: z.record(z.unknown()).optional(),
  })
  .strict();

/** Block-scale: whiteboard layout (shapes/strokes/viewport). */
export const whiteboardTokenSchema = z
  .object({
    type: z.literal("whiteboard"),
    layout: z.record(z.unknown()),
  })
  .strict();

/**
 * Block-scale: a code block (§34.34 B3). `text` is the verbatim source (the
 * grammar stores it plain — no nested tokens inside a code block);
 * `language` is an OPTIONAL hint tag (free lowercase string — "python",
 * "typescript", "mermaid", …) for renderers; absent = plain text. A
 * PROMOTION SURVIVOR alongside whiteboard/query: block→page/class promotion
 * stringifies rich tokens to text-only content but keeps code_block tokens
 * (a code page is a real surface — flattening would destroy the source).
 * Inline marks ("code") remain the inline-scale escape hatch; this token is
 * the block-scale one (v1 rendered class-`code` blocks; v2 carries the
 * language metadata the class could not).
 */
export const codeBlockTokenSchema = z
  .object({
    type: z.literal("code_block"),
    language: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9+#-]+$/, "language hint: lowercase letters, digits, +, #, -")
      .optional(),
    text: z.string().max(65536),
  })
  .strict();

/**
 * Block-scale: a horizontal rule (§34.34 B5) — the layout divider token.
 * Carries no payload. NOT a promotion survivor: an hr holds no prose, so
 * block→page promotion stringifies it away (a rule in a page title is
 * meaningless).
 */
export const hrTokenSchema = z.object({ type: z.literal("hr") }).strict();

/** The only nested token: a quote contains inline tokens (hard breaks allowed). */
export const quoteTokenSchema = z
  .object({
    type: z.literal("quote"),
    children: z.array(
      z.discriminatedUnion("type", [
        textTokenSchema,
        typedLinkMarkSchema,
        mentionTokenSchema,
        classChipTokenSchema,
        externalLinkTokenSchema,
        mathTokenSchema,
        hardBreakTokenSchema,
      ]),
    ),
  })
  .strict();

export const inlineTokenSchema = z.discriminatedUnion("type", [
  textTokenSchema,
  typedLinkMarkSchema,
  mentionTokenSchema,
  classChipTokenSchema,
  externalLinkTokenSchema,
  mathTokenSchema,
  hardBreakTokenSchema,
]);

export const contentTokenSchema = z.discriminatedUnion("type", [
  textTokenSchema,
  typedLinkMarkSchema,
  mentionTokenSchema,
  classChipTokenSchema,
  externalLinkTokenSchema,
  mathTokenSchema,
  hardBreakTokenSchema,
  assetRefTokenSchema,
  embedRefTokenSchema,
  queryTokenSchema,
  whiteboardTokenSchema,
  quoteTokenSchema,
  codeBlockTokenSchema,
  hrTokenSchema,
]);

export type InlineToken = z.infer<typeof inlineTokenSchema>;
export type ContentToken = z.infer<typeof contentTokenSchema>;
export type ContentAst = ContentToken[];

export const contentAstSchema = z.array(contentTokenSchema);

export function extractTypedLinkMarks(ast: ContentAst) {
  const marks: z.infer<typeof typedLinkMarkSchema>[] = [];
  for (const token of ast) {
    if (token.type === "typed_link") marks.push(token);
    else if (token.type === "quote") {
      for (const child of token.children) {
        if (child.type === "typed_link") marks.push(child);
      }
    }
  }
  return marks;
}
