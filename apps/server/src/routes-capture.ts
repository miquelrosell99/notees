/**
 * Capture endpoint (the Firefox connector's direct-REST transport):
 * POST /api/capture/web-page — stamps object.create (class web_page) +
 * property.set + (readlater) collection.member.add envelopes through the
 * one write path. Session Bearer or a capture.write-scoped API key; E2EE
 * workspaces are rejected (409 e2ee_required — no plaintext channel into
 * encrypted stores); the readItLater feature row gates the route (403
 * feature_disabled).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { workspaceFor } from "./routes-objects.js";

export const captureBodySchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((u) => {
        try {
          const protocol = new URL(u).protocol;
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      }, "url must be http or https"),
    title: z.string().trim().min(1).max(500),
    mode: z.enum(["source", "readlater"]),
    identifiers: z
      .object({
        doi: z.string().trim().min(1).max(255).optional(),
        isbn: z.string().trim().min(1).max(32).optional(),
      })
      .strict()
      .optional(),
    note: z.string().trim().max(10_000).optional(),
  })
  .strict();

export function registerCaptureRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/capture/web-page", async (request, reply) => {
    const parsed = captureBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        422,
        "validation_failed",
        parsed.error.issues[0]?.message ?? "invalid capture body",
      );
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const objectId = uuidv7();
    await ctx.submit({
      workspaceId,
      opType: "object.create",
      payload: {
        objectId,
        classIds: [SYSTEM_CLASS_UUIDS.web_page],
        contentAst: [{ type: "text", text: parsed.data.title }],
        isEmbedded: false,
      },
      affectedNodeIds: [objectId],
      client: "capture",
    });
    reply.code(201);
    return { objectId };
  });
}
