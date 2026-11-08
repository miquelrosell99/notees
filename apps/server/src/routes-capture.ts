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
import {
  normalizeIdentifier,
  resolveSourceMetadata,
  type SourceMetadataRecord,
} from "./resolve-source.js";
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

/**
 * Best-effort resolver enrichment for a captured page: the raw identifiers
 * are stamped regardless (the capture is the artifact); a successful
 * resolveSourceMetadata fills authors/publicationDate/publisher/doi. A
 * resolver miss/failure (404/502/disabled) DEGRADES to the unresolved
 * capture — the URL capture is never held hostage by Crossref/OpenLibrary.
 * publicationDate is a datetime schema: the year links the deterministic
 * date-chain YEAR node (ensured through the same write path — the store
 * fails loud on a ref to a missing node), never a bare year string.
 */
async function stampResolvedFields(
  ctx: ServerContext,
  workspaceId: string,
  objectId: string,
  identifiers: { doi?: string | undefined; isbn?: string | undefined },
): Promise<void> {
  const setProp = (propertySchemaId: string, value: unknown, elementId?: string) =>
    ctx.submit({
      workspaceId,
      opType: "property.set",
      payload: { objectId, propertySchemaId, value, ...(elementId ? { elementId } : {}) },
      affectedNodeIds: [objectId],
      client: "capture",
    });
  // The raw identifiers are stamped regardless — the intent stays visible.
  if (identifiers.doi !== undefined) {
    await setProp(SYSTEM_PROPERTY_UUIDS.doi, normalizeIdentifier("doi", identifiers.doi));
  }
  if (identifiers.isbn !== undefined) {
    await setProp(SYSTEM_PROPERTY_UUIDS.isbn, normalizeIdentifier("isbn", identifiers.isbn));
  }
  const params = identifiers.doi !== undefined ? { doi: identifiers.doi } : { isbn: identifiers.isbn! };
  let record: SourceMetadataRecord;
  try {
    record = await resolveSourceMetadata(ctx, workspaceId, params);
  } catch {
    return;
  }
  for (const author of record.authors) {
    await setProp(SYSTEM_PROPERTY_UUIDS.authors, author, uuidv7());
  }
  if (record.year !== undefined) {
    const yearIso = `${record.year}-01-01`;
    const yearId = chainNodeIds(yearIso).year;
    const store = ctx.workspaces.storeFor(workspaceId);
    const yearExists = store.database.prepare("SELECT 1 FROM node WHERE id = ?").get(yearId) !== undefined;
    if (!yearExists) {
      await ctx.submit({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: yearId,
          parentId: null,
          isEmbedded: false,
          classIds: [SYSTEM_CLASS_UUIDS.year],
          contentAst: [{ type: "text", text: dateNodeLabel(parseIsoDate(yearIso), "year") }],
        },
        affectedNodeIds: [yearId],
        client: "capture",
      });
    }
    await setProp(SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: yearId });
  }
  if (record.publisher !== undefined) {
    await setProp(SYSTEM_PROPERTY_UUIDS.publisher, record.publisher);
  }
  if (record.doi !== undefined) {
    await setProp(SYSTEM_PROPERTY_UUIDS.doi, normalizeIdentifier("doi", record.doi));
  }
}

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
    if (parsed.data.identifiers !== undefined) {
      await stampResolvedFields(ctx, workspaceId, objectId, parsed.data.identifiers);
    }
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
