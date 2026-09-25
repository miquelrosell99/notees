/**
 * Typed-link mark grammar — minimal normative shape (SCHEMA.md).
 *
 * A typed link is a mark on a prose word (01-knowledge-model.md §9): nothing is
 * inserted; the word you wrote is the annotation. Lifecycle is honest: delete
 * the word and the mark dies with it. Marks ride inside the CRDT-synchronized
 * AST text, so collaborative edits cannot orphan them.
 *
 * RECORD, DON'T RESOLVE: capture records candidate target spans as an ordered
 * list of token IDs — no scoring, no filtering. Target resolution is an M2
 * design question (deferred by owner decision); capture-time data hoarding is
 * cheap and the sentence context is irrecoverable later.
 */

import { z } from "zod";

const tokenId = z.string().min(1);

/** Free verb, or bound to a property schema (create-and-bind gesture). */
export const typedLinkVerbSchema = z.union([
  z.string().min(1).max(128),
  z.object({ propertySchemaId: z.string().uuid() }).strict(),
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
        candidateSpans: z.array(tokenId).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type TypedLinkMark = z.infer<typeof typedLinkMarkSchema>;

/** Plain prose word carrying a mention (edge-index source, layer 3). */
export const mentionTokenSchema = z
  .object({
    type: z.literal("mention"),
    /** Token ID resolved to a node by the applier when unambiguous. */
    targetNodeId: z.string().uuid(),
    text: z.string().min(1),
  })
  .strict();

export const inlineTokenSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  typedLinkMarkSchema,
  mentionTokenSchema,
]);

export const paragraphNodeSchema = z
  .object({
    type: z.literal("paragraph"),
    id: tokenId,
    children: z.array(inlineTokenSchema),
  })
  .strict();

export const contentAstSchema = z.array(z.discriminatedUnion("type", [paragraphNodeSchema]));

export type ContentAst = z.infer<typeof contentAstSchema>;

export function extractTypedLinkMarks(ast: ContentAst): TypedLinkMark[] {
  const marks: TypedLinkMark[] = [];
  for (const block of ast) {
    if (block.type !== "paragraph") continue;
    for (const child of block.children) {
      if (child.type === "typed_link") marks.push(child);
    }
  }
  return marks;
}
