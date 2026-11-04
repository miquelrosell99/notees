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
import { PluginRegistry } from "./routes-plugins.js";
import { ResolveCache } from "./resolve-source.js";
import { seedWorkspace, type SeedResult } from "./seed.js";
import { ShareStorage } from "./shares.js";
import { SubscriptionBus } from "./bus.js";
import { TicketStore } from "./tickets.js";
import { WorkflowStorage } from "./workflows.js";
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
  /** The inert plugin-manifest registry (runtime parked). */
  readonly plugins: PluginRegistry;
  /** Read-only public share tokens (server coordination). */
  readonly shares: ShareStorage;
  /**
   * The metadata-resolver cache (GET /api/resolve egress): normalized
   * identifier → unified record, 24 h TTL. Server state, not log state
   * (the prefs/shares/plugins ruling) — the cache never changes the answer
   * a fresh fetch would give, it only avoids repeating the egress.
   */
  readonly resolverCache: ResolveCache;
  /**
   * Workflow rules + run audit (issue #13, server coordination state like
   * prefs/shares/plugins). The engine evaluates every ingest; its action
   * envelopes are ordinary ops by a server actor (client "rules-engine").
   */
  readonly workflows: WorkflowStorage;
  readonly lockout: AccountLockout;
  readonly workspaces: WorkspaceManager;
  readonly factory: EnvelopeFactory;
  readonly bus: SubscriptionBus;
  readonly limiters: {
    relayBatch: FixedWindowLimiter;
    global: FixedWindowLimiter;
    login: FixedWindowLimiter;
  };
  /** Idempotency-Key → first-successful-response replay store. */
  readonly idempotency: IdempotencyStore;
  /** Short-lived single-use WS admission tickets (WIRE.md §2). */
  readonly tickets: TicketStore;
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
    this.plugins = new PluginRegistry(`${config.dataDir}/relay.db`);
    this.shares = new ShareStorage(`${config.dataDir}/relay.db`);
    this.resolverCache = new ResolveCache(`${config.dataDir}/relay.db`);
    this.lockout = new AccountLockout();
    // Seed the device clock from the log so server-stamped HLCs never regress
    // across restarts.
    this.clock = new Clock("notees-server", this.relay.globalMaxHlc());
    this.workspaces = new WorkspaceManager(this.relay, `${config.dataDir}/derived`);
    this.factory = new EnvelopeFactory(this.clock, this.actorId);
    // Plan 07: rule STORAGE stays (coordination data — CRUD + run audit),
    // but post-ingest probe evaluation retires: the server serves no content
    // reads, and criteria probes were derived-store reads. Client-side
    // evaluation is recorded debt (no web rule shapes exist to port — the
    // fallback ruling).
    this.workflows = new WorkflowStorage(`${config.dataDir}/relay.db`);
    this.bus = new SubscriptionBus();
    this.limiters = {
      relayBatch: new FixedWindowLimiter(),
      global: new FixedWindowLimiter(),
      login: new FixedWindowLimiter(),
    };
    this.idempotency = new IdempotencyStore();
    this.tickets = new TicketStore(config.wsTicketTtlMs);
    this.defaultWorkspace = defaultWorkspaceId();
    void hashPassword(randomBytesForDummy()).then((hash) => {
      this.dummyPasswordHash = hash;
    });
  }

  /**
   * The one write path: persist to the relay log, apply to the derived store,
   * broadcast to WS subscribers. (Plan 07: workflow probes retired — rules
   * are storage-only until the client-side evaluator lands.)
   * `envelopes` may span workspaces (grouped here); per-workspace rate
   * accounting is charged per envelope on client-authorized ingests only.
   */
  async ingestBatch(envelopes: Envelope[]): Promise<IngestOutcome> {
    return this.ingestInternal(envelopes);
  }

  private async ingestInternal(envelopes: Envelope[]): Promise<IngestOutcome> {
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
    // E2EE seed shim: a workspace with a workspace_key row is CLIENT-seeded
    // (the client stamps the system seeds from its own device and pushes
    // them, encrypted, through the boundary). The server must never write
    // plaintext seeds into a keyed workspace — the gate is the row itself,
    // checked before isEmpty. Keyless workspaces keep the server shim that
    // GTK/Flutter/CLI rely on.
    if (this.auth.getWorkspaceKey(workspaceId) !== undefined) {
      return Promise.resolve({ seededCount: 0 });
    }
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
    this.plugins.close();
    this.shares.close();
    this.resolverCache.close();
    this.workflows.close();
    this.auth.close();
    this.relay.close();
  }
}

function randomBytesForDummy(): string {
  return randomBytes(24).toString("base64url");
}
