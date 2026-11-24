/**
 * Calendar subscription routes (one-way iCal subscribe — the module doc in
 * calendar-subscriptions.ts owns the semantics):
 *
 *  - POST   /api/calendars            {workspaceId, url, name?, timezone?, refreshMinutes?}
 *                                     → {subscription, status} — adds the row and
 *                                     runs the first refresh inline (owner/admin only);
 *  - GET    /api/calendars?workspaceId= → {subscriptions} (owner/admin only);
 *  - POST   /api/calendars/:id/refresh  → {subscription, status} (owner/admin only);
 *  - DELETE /api/calendars/:id          → {ok} — removes the poller row; ingested
 *                                     events STAY (ordinary graph content).
 *
 * AuthZ mirrors the shares gate: the operator API key, admin users, and
 * owner-role members. E2EE workspaces are rejected (409 e2ee_required — the
 * server holds no plaintext channel into a keyed store, the capture
 * precedent). The URL must be http(s); fetching it is the feature (the
 * owner subscribing to their own LAN Nextcloud is the primary case), so no
 * egress allowlist beyond the scheme check — documented in docs/api.md.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import {
  isValidTimeZone,
  refreshSubscription,
  type CalendarSubscriptionRow,
} from "./calendar-subscriptions.js";
import { requireShareAdmin } from "./routes-shares.js";

const createBodySchema = z
  .object({
    workspaceId: z.string().uuid(),
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
    name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    refreshMinutes: z.number().int().min(15).max(24 * 60).optional(),
  })
  .strict();

function refuseKeyed(ctx: ServerContext, workspaceId: string): void {
  if (ctx.auth.getWorkspaceKey(workspaceId) !== undefined) {
    throw new AppError(
      409,
      "e2ee_required",
      "calendar subscriptions need a plaintext workspace — the server cannot write into an encrypted store",
    );
  }
}

function subscriptionFor(ctx: ServerContext, id: string): CalendarSubscriptionRow {
  const row = ctx.calendars.get(id);
  if (row === undefined) throw new AppError(404, "not_found", "calendar subscription not found");
  return row;
}

/** The wire shape (camelCase, no internal bookkeeping surprises). */
function present(row: CalendarSubscriptionRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    name: row.name,
    timezone: row.timezone,
    refreshMinutes: row.refreshMinutes,
    lastFetchedAt: row.lastFetchedAt,
    lastStatus: row.lastStatus,
    createdAt: row.createdAt,
  };
}

export function registerCalendarRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/calendars", async (request) => {
    requireShareAdmin(ctx, request as FastifyRequest);
    const body = createBodySchema.parse(request.body);
    refuseKeyed(ctx, body.workspaceId);
    const timezone = body.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!isValidTimeZone(timezone)) {
      throw new AppError(422, "invalid_timezone", `"${timezone}" is not an IANA timezone`);
    }
    const row = ctx.calendars.create({
      id: uuidv7(),
      workspaceId: body.workspaceId,
      url: body.url,
      name: body.name ?? new URL(body.url).hostname,
      timezone,
      refreshMinutes: body.refreshMinutes ?? 60,
    });
    const status = await refreshSubscription(ctx, row);
    return { subscription: present(ctx.calendars.get(row.id)!), status };
  });

  app.get("/calendars", async (request) => {
    requireShareAdmin(ctx, request as FastifyRequest);
    const query = z.object({ workspaceId: z.string().uuid() }).parse(request.query);
    return { subscriptions: ctx.calendars.list(query.workspaceId).map(present) };
  });

  app.post("/calendars/:id/refresh", async (request) => {
    requireShareAdmin(ctx, request as FastifyRequest);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = subscriptionFor(ctx, id);
    refuseKeyed(ctx, row.workspaceId);
    const status = await refreshSubscription(ctx, row);
    return { subscription: present(ctx.calendars.get(id)!), status };
  });

  app.delete("/calendars/:id", async (request) => {
    requireShareAdmin(ctx, request as FastifyRequest);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    subscriptionFor(ctx, id);
    ctx.calendars.delete(id);
    return { ok: true };
  });
}
