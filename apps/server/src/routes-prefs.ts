/**
 * Per-user UI preferences — favorites & recents (owner ruling
 * 2026-10-04).
 *
 *  - GET /api/me/prefs   the authenticated account's prefs
 *                        ({favorites, recents, updatedAt});
 *  - PUT /api/me/prefs   merge-patch: each present list REPLACES its column
 *                        (the client owns ordering; last write wins per list).
 *
 * Why this is not in the operation log: the design law "device state is
 * never an op" stands. Favorites/recents are UI preferences, so they live in
 * the sync server's per-user prefs store (the user_prefs table in relay.db,
 * additive migration in auth.ts) — every client's derived DB semantics stay
 * untouched, and no op/wire change is needed (no lockstep).
 *
 * Auth: any user principal — an account session OR a per-user API key (the
 * owner of the key); the operator API key is not a user and gets 401. The
 * body is validated fail-loud: uuid-shaped node ids only, capped lengths
 * (favorites ≤ MAX_FAVORITES, recents ≤ MAX_RECENTS, both applied AFTER
 * order-preserving dedupe), at least one list required.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { requireUser } from "./routes-auth.js";

export const MAX_FAVORITE_PREFS = 500;
export const MAX_RECENT_PREFS = 50;

const idListSchema = (max: number, label: string) =>
  z
    .array(z.string().uuid())
    .max(max, `${label} exceeds the ${max}-entry cap`)
    .transform((list) => [...new Set(list)]);

const putPrefsBodySchema = z
  .object({
    favorites: idListSchema(MAX_FAVORITE_PREFS, "favorites").optional(),
    recents: idListSchema(MAX_RECENT_PREFS, "recents").optional(),
  })
  .strict()
  .refine((body) => body.favorites !== undefined || body.recents !== undefined, {
    message: "at least one of favorites/recents is required",
  });

export function registerPrefsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/me/prefs", async (request) => {
    const principal = requireUser(ctx, request);
    return ctx.auth.getUserPrefs(principal.userId);
  });

  app.put("/me/prefs", async (request) => {
    const principal = requireUser(ctx, request);
    const parsed = putPrefsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        422,
        "validation_failed",
        parsed.error.issues[0]?.message ?? "invalid prefs request",
      );
    }
    return ctx.auth.updateUserPrefs(principal.userId, parsed.data);
  });
}
