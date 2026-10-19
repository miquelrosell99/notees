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
 */

import initSqlJs, { type SqlJsStatic } from "sql.js";
import { uuidv7 } from "uuidv7";

import {
  chainNodeIds,
  dateNodeId,
  dateNodeLabel,
  DEFAULT_CLASS_ICON,
  defaultIconFor,
  deriveDisplayName,
  parseIsoDate,
  rendersWithDocumentChrome,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  type DatePrecision,
  type DatetimeSlot,
} from "@notees/domain";
import {
  Clock,
  newEnvelope,
  type ContentAst,
  type Envelope,
  type ListStyle,
  type WorkspaceFeature,
} from "@notees/protocol";
import { parseQueryAst, runAggregate, runQuery, type QueryAst } from "@notees/query";
import {
  Store,
  graphTopology as computeGraphTopology,
  planMerge,
  visiblePropertyValueRows,
  type GraphOptions,
  type GraphTopology,
  type MergePlanSummary,
  type NodeRow,
} from "@notees/store";
import {
  HttpTransport,
  OfflineTransport,
  SyncEngine,
  isListingAffectingEnvelope,
  summarizeEnvelopes,
  type BatchChangeInfo,
  type SyncConflict,
  type SyncStatus,
  type Transport,
} from "@notees/sync";

import { sqljsBackend } from "@notees/store/sqljs";

// PG10 alias name-equivalents (aliasProperty type-only imports back — no
// runtime cycle).
import { aliasValuesOf } from "../../ui/components/aliasProperty.js";

import {
  CHANGE_AFFECT_CAP,
  CONFLICT_LOG_CAP,
  createAnnotation,
  DEFAULT_ACTOR_ID,
  DEFAULT_TREE_DEPTH,
  DEFAULT_WORKSPACE_ID,
  IDLE_SNAPSHOT,
  mapClassBindingRow,
  UUID_LIKE,
  type AssetInfo,
  type AssetUploadResult,
  type BlockTreeNode,
  type ChangeNotification,
  type ClassBinding,
  type ClientEdge,
  type ClientNode,
  type ClientPropertyOption,
  type ClientPropertySchema,
  type ConflictHistoryEntry,
  type CreateAnnotationInput,
  type CreateObjectInput,
  type CreatePropertySchemaInput,
  type DatetimePointInput,
  type DatetimeValueInput,
  type DeleteObjectOptions,
  type EffectiveProperty,
  InvalidQueryAstError,
  type OperationFeedEntry,
  type ParentRenderFacts,
  type QueryAggregateResult,
  type QueryRunResult,
  type ReferenceEntry,
  type SearchPageResult,
  type SearchSnippetData,
  type SetClassPropertyInput,
  type SyncStatusSnapshot,
  type TrashedEntry,
  type UpdateObjectInput,
  type UpdatePropertySchemaInput,
  type WorkspaceClientOptions,
} from "./types.js";
import { mapNode, nodeRowStamp, parseContentAst, parseListStyle } from "./mappers.js";
import { WorkspaceClientBase } from "./client-base.js";
import { WorkspaceClientReads } from "./client-reads.js";
import { WorkspaceClientReadsProps } from "./client-reads-props.js";
import { WorkspaceClientReadsRefs } from "./client-reads-refs.js";
import { WorkspaceClientSync } from "./client-sync.js";
import { WorkspaceClientServer } from "./client-server.js";
import { WorkspaceClientUndo } from "./client-undo.js";
import { WorkspaceClientWrites } from "./client-writes.js";
import { WorkspaceClientDates } from "./client-dates.js";
import { fetchAssetBlob, postAssetUpload, readBlobAsDataUrl } from "./asset-transport.js";
import {
  normalizeUserPrefs,
  readDevicePrefList,
  writeDevicePrefList,
  type PrefsPatch,
  type UserPrefs,
  type UserPrefsSource,
} from "./prefs.js";
import {
  normalizeSectionView,
  normalizeSectionViewList,
  type HostedSectionKey,
  type SectionView,
} from "./section-views.js";



import {
  UndoJournal,
  type UndoCaptureSource,
  type UndoHistoryEntry,
  type UndoRecordMode,
  type UndoUiState,
} from "../undo-journal.js";






export class WorkspaceClient extends WorkspaceClientDates {
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













  // --- notifications -----------------------------------------------------------






}
