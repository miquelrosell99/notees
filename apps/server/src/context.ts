/**
 * Server context: the single object every route/plugin shares — config,
 * relay log, workspace stores, the envelope factory, the WS bus, and the
 * rate limiters. All writes flow through `ingestBatch` (relay /batch, WS
 * batch frames, and the object/assets API share this one path).
 */

import { randomBytes } from "node:crypto";

import { Clock } from "@notees/protocol";
import type { Envelope } from "@notees/protocol";

import type { ServerConfig } from "./config.js";
import { actorIdForKey, defaultWorkspaceId } from "./identity.js";
import { AuthStorage, AccountLockout, hashPassword } from "./auth.js";
import { EnvelopeFactory } from "./envelope-factory.js";
import { AppError } from "./errors.js";
import { IdempotencyStore } from "./idempotency.js";
import { FixedWindowLimiter } from "./rate-limit.js";
import { RelayStorage } from "./relay-storage.js";
import { seedWorkspace, type SeedResult } from "./seed.js";
import { SubscriptionBus } from "./bus.js";
import { WorkspaceManager } from "./workspace-store.js";

export interface IngestOutcome {
  savedIds: string[];
  seqs: Record<string, number>;
}

export class ServerContext {
  readonly actorId: string;
  readonly clock: Clock;
  readonly relay: RelayStorage;
  readonly auth: AuthStorage;
  readonly lockout: AccountLockout;
  readonly workspaces: WorkspaceManager;
  readonly factory: EnvelopeFactory;
  readonly bus: SubscriptionBus;
  readonly limiters: {
    relayBatch: FixedWindowLimiter;
    global: FixedWindowLimiter;
    login: FixedWindowLimiter;
  };
  /** §34.33 AG5: Idempotency-Key → first-successful-response replay store. */
  readonly idempotency: IdempotencyStore;
  readonly defaultWorkspace: string;
  readonly serverVersion: string;
  /**
   * Hash of a random unreachable password: the login endpoint verifies
   * against it when the email is unknown so response time reveals nothing.
   */
  dummyPasswordHash = "";

  private readonly seededWorkspaces = new Set<string>();
  private readonly seedingInFlight = new Map<string, Promise<SeedResult>>();

  constructor(readonly config: ServerConfig, serverVersion = "dev") {
    this.actorId = actorIdForKey(config.apiKey);
    this.serverVersion = serverVersion;
    this.relay = new RelayStorage(
      `${config.dataDir}/relay.db`,
      `${config.dataDir}/snapshots`,
    );
    this.auth = new AuthStorage(`${config.dataDir}/relay.db`);
    this.lockout = new AccountLockout();
    // Seed the device clock from the log so server-stamped HLCs never regress
    // across restarts.
    this.clock = new Clock("notees-server", this.relay.globalMaxHlc());
    this.workspaces = new WorkspaceManager(this.relay, `${config.dataDir}/derived`);
    this.factory = new EnvelopeFactory(this.clock, this.actorId);
    this.bus = new SubscriptionBus();
    this.limiters = {
      relayBatch: new FixedWindowLimiter(),
      global: new FixedWindowLimiter(),
      login: new FixedWindowLimiter(),
    };
    this.idempotency = new IdempotencyStore();
    this.defaultWorkspace = defaultWorkspaceId();
    void hashPassword(randomBytesForDummy()).then((hash) => {
      this.dummyPasswordHash = hash;
    });
  }

  /**
   * The one write path: persist to the relay log, apply to the derived store,
   * broadcast to WS subscribers. `envelopes` may span workspaces (grouped
   * here); per-workspace rate accounting is charged per envelope (v1).
   */
  async ingestBatch(envelopes: Envelope[]): Promise<IngestOutcome> {
    const groups = new Map<string, Envelope[]>();
    for (const env of envelopes) {
      const group = groups.get(env.workspaceId);
      if (group !== undefined) group.push(env);
      else groups.set(env.workspaceId, [env]);
    }
    const savedIds: string[] = [];
    const seqs: Record<string, number> = {};
    for (const [workspaceId, group] of groups) {
      if (
        !this.limiters.relayBatch.tryAcquire(
          `relay:batch:${workspaceId}`,
          group.length,
          this.config.relayBatchPerMinute,
        )
      ) {
        throw new AppError(
          429,
          "rate_limited",
          `relay batch rate limit exceeded (${this.config.relayBatchPerMinute} envelopes/min/workspace)`,
        );
      }
      const outcome = await this.workspaces.apply(workspaceId, group);
      if (outcome.savedIds.length > 0) {
        const committedById = new Set(outcome.savedIds);
        const committed = group.filter((env) => committedById.has(env.id));
        this.bus.broadcast(
          workspaceId,
          JSON.stringify({
            type: "ops",
            wsProtocolVersion: 2,
            envelopes: committed,
            seqs: outcome.seqs,
          }),
        );
        savedIds.push(...outcome.savedIds);
        Object.assign(seqs, outcome.seqs);
      }
    }
    return { savedIds, seqs };
  }

  /** Stamp a server-side envelope and push it through the one write path. */
  async submit(input: {
    workspaceId: string;
    opType: string;
    payload: Record<string, unknown>;
    affectedNodeIds?: string[];
    client?: string;
  }): Promise<{ envelope: Envelope; outcome: IngestOutcome }> {
    const envelope = this.factory.make(input);
    const outcome = await this.ingestBatch([envelope]);
    return { envelope, outcome };
  }

  /** First-open seeding of a workspace (system classes/properties/pages). */
  ensureSeeded(workspaceId: string): Promise<SeedResult> {
    if (this.seededWorkspaces.has(workspaceId)) {
      return Promise.resolve({ seededCount: 0 });
    }
    let pending = this.seedingInFlight.get(workspaceId);
    if (pending === undefined) {
      pending = seedWorkspace(
        {
          factory: this.factory,
          apply: (ws, envelopes) => this.workspaces.apply(ws, envelopes),
          isEmpty: (ws) => {
            if (this.relay.envelopeCount(ws) > 0) return false;
            const store = this.workspaces.storeFor(ws);
            const row = store.database.prepare("SELECT COUNT(*) AS n FROM node").get() as {
              n: number;
            };
            return row.n === 0;
          },
        },
        workspaceId,
      ).finally(() => {
        this.seededWorkspaces.add(workspaceId);
        this.seedingInFlight.delete(workspaceId);
      });
      this.seedingInFlight.set(workspaceId, pending);
    }
    return pending;
  }

  async close(): Promise<void> {
    await this.workspaces.close();
    this.auth.close();
    this.relay.close();
  }
}

function randomBytesForDummy(): string {
  return randomBytes(24).toString("base64url");
}
