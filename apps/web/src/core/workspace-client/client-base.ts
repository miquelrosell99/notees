/**
 * WorkspaceClientBase — the chain's shared-infrastructure link. The
 * infrastructure itself now lives in ClientContext (client-context.ts),
 * constructed first and owned here; this class keeps the chain's protected
 * member surface as thin delegating accessors so the domain subclasses are
 * unchanged. Operation-domain methods live in the WorkspaceClient*
 * subclasses; the concrete WorkspaceClient (client.ts) is what callers
 * construct.
 */

import type { Envelope } from "@notees/protocol";
import {
  SyncEngine,
  type BatchChangeInfo,
  type SyncConflict,
  type Transport,
} from "@notees/sync";
import type { GraphOptions, GraphTopology, NodeRow, Store } from "@notees/store";

import {
  UndoJournal,
  type UndoCaptureSource,
  type UndoRecordMode,
} from "../undo-journal.js";
import { ClientContext } from "./client-context.js";
import type {
  ChangeNotification,
  ClientNode,
  ConflictHistoryEntry,
  WorkspaceClientOptions,
} from "./types.js";
import { CONFLICT_LOG_CAP } from "./types.js";

export abstract class WorkspaceClientBase {
  readonly store: Store;

  /** The shared infrastructure every domain delegates to. */
  protected readonly ctx: ClientContext;

  protected get transport(): Transport {
    return this.ctx.transport;
  }
  protected get actorId(): string {
    return this.ctx.actorId;
  }
  protected get deviceId(): string {
    return this.ctx.deviceId;
  }
  protected get clientClaim(): string | undefined {
    return this.ctx.clientClaim;
  }
  protected get userOnConflict(): ((conflicts: SyncConflict[]) => void) | undefined {
    return this.ctx.userOnConflict;
  }
  protected get userOnSyncError(): ((error: Error) => void) | undefined {
    return this.ctx.userOnSyncError;
  }
  protected get restServerUrl(): string | null {
    return this.ctx.restServerUrl;
  }
  protected get restApiKey(): string | null {
    return this.ctx.restApiKey;
  }
  protected get workspaceId(): string {
    return this.ctx.workspaceId;
  }
  protected set workspaceId(value: string) {
    this.ctx.workspaceId = value;
  }
  protected get engine(): SyncEngine | null {
    return this.ctx.engine;
  }
  protected set engine(value: SyncEngine | null) {
    this.ctx.engine = value;
  }
  protected get realtimeStop(): (() => void) | null {
    return this.ctx.realtimeStop;
  }
  protected set realtimeStop(value: (() => void) | null) {
    this.ctx.realtimeStop = value;
  }
  protected get undoJournal(): UndoJournal {
    return this.ctx.undoJournal;
  }
  protected get conflictLog(): ConflictHistoryEntry[] {
    return this.ctx.conflictLog;
  }
  protected get listReadCache(): Map<string, unknown> {
    return this.ctx.listReadCache;
  }

  protected constructor(store: Store, options: WorkspaceClientOptions) {
    this.store = store;
    this.ctx = new ClientContext(store, options, () => this.buildUndoCaptureSource());
  }

  getWorkspaceId(): string {
    return this.ctx.getWorkspaceId();
  }

  /**
   * The graph-view topology projection: one derived read over the
   * local store — classes + present-as-main nodes only, every edge rolled up
   * to that node set, plus the semantic co-occurrence family. Pure read, no
   * caching here: the graph view debounces its own reloads on subscribe.
   */
  graphTopology(options?: GraphOptions): GraphTopology {
    return this.ctx.graphTopology(options);
  }

  protected requireEngine(): SyncEngine {
    return this.ctx.requireEngine();
  }

