/**
 * WorkspaceClientBase — the client's shared infrastructure: identity fields
 * (store, transport, actor/device, REST config), the envelope build + local
 * enqueue write seam, the SyncEngine bootstrap/lifecycle, and the
 * subscribe/notify funnel every domain read caches against. Operation-domain
 * methods live in the WorkspaceClient* subclasses; the concrete
 * WorkspaceClient (client.ts) is what callers construct.
 */

import { Clock, newEnvelope, type Envelope } from "@notees/protocol";
import {
  isListingAffectingEnvelope,
  SyncEngine,
  type BatchChangeInfo,
  type SyncConflict,
  type Transport,
} from "@notees/sync";
import {
  Store,
  graphTopology as computeGraphTopology,
  type GraphOptions,
  type GraphTopology,
  type NodeRow,
} from "@notees/store";

import {
  UndoJournal,
  type UndoCaptureSource,
  type UndoRecordMode,
} from "../undo-journal.js";
import { mapNode, nodeRowStamp } from "./mappers.js";
import {
  CHANGE_AFFECT_CAP,
  CONFLICT_LOG_CAP,
  DEFAULT_ACTOR_ID,
  DEFAULT_WORKSPACE_ID,
  IDLE_SNAPSHOT,
  type ChangeNotification,
  type ClientNode,
  type ConflictHistoryEntry,
  type SyncStatusSnapshot,
  type WorkspaceClientOptions,
} from "./types.js";

export abstract class WorkspaceClientBase {
  readonly store: Store;

  protected readonly transport: Transport;
  protected readonly actorId: string;
  protected readonly deviceId: string;
  protected readonly clientClaim: string | undefined;
  protected readonly userOnConflict: ((conflicts: SyncConflict[]) => void) | undefined;
  protected readonly userOnSyncError: ((error: Error) => void) | undefined;
  protected readonly clock: Clock;
  protected readonly listeners = new Set<(change: ChangeNotification) => void>();
  /** Server REST access (asset upload/download); null without serverUrl/apiKey. */
  protected readonly restServerUrl: string | null;
  protected readonly restApiKey: string | null;

  protected workspaceId: string = DEFAULT_WORKSPACE_ID;
  protected engine: SyncEngine | null = null;
  /** Combined teardown for the wired realtime channel + status subscription. */
  protected realtimeStop: (() => void) | null = null;
  protected closed = false;
  /**
   * Revision-keyed memo for the render-path list reads
   * (listClasses/listPages/roots). Dozens of components call these per
   * render; uncached, each call re-ran the full-table query + row mapping on
   * the main thread (the profiled 75%-of-capture jank). `notify()` is the
   * single funnel for every store mutation and refresh, so it clears this
   * map: one query per change burst, and no re-query at all for renders that
   * race no change (e.g. the 2s status poll). Returned arrays are SHARED
   * across callers until the next notify — callers must treat them as
   * read-only.
   */
  protected readonly listReadCache = new Map<string, unknown>();
  /**
   * Per-row `mapNode` identity cache: unchanged rows reuse their
   * `ClientNode` across store revisions, so a version bump (one keystroke's
   * op) doesn't re-parse/re-allocate every node in the workspace (the
   * profiled allocation churn — 254 minor GCs in a 35s capture). Keyed by
   * row id, self-invalidating via the column-value stamp (no notify
   * coupling); membership recomputes that skip hlc/updated_at are still
   * caught through the class_ids/tag_ids columns in the stamp.
   */
  protected readonly nodeMapCache = new Map<string, { h1: number; h2: number; node: ClientNode }>();

  protected mapNodeCached(row: NodeRow): ClientNode {
    const { h1, h2 } = nodeRowStamp(row);
    const hit = this.nodeMapCache.get(row.id);
    if (hit !== undefined && hit.h1 === h1 && hit.h2 === h2) return hit.node;
    const node = mapNode(row);
    this.nodeMapCache.set(row.id, { h1, h2, node });
    return node;
  }
  /**
   * The session-local op-inverse undo journal (in-memory, per
   * client = per tab; never cross-tab, never durable). Records every write
   * this client applies through its outbox path, with the pre-op snapshot
   * captured at apply time; undo/redo compose existing ops through the same
   * write path (see undo-journal.ts for the inversion matrix).
   */
  protected readonly undoJournal: UndoJournal;
  /** Semantic conflict history for the sync details modal. */
  protected readonly conflictLog: ConflictHistoryEntry[] = [];

