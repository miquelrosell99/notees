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






export class WorkspaceClient extends WorkspaceClientWrites {
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









  // --- dates (SCHEMA.md "Datetime" — a date is a node, not a string) ----------

  /** The schema's date precision (default day when the row predates the field). */
  private datePrecisionOf(propertySchemaId: string): DatePrecision {
    const schema = this.listPropertySchemas().find((s) => s.id === propertySchemaId);
    return schema?.datePrecision ?? "day";
  }

  /**
   * Ensure the year/month/day node chain for an ISO date exists (journal
   * layout: year as a workspace-root page, month under year, day under month,
   * named by the compact labels) and return the three deterministic ids.
   * Ids are content-addressed from the date (@notees/domain dates.ts), so a
   * re-run creates nothing — the client-level existence check is op-log
   * hygiene, not correctness; even a raced create is an applier no-op.
   */
  async ensureDateChain(
    isoDate: string,
  ): Promise<{ year: string; month: string; day: string }> {
    const parts = parseIsoDate(isoDate);
    const ids = chainNodeIds(isoDate);
    if (this.getNodeRaw(ids.year) === undefined) {
      await this.createObject({
        id: ids.year,
        isEmbedded: false,
        parentId: null,
        name: dateNodeLabel(parts, "year"),
        classIds: [SYSTEM_CLASS_UUIDS.year],
      });
    }
    if (this.getNodeRaw(ids.month) === undefined) {
      await this.createObject({
        id: ids.month,
        isEmbedded: false,
        parentId: ids.year,
        name: dateNodeLabel(parts, "month"),
        classIds: [SYSTEM_CLASS_UUIDS.month],
      });
    }
    if (this.getNodeRaw(ids.day) === undefined) {
      await this.createObject({
        id: ids.day,
        isEmbedded: false,
        parentId: ids.month,
        name: dateNodeLabel(parts, "day"),
        classIds: [SYSTEM_CLASS_UUIDS.day],
      });
    }
    // Heal the chain parentage AND labels: older writers created chain nodes
    // parentless and with ISO-dashed content ("2026-10-05"); the stored label
    // must be the compact form ("20261005" — the lookup/sort contract), so
    // an existing-but-wrong level is rewritten, idempotently — one op per
    // stray, only while it actually differs.
    const healLevel = async (
      id: string,
      parentId: string | null,
      precision: "year" | "month" | "day",
    ): Promise<void> => {
      const node = this.getNodeRaw(id);
      if (node === undefined) return;
      if ((node.parentId ?? null) !== parentId) {
        await this.moveObject(id, parentId);
      }
      const label = dateNodeLabel(parts, precision);
      const first = node.contentAst[0];
      const text =
        first !== undefined && (first as { type?: unknown }).type === "text"
          ? String((first as { text?: unknown }).text ?? "")
          : "";
      if (text !== label) {
        await this.updateObject(id, { contentAst: [{ type: "text", text: label }] });
      }
    };
    await healLevel(ids.year, null, "year");
    await healLevel(ids.month, ids.year, "month");
    await healLevel(ids.day, ids.month, "day");
    return ids;
  }

  /** Create/refresh the chain and return the node id at the schema's precision. */
  private async dateRefFor(isoDate: string, precision: DatePrecision): Promise<string> {
    const ids = await this.ensureDateChain(isoDate);
    return precision === "year" ? ids.year : precision === "month" ? ids.month : ids.day;
  }

  /**
   * Set a datetime property value (SCHEMA.md "Datetime" — the unified date
   * type): ensure the chain(s), then write the value union — a point
   * `{ "nodeId": …, "time"?: "HH:MM" }` or a range `{ "start", "end" }` of
   * slots, either side open. Refs land at the schema's precision (the edge
   * index projects them, so the year node backlinks everything dated that
   * year); a `time` rides ONLY a day-precision anchor (schema ceiling AND
   * day ref) — passing one at year/month precision fails loud. One chain is
   * ensured per distinct day. Editing overwrites the same slot's ref;
   * `metadata` passes through (recurrence rides it).
   */
  async setDatetimeProperty(
    objectId: string,
    propertySchemaId: string,
    value: DatetimeValueInput,
    idx = 0,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const precision = this.datePrecisionOf(propertySchemaId);
    const slotOf = async (input: DatetimePointInput): Promise<DatetimeSlot> => {
      if (input.time !== undefined && precision !== "day") {
        throw new Error(
          `datetime time requires day precision (schema ${propertySchemaId} is ${precision})`,
        );
      }
      const nodeId = await this.dateRefFor(input.iso, precision);
      return input.time !== undefined ? { nodeId, time: input.time } : { nodeId };
    };
    if ("start" in value || "end" in value) {
      const rangeInput = value as {
        start?: DatetimePointInput | null;
        end?: DatetimePointInput | null;
      };
      const range: { start: DatetimeSlot | null; end: DatetimeSlot | null } = {
        start: null,
        end: null,
      };
      if (rangeInput.start !== null && rangeInput.start !== undefined) {
        range.start = await slotOf(rangeInput.start);
      }
      if (rangeInput.end !== null && rangeInput.end !== undefined) {
        range.end = await slotOf(rangeInput.end);
      }
      await this.setProperty(objectId, propertySchemaId, range, idx, metadata);
      return;
    }
    const slot = await slotOf(value);
    await this.setProperty(objectId, propertySchemaId, slot, idx, metadata);
  }

  /**
   * Create an annotation on an asset (the composed write behind the chips'
   * annotations form): the highlight-classed object named by the quote
   * excerpt, the highlight_asset link, the provenance text, and the optional
   * note child block. Applied locally, push kicked off.
   */
  createAnnotation(input: CreateAnnotationInput): Promise<string> {
    return createAnnotation(this, input);
  }




  // --- notifications -----------------------------------------------------------






}
