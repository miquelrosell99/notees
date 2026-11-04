/**
 * Per-user UI prefs — ONE OPAQUE BLOB (plan 07).
 *
 * favorites/recents/cardsAlgorithm/adsApiToken are per-user UI state (never
 * op-log state), previously four server-interpreted columns. Plan 07
 * collapses them into a single opaque string the client owns:
 *
 *  - UNWRAPPED form: the JSON `{v:1, favorites, recents, cardsAlgorithm,
 *    adsApiToken}` — the keyless self-host compat shape; the server may read
 *    the ADS token out of it (the /resolve ADS arm, exactly as before).
 *  - WRAPPED form: `b64u(iv ‖ tag ‖ ct)` of that JSON, sealed with the
 *    account master key (`encryptBytes` in @notees/protocol) — opaque to the
 *    server. The web client unwraps after unlock; when wrapped, the caller
 *    passes the ADS credential explicitly via the `x-ads-api-token` header.
 *
 * The server stores/returns the blob verbatim (a 64 KiB cap bounds abuse;
 * the client enforces the list caps). Legacy four-column rows migrate to the
 * unwrapped blob at open (auth.ts constructor).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { requireUser } from "./routes-auth.js";

const MAX_PREFS_BLOB_BYTES = 64 * 1024;

const putPrefsBodySchema = z
  .object({ blob: z.string().max(MAX_PREFS_BLOB_BYTES, `prefs blob exceeds the ${MAX_PREFS_BLOB_BYTES}-byte cap`) })
  .strict();

/** The ADS credential out of an UNWRAPPED prefs blob (null when wrapped/absent). */
export function adsTokenOfPrefsBlob(blob: string): string | undefined {
  try {
    const parsed = JSON.parse(blob) as { adsApiToken?: unknown };
    return typeof parsed.adsApiToken === "string" && parsed.adsApiToken !== "" ? parsed.adsApiToken : undefined;
  } catch {
    return undefined; // wrapped — opaque to the server
  }
}

/** The ADS credential for a request: explicit header first, then the unwrapped blob. */
export function adsTokenFor(ctx: ServerContext, request: FastifyRequest): string | undefined {
  const header = request.headers["x-ads-api-token"];
  if (typeof header === "string" && header !== "") return header;
  const principal = requireUser(ctx, request);
  return adsTokenOfPrefsBlob(ctx.auth.getUserPrefs(principal.userId).blob);
}

export function registerPrefsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/me/prefs", async (request) => {
    const principal = requireUser(ctx, request);
    return ctx.auth.getUserPrefs(principal.userId);
  });

  app.put("/me/prefs", async (request) => {
    const principal = requireUser(ctx, request);
    const parsed = putPrefsBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(
        422,
        "validation_failed",
        parsed.error.issues[0]?.message ?? "invalid prefs request",
      );
    }
    return ctx.auth.updateUserPrefs(principal.userId, parsed.data.blob);
  });
}
