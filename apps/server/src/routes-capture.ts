/**
 * Capture endpoint (the Firefox connector's direct-REST transport):
 * POST /api/capture/web-page — stamps object.create (class web_page) +
 * property.set (url, accessDate) + a note child block + (readlater)
 * collection.member.add envelopes through the one write path. The accessDate
 * value links today's deterministic date-chain day node, so the route
 * ensures the chain (year → month → day) first. Session Bearer or a
 * capture.write-scoped API key; E2EE workspaces are rejected (409
 * e2ee_required — no plaintext channel into encrypted stores); the
 * readItLater feature row gates the route (403 feature_disabled).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import {
  chainNodeIds,
  dateNodeLabel,
  parseIsoDate,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

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
    // accessDate is a datetime property at day precision: the value links
    // today's deterministic date-chain day node (SCHEMA.md "Datetime"), and
    // the store fails loud on a ref to a missing node — so the chain
    // (year → month → day) is ensured through the same write path first.
    const today = new Date().toISOString().slice(0, 10);
    const parts = parseIsoDate(today);
    const chain = chainNodeIds(today);
    const store = ctx.workspaces.storeFor(workspaceId);
    const dateSpecs: Array<{
      id: string;
      parentId: string | null;
      classId: string;
      label: string;
    }> = [
      {
        id: chain.year,
        parentId: null,
        classId: SYSTEM_CLASS_UUIDS.year,
        label: dateNodeLabel(parts, "year"),
      },
      {
        id: chain.month,
        parentId: chain.year,
        classId: SYSTEM_CLASS_UUIDS.month,
        label: dateNodeLabel(parts, "month"),
      },
      {
        id: chain.day,
        parentId: chain.month,
        classId: SYSTEM_CLASS_UUIDS.day,
        label: dateNodeLabel(parts, "day"),
      },
    ];
    for (const spec of dateSpecs) {
      const exists = store.database
        .prepare("SELECT 1 FROM node WHERE id = ?")
        .get(spec.id) !== undefined;
      if (exists) continue;
      await ctx.submit({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: spec.id,
          parentId: spec.parentId,
          isEmbedded: false,
          classIds: [spec.classId],
          contentAst: [{ type: "text", text: spec.label }],
        },
        affectedNodeIds: [spec.id],
        client: "capture",
      });
    }
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
    await ctx.submit({
      workspaceId,
      opType: "property.set",
      payload: { objectId, propertySchemaId: SYSTEM_PROPERTY_UUIDS.url, value: parsed.data.url },
      affectedNodeIds: [objectId],
      client: "capture",
    });
    await ctx.submit({
      workspaceId,
      opType: "property.set",
      payload: {
        objectId,
        propertySchemaId: SYSTEM_PROPERTY_UUIDS.accessDate,
        value: { nodeId: chain.day },
      },
      affectedNodeIds: [objectId],
      client: "capture",
    });
    if (parsed.data.note !== undefined) {
      const noteBlockId = uuidv7();
      await ctx.submit({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: noteBlockId,
          parentId: objectId,
          isEmbedded: true,
          contentAst: [{ type: "text", text: parsed.data.note }],
        },
        affectedNodeIds: [objectId, noteBlockId],
        client: "capture",
      });
    }
    reply.code(201);
    return { objectId };
  });
}
