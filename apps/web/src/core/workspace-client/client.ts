/**
 * WorkspaceClient — the Notees web data path (slice 1).
 *
 * A thin, fully Node-testable layer over three pieces: a Store over the sql.js
 * backend (local derived state), a SyncEngine (outbox push + seq-cursor
 * catch-up pull + snapshot shortcut), and a Transport (HttpTransport against a
 * relay server in the app, MemoryTransport over a MemoryRelay in tests).
 *
 * Reads always hit the LOCAL store. Writes build protocol envelopes
 * (`newEnvelope`, deviceId "web"), apply optimistically via the engine's
 * enqueue (local-first), then push. `subscribe` is a naive notification fired
 * on local apply and on sync completion — enough for a render-refresh loop.
 *
 * The class body lives in the operation-domain files of this folder, chained
 * as WorkspaceClientBase → … → WorkspaceClientDates (client-base.ts through
 * client-dates.ts); this file holds only the concrete class and its
 * construction factories.
 */

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { HttpTransport, OfflineTransport } from "@notees/sync";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import type { WorkspaceClientOptions } from "./types.js";
import { WorkspaceClientDates } from "./client-dates.js";

export class WorkspaceClient extends WorkspaceClientDates {
  /** Open a Store over the sql.js backend and wrap it in a client. */
  static async create(options: WorkspaceClientOptions): Promise<WorkspaceClient> {
    const SQL = options.sqlJs ?? (await initSqlJs(options.sqlJsConfig));
    const store = Store.open(sqljsBackend(SQL));
    return new WorkspaceClient(store, options);
  }

  /**
   * Wrap an already-open Store (worker persistence path: the caller restores
   * saved bytes into the store before wrapping it).
   */
  static wrap(store: Store, options: WorkspaceClientOptions): WorkspaceClient {
    return new WorkspaceClient(store, options);
  }

  /** Factory for the app path: HTTP transport against a relay server. The
   * `apiKey` slot carries the credential — the operator API key or an
   * account session token (the server accepts both, see routes-auth). */
  static async createHttp(options: {
    serverUrl: string;
    apiKey: string;
    workspaceId: string;
    sqlJsConfig?: Parameters<typeof initSqlJs>[0];
  }): Promise<WorkspaceClient> {
    const transport = new HttpTransport({
      baseUrl: options.serverUrl,
      apiKey: options.apiKey,
      workspaceId: options.workspaceId,
    });
    return WorkspaceClient.create({
      transport,
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      sqlJsConfig: options.sqlJsConfig,
    });
  }

  /**
   * Offline-first factory: no server, no account. Edits apply locally and
   * are recorded in the durable local op log; when the user later connects
   * this workspace to a server (login), the backlog pushes through the
   * normal outbox path.
   */
  static async createOffline(options: {
    workspaceId: string;
    sqlJs?: SqlJsStatic;
    sqlJsConfig?: Parameters<typeof initSqlJs>[0];
  }): Promise<WorkspaceClient> {
    return WorkspaceClient.create({
      transport: new OfflineTransport(),
      ...(options.sqlJs !== undefined ? { sqlJs: options.sqlJs } : {}),
      ...(options.sqlJsConfig !== undefined ? { sqlJsConfig: options.sqlJsConfig } : {}),
    });
  }
}
