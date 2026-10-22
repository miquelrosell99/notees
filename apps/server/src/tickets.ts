/**
 * WebSocket admission tickets (WIRE.md): a browser cannot set headers on a
 * WebSocket upgrade, so instead of putting the bearer credential in the WS
 * URL (it lands in every proxy/access/error log), the client mints a
 * short-lived, single-use ticket over authenticated POST /tickets and rides
 * it on the socket URL. A ticket is bound to one workspace and one principal
 * (both fixed at mint time), is valid for `ttlMs` (60 s), and dies on first
 * use — so a logged WS URL exposes nothing beyond seconds of read access to
 * one workspace. In-memory by design: a restart invalidates pending tickets
 * and clients simply re-mint.
 */

import { createHash, randomBytes } from "node:crypto";

import type { Principal } from "./identity.js";
import { AppError } from "./errors.js";

export const DEFAULT_WS_TICKET_TTL_MS = 60_000;

interface TicketEntry {
  principal: Principal;
  workspaceId: string;
  expiresAt: number;
}

export class TicketStore {
  private readonly byDigest = new Map<string, TicketEntry>();

  constructor(private readonly ttlMs = DEFAULT_WS_TICKET_TTL_MS) {}

  /** Mint a ticket for a principal already authorized for the workspace. */
  mint(principal: Principal, workspaceId: string): { ticket: string; expiresAt: number } {
    this.sweep();
    const ticket = `ntk_${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + this.ttlMs;
    this.byDigest.set(digest(ticket), { principal, workspaceId, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * Consume a ticket: single-use (deleted before validation completes) and
   * workspace-bound. Every failure is the same 401 `invalid_ticket` —
   * unknown, expired, or wrong-workspace tickets are indistinguishable.
   */
  consume(ticket: string, workspaceId: string): Principal {
    const key = digest(ticket);
    const entry = this.byDigest.get(key);
    this.byDigest.delete(key);
    if (
      entry === undefined ||
      entry.workspaceId !== workspaceId ||
      entry.expiresAt <= Date.now()
    ) {
      throw new AppError(401, "invalid_ticket", "unknown, expired, or wrong-workspace ticket");
    }
    return entry.principal;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.byDigest) {
      if (entry.expiresAt <= now) this.byDigest.delete(key);
    }
  }
}

function digest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}