  /**
   * The pre-apply read seam behind the undo journal — implemented by the
   * undo domain (client-undo.ts); the base constructor wires it into the
   * journal before any derived field exists.
   */
  protected abstract buildUndoCaptureSource(): UndoCaptureSource;
  /** Implemented by the sync domain (client-sync.ts); torn down by close(). */
  abstract stopRealtime(): void;

  protected constructor(store: Store, options: WorkspaceClientOptions) {
    this.store = store;
    this.transport = options.transport;
    this.actorId = options.actorId ?? DEFAULT_ACTOR_ID;
    this.deviceId = options.deviceId ?? "web";
    this.clientClaim = options.client;
    this.userOnConflict = options.onConflict;
    this.userOnSyncError = options.onSyncError;
    this.clock = new Clock(this.deviceId);
    this.restServerUrl =
      options.serverUrl !== undefined && options.serverUrl !== "" ? options.serverUrl : null;
    this.restApiKey = options.apiKey !== undefined && options.apiKey !== "" ? options.apiKey : null;
    this.undoJournal = new UndoJournal({ capture: this.buildUndoCaptureSource() });
  }

  /** Open a Store over the sql.js backend and wrap it in a client. */

  /** Per-session monotonic counter; see ChangeNotification. */
  protected revision = 0;

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  /**
   * The graph-view topology projection: one derived read over the
   * local store — classes + present-as-main nodes only, every edge rolled up
   * to that node set, plus the semantic co-occurrence family. Pure read, no
   * caching here: the graph view debounces its own reloads on subscribe.
   */
  graphTopology(options?: GraphOptions): GraphTopology {
    return computeGraphTopology(this.store, this.workspaceId, options);
  }

  protected requireEngine(): SyncEngine {
    if (this.engine === null) {
      throw new Error("WorkspaceClient: call bootstrapWorkspace(workspaceId) first");
    }
    return this.engine;
  }

  /**
   * Pull via the SyncEngine (snapshot shortcut when newer, then seq catch-up)
   * so local state converges with the relay. Any locally pending outbox ops
   * are pushed first (local-first, never lost).
   */
  async bootstrapWorkspace(workspaceId: string): Promise<void> {
    this.workspaceId = workspaceId;
    // A (re)bootstrap starts a fresh session journal: the durable unpushed
    // backlog replays below through the raw engine path on purpose (those
    // envelopes already had their session — re-journaling replays would mint
    // phantom undo entries).
    this.undoJournal.clear();
    this.engine = new SyncEngine(this.store, this.transport, this.clock, {
      workspaceId,
      callbacks: {
        onConflict: (conflicts) => {
          // Record before forwarding: the modal reads the log over RPC, and
          // conflicts are otherwise transient (emitted once, never stored).
          for (const conflict of conflicts) {
            this.conflictLog.push({ ...conflict, at: Date.now() });
          }
          if (this.conflictLog.length > CONFLICT_LOG_CAP) {
            this.conflictLog.splice(0, this.conflictLog.length - CONFLICT_LOG_CAP);
          }
          this.userOnConflict?.(conflicts);
        },
        onError: (error) => this.userOnSyncError?.(error),
        onPush: (_total, info) => this.notifyFromInfo(info),
        onPull: (_total, info) => this.notifyFromInfo(info),
        // Realtime (WS) frames applied to the store refresh the UI exactly
        // like a pull does.
        onRemoteBatch: (_applied, info) => this.notifyFromInfo(info),
        // Durable local op log: locally-authored envelopes survive reloads
        // (the outbox is memory-only), and acknowledged envelopes are
        // cleared so the log holds only the unpushed backlog.
        onEnqueued: (envelope) => this.store.recordLocalEnvelope(envelope),
        onAcknowledged: (ids) => {
          this.store.markLocalEnvelopesPushed(ids);
          this.store.prunePushedLocalEnvelopes();
        },
      },
    });
    // Re-envelope the durable unpushed backlog (offline work from a previous
    // session): apply is idempotent by envelope id, so already-applied ops
    // are no-ops and the rest re-enter the outbox for the next push. Only
    // envelopes of THIS workspace re-enter — a backlog from another local
    // workspace never leaks across a workspace switch.
    for (const env of this.store.unpushedEnvelopes()) {
      if ((env as Envelope).workspaceId === workspaceId) {
        this.engine.enqueue(env as Envelope);
      }
    }
    await this.engine.sync();
    // Bootstrap notifies unconditionally (the engine callbacks above also
    // fired): sync failures reject before the onPull callback runs, and the
    // initial UI seed must refresh either way.
    this.notify();
  }