  /**
   * Pull via the SyncEngine (snapshot shortcut when newer, then seq catch-up)
   * so local state converges with the relay. Any locally pending outbox ops
   * are pushed first (local-first, never lost).
   */
  async bootstrapWorkspace(workspaceId: string): Promise<void> {
    this.ctx.workspaceId = workspaceId;
    // A (re)bootstrap starts a fresh session journal: the durable unpushed
    // backlog replays below through the raw engine path on purpose (those
    // envelopes already had their session — re-journaling replays would mint
    // phantom undo entries).
    this.ctx.undoJournal.clear();
    this.ctx.engine = new SyncEngine(this.ctx.store, this.ctx.transport, this.ctx.clock, {
      workspaceId,
      callbacks: {
        onConflict: (conflicts) => {
          // Record before forwarding: the modal reads the log over RPC, and
          // conflicts are otherwise transient (emitted once, never stored).
          for (const conflict of conflicts) {
            this.ctx.conflictLog.push({ ...conflict, at: Date.now() });
          }
          if (this.ctx.conflictLog.length > CONFLICT_LOG_CAP) {
            this.ctx.conflictLog.splice(0, this.ctx.conflictLog.length - CONFLICT_LOG_CAP);
          }
          this.ctx.userOnConflict?.(conflicts);
        },
        onError: (error) => this.ctx.userOnSyncError?.(error),
        onPush: (_total, info) => this.ctx.notifyFromInfo(info),
        onPull: (_total, info) => this.ctx.notifyFromInfo(info),
        // Realtime (WS) frames applied to the store refresh the UI exactly
        // like a pull does.
        onRemoteBatch: (_applied, info) => this.ctx.notifyFromInfo(info),
        // Durable local op log: locally-authored envelopes survive reloads
        // (the outbox is memory-only), and acknowledged envelopes are
        // cleared so the log holds only the unpushed backlog.
        onEnqueued: (envelope) => this.ctx.store.recordLocalEnvelope(envelope),
        onAcknowledged: (ids) => {
          this.ctx.store.markLocalEnvelopesPushed(ids);
          this.ctx.store.prunePushedLocalEnvelopes();
        },
      },
    });
    // Re-envelope the durable unpushed backlog (offline work from a previous
    // session): apply is idempotent by envelope id, so already-applied ops
    // are no-ops and the rest re-enter the outbox for the next push. Only
    // envelopes of THIS workspace re-enter — a backlog from another local
    // workspace never leaks across a workspace switch.
    for (const env of this.ctx.store.unpushedEnvelopes()) {
      if ((env as Envelope).workspaceId === workspaceId) {
        this.ctx.engine.enqueue(env as Envelope);
      }
    }
    await this.ctx.engine.sync();
    // Bootstrap notifies unconditionally (the engine callbacks above also
    // fired): sync failures reject before the onPull callback runs, and the
    // initial UI seed must refresh either way.
    this.ctx.notify();
  }

  /**
   * One push+pull sync cycle against the relay. The engine's onPush/onPull/
   * status callbacks notify with change-info; no wrapper notify here (a
   * no-op cycle must not invalidate the read cache).
   */
  async sync(): Promise<void> {
    await this.ctx.requireEngine().sync();
  }

  protected buildEnvelope(
    opType: string,
    payload: Record<string, unknown>,
    affected: string[],
  ): Envelope {
    return this.ctx.buildEnvelope(opType, payload, affected);
  }

  /**
   * The single local-write seam: every envelope this client authors
   * funnels through here. (The full contract lives on ClientContext.)
   */
  protected enqueueLocal(
    envelope: Envelope,
    mode: UndoRecordMode = "normal",
    verbOverride?: string,
  ): void {
    this.ctx.enqueueLocal(envelope, mode, verbOverride);
  }

  /** Best-effort background push after a local write; errors go to onSyncError. */
  protected kickPush(): void {
    this.ctx.kickPush();
  }

  subscribe(listener: (change: ChangeNotification) => void): () => void {
    return this.ctx.subscribe(listener);
  }

  /** The single notify funnel — see ClientContext.notify for the contract. */
  protected notify(change?: { affectedNodeIds?: string[]; structural?: boolean }): void {
    this.ctx.notify(change);
  }

  /**
   * Union of the given ids with their ancestor chains (parent pointers up to
   * the workspace root). Content edits invalidate a node and its ancestors;
   * descendants of the edited node are untouched by definition.
   */
  protected expandAffectedAncestors(ids: string[]): string[] {
    return this.ctx.expandAffectedAncestors(ids);
  }

  protected notifyFromInfo(info: BatchChangeInfo | undefined): void {
    this.ctx.notifyFromInfo(info);
  }

  protected mapNodeCached(row: NodeRow): ClientNode {
    return this.ctx.mapNodeCached(row);
  }

  close(): void {
    this.ctx.close(() => this.stopRealtime());
  }

  /** Implemented by the sync domain (client-sync.ts); torn down by close(). */
  abstract stopRealtime(): void;

  /**
   * The pre-apply read seam behind the undo journal — implemented by the
   * undo domain (client-undo.ts); the context wires it into the journal at
   * construction time.
   */
  protected abstract buildUndoCaptureSource(): UndoCaptureSource;
}