  /**
   * One push+pull sync cycle against the relay. The engine's onPush/onPull/
   * status callbacks notify with change-info; no wrapper notify here (a
   * no-op cycle must not invalidate the read cache).
   */
  async sync(): Promise<void> {
    await this.requireEngine().sync();
  }

  protected buildEnvelope(opType: string, payload: Record<string, unknown>, affected: string[]): Envelope {
    return newEnvelope({
      workspaceId: this.workspaceId,
      actorId: this.actorId,
      deviceId: this.deviceId,
      ...(this.clientClaim !== undefined ? { client: this.clientClaim } : {}),
      hlc: this.clock.now(),
      affectedNodeIds: affected,
      opType,
      payload,
    });
  }

  /**
   * The single local-write seam: every envelope this client authors
   * funnels through here. The inverse intent is captured BEFORE the apply
   * (the pre-op snapshot), the envelope then applies + enters the outbox
   * exactly like any write, and only a successful apply is journaled — a
   * throwing apply never reaches the outbox, so it never reaches the journal.
   * `mode` journals the application to the opposite stack while undo/redo
   * runs (the standard model: undoing is itself journaled, on the redo side);
   * `verbOverride` relabels those entries with the original gesture's verb
   * ("Redo delete", not "Redo restore").
   */
  protected enqueueLocal(
    envelope: Envelope,
    mode: UndoRecordMode = "normal",
    verbOverride?: string,
  ): void {
    const prepared = this.undoJournal.prepare(envelope);
    const summary = this.requireEngine().enqueue(envelope);
    this.undoJournal.commit(prepared, mode, verbOverride);
    this.notify({
      affectedNodeIds: summary.affectedNodeIds,
      structural: isListingAffectingEnvelope(envelope),
    });
    this.kickPush();
  }

  /** Best-effort background push after a local write; errors go to onSyncError. */
  protected kickPush(): void {
    this.requireEngine()
      .push()
      .catch((err: unknown) => {
        this.userOnSyncError?.(err instanceof Error ? err : new Error(String(err)));
      });
  }

  subscribe(listener: (change: ChangeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The single notify funnel. Callers pass what they know:
   *
   *  - no argument — the change set is unknown (bootstrap, status/realtime
   *    wiring, manual sync wrappers): subscribers must treat everything as
   *    stale.
   *  - `{ affectedNodeIds, structural }` — one applied batch (local write,
   *    push/pull/remote summary): content-only edits stay scoped; a
   *    listing-affecting batch (or an oversized affected set) collapses to
   *    `structural: true`.
   *
   * Content scopes are ancestor-expanded here (a page-tree read of P
   * contains node X iff P is an ancestor of X), bounded by CHANGE_AFFECT_CAP.
   */
  protected notify(change?: { affectedNodeIds?: string[]; structural?: boolean }): void {
    if (this.closed) return;
    this.listReadCache.clear();
    this.revision += 1;
    let payload: ChangeNotification = { revision: this.revision };
    if (change !== undefined && change.structural === true) {
      payload = { revision: this.revision, structural: true };
    } else if (change !== undefined) {
      const affected = this.expandAffectedAncestors(change.affectedNodeIds ?? []);
      if (affected.length > CHANGE_AFFECT_CAP) {
        payload = { revision: this.revision, structural: true };
      } else {
        // Explicit empty scope ("nothing is stale") — a bare {revision}
        // payload means scope-unknown and would invalidate everything.
        payload = { revision: this.revision, affectedNodeIds: affected, structural: false };
      }
    }
    for (const listener of this.listeners) listener(payload);
  }

  /**
   * Union of the given ids with their ancestor chains (parent pointers up to
   * the workspace root). Content edits invalidate a node and its ancestors;
   * descendants of the edited node are untouched by definition.
   */
  protected expandAffectedAncestors(ids: string[]): string[] {
    const out = new Set<string>();
    for (const id of ids) {
      if (out.has(id)) continue;
      out.add(id);
      let current = this.store.getNode(id)?.parent_id ?? null;
      let hops = 0;
      while (current !== null && !out.has(current) && hops < 64) {
        out.add(current);
        hops += 1;
        current = this.store.getNode(current)?.parent_id ?? null;
      }
    }
    return [...out];
  }

  protected notifyFromInfo(info: BatchChangeInfo | undefined): void {
    this.notify(
      info === undefined
        ? undefined
        : { affectedNodeIds: info.affectedNodeIds, structural: info.structural },
    );
  }

  close(): void {
    if (this.closed) return;
    // Guard before tearing down: stopRealtime() notifies, and a subscriber
    // (e.g. the worker persist scheduler) must not re-arm after close.
    this.closed = true;
    this.stopRealtime();
    this.store.close();
  }
}
