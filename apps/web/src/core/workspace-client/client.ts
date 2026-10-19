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






export class WorkspaceClient extends WorkspaceClientReadsRefs {
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








  // --- write API (optimistic local apply + outbox push) -----------------------



  // --- undo journal -------------------------------------------------------------

  /** The pre-apply read seam behind the journal — pure store reads (see undo-journal.ts). */
  protected buildUndoCaptureSource(): UndoCaptureSource {
    const db = () => this.store.database;
    const parseJson = (raw: string | null | undefined): unknown => {
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const stringList = (raw: string | null | undefined): string[] => {
      const parsed = parseJson(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    };
    const nullableBool = (raw: unknown): boolean | null =>
      raw === null || raw === undefined ? null : raw === 1 || raw === true;
    return {
      nodeSnapshot: (id) => {
        const row = this.store.getNode(id);
        if (row === undefined) return null;
        return {
          isEmbedded: row.is_embedded === 1,
          icon: row.icon,
          color: row.color,
          listStyle: parseListStyle(row.list_style),
          contentAst: parseContentAst(row.content),
          classIds: stringList(row.class_ids),
          tagIds: stringList(row.tag_ids),
          active: row.is_active === 1,
        };
      },
      nodePlacement: (id) => {
        const row = this.store.getNode(id);
        if (row === undefined) return null;
        if (row.parent_id === null) {
          return { parentId: null, afterId: null, beforeId: null };
        }
        const siblings = db()
          .prepare(
            "SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position",
          )
          .all(row.parent_id) as Array<{ child_id: string }>;
        const ids = siblings.map((sibling) => sibling.child_id);
        const index = ids.indexOf(id);
        return {
          parentId: row.parent_id,
          afterId: index > 0 ? ids[index - 1]! : null,
          beforeId: index >= 0 && index < ids.length - 1 ? ids[index + 1]! : null,
        };
      },
      classDescription: (classId) => {
        const row = db()
          .prepare("SELECT description FROM class WHERE id = ?")
          .get(classId) as { description: string | null } | undefined;
        return row?.description ?? null;
      },
      propertyValue: (objectId, propertySchemaId, elementId, idx) => {
        const rowId = elementId ?? `${objectId}:${propertySchemaId}:${idx}`;
        const row = db()
          .prepare(
            "SELECT id, idx, value, metadata FROM property_value WHERE id = ?",
          )
          .get(rowId) as
          | { id: string; idx: number; value: string; metadata: string | null }
          | undefined;
        if (row === undefined) return null;
        const metadata = parseJson(row.metadata);
        return {
          elementId: row.id,
          idx: row.idx,
          value: parseJson(row.value),
          metadata:
            typeof metadata === "object" && metadata !== null
              ? (metadata as Record<string, unknown>)
              : null,
        };
      },
      classBinding: (classId, propertySchemaId) => {
        const row = db()
          .prepare(
            `SELECT sequence, required, default_value, active
             FROM class_property WHERE class_id = ? AND property_schema_id = ?`,
          )
          .get(classId, propertySchemaId) as
          | {
              sequence: number;
              required: number | null;
              default_value: string | null;
              active: number;
            }
          | undefined;
        if (row === undefined) return null;
        return {
          sequence: row.sequence,
          required: nullableBool(row.required),
          defaultValue: row.default_value === null ? undefined : parseJson(row.default_value),
          active: row.active !== 0,
        };
      },
      classParents: (classId) =>
        (
          db()
            .prepare(
              "SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id",
            )
            .all(classId) as Array<{ parent_class_id: string }>
        ).map((row) => row.parent_class_id),
      schemaSnapshot: (propertySchemaId) => {
        const row = db()
          .prepare(
            `SELECT name, type, multi, scope, options, target_class_filter, date_precision, date_qualified,
                    display, readonly, hide_when_empty
             FROM property_schema WHERE id = ?`,
          )
          .get(propertySchemaId) as
          | {
              name: string;
              type: string;
              multi: number;
              scope: string;
              options: string;
              target_class_filter: string | null;
              date_precision: string | null;
              date_qualified: number | null;
              display: string | null;
              readonly: number | null;
              hide_when_empty: number | null;
            }
          | undefined;
        if (row === undefined) return null;
        const filter = parseJson(row.target_class_filter);
        return {
          name: row.name,
          type: row.type,
          multi: row.multi === 1,
          scope: row.scope,
          options: parseJson(row.options),
          targetClassFilter: Array.isArray(filter)
            ? filter.filter((v): v is string => typeof v === "string")
            : null,
          datePrecision: row.date_precision,
          dateQualified: nullableBool(row.date_qualified),
          display: row.display === "bullet" || row.display === "inline" ? row.display : null,
          readonly: nullableBool(row.readonly),
          hideWhenEmpty: nullableBool(row.hide_when_empty),
        };
      },
      assetSnapshot: (objectId, assetId) => {
        const row = db()
          .prepare(
            `SELECT asset_id, hash, mime_type, size, original_name FROM node_asset
             WHERE node_id = ? AND asset_id = ? ORDER BY uploaded_at DESC LIMIT 1`,
          )
          .get(objectId, assetId) as
          | {
              asset_id: string;
              hash: string;
              mime_type: string;
              size: number;
              original_name: string;
            }
          | undefined;
        if (row === undefined) return null;
        return {
          assetId: row.asset_id,
          hash: row.hash,
          mimeType: row.mime_type,
          size: row.size,
          originalName: row.original_name,
        };
      },
      collectionMembership: (collectionId, objectId) => {
        const row = db()
          .prepare(
            "SELECT present FROM collection_member WHERE collection_id = ? AND object_id = ?",
          )
          .get(collectionId, objectId) as { present: number } | undefined;
        return row !== undefined && row.present === 1;
      },
      featureEnabled: (feature) => {
        const row = db()
          .prepare(
            "SELECT enabled FROM workspace_feature WHERE workspace_id = ? AND feature = ?",
          )
          .get(this.workspaceId, feature) as { enabled: number } | undefined;
        // Absent row = enabled (the empty-table default).
        return row === undefined || row.enabled === 1;
      },
    };
  }

  /**
   * The session journal state for chrome (keymap gating, palette
   * rows): availability plus the "Undo <verb>" / "Redo <verb>" labels. Async
   * to match the WorkerClient proxy (the union type is what App consumes).
   */
  async undoState(): Promise<UndoUiState> {
    return this.engine === null
      ? { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
      : this.undoJournal.state();
  }

  /**
   * The browsable history behind the jump-to menu: the undo stack
   * oldest-first with labels + timestamps + affected node ids. Empty when
   * the journal is (new session, new workspace).
   */
  async undoHistory(): Promise<UndoHistoryEntry[]> {
    return this.engine === null ? [] : this.undoJournal.history();
  }

  /**
   * Undo the most recent journaled local write: the captured inverses are
   * composed into fresh envelopes and applied through the normal write path,
   * journaled on the redo side (batched into ONE redo entry per gesture, and
   * relabeled with the original verb so the chrome reads "Redo delete").
   * Returns false when the journal is empty; a failed apply restores the
   * entry (unspent) and rethrows — undo never half-consumes a journal entry
   * silently (the inverses that did apply stay journaled on the redo side).
   */
  async undo(): Promise<boolean> {
    const entry = this.undoJournal.takeUndo();
    if (entry === null) return false;
    try {
      this.undoJournal.batch(() => {
        for (const spec of entry.inverseSpecs) {
          this.enqueueLocal(
            this.buildEnvelope(spec.opType, spec.payload, spec.affected),
            "undo",
            entry.verb,
          );
        }
      });
    } catch (error) {
      this.undoJournal.restoreUndo(entry);
      throw error;
    }
    return true;
  }

  /**
   * Redo the most recently undone entry: the redo entry's inverseSpecs are
   * the original gesture's ops (captured when the undo applied), so redo —
   * the mirror of undo — applies the popped entry's inverseSpecs through the
   * normal write path, journaled on the undo side under the same verb.
   */
  async redo(): Promise<boolean> {
    const entry = this.undoJournal.takeRedo();
    if (entry === null) return false;
    try {
      this.undoJournal.batch(() => {
        for (const spec of entry.inverseSpecs) {
          this.enqueueLocal(
            this.buildEnvelope(spec.opType, spec.payload, spec.affected),
            "redo",
            entry.verb,
          );
        }
      });
    } catch (error) {
      this.undoJournal.restoreRedo(entry);
      throw error;
    }
    return true;
  }

  /** Test/dev seam: how many entries the session journal currently holds. */
  undoDepth(): { undo: number; redo: number } {
    return { undo: this.undoJournal.undoDepth(), redo: this.undoJournal.redoDepth() };
  }

  /** Create an object; returns its id. Applied locally, push kicked off. */
  async createObject(partial: CreateObjectInput): Promise<string> {
    const id = partial.id ?? uuidv7();
    const payload: Record<string, unknown> = { objectId: id };
    if (partial.isEmbedded !== undefined) payload.isEmbedded = partial.isEmbedded;
    if (partial.classIds !== undefined) payload.classIds = partial.classIds;
    if (partial.tagIds !== undefined) payload.tagIds = partial.tagIds;
    // Title-is-content: the protocol has no object `name`. The `name`
    // convenience becomes the node's initial text content (a single text
    // token), so callers can keep naming pages at creation.
    const initialText = partial.name !== undefined && partial.contentAst === undefined
      ? [{ type: "text", text: partial.name }]
      : undefined;
    if (initialText !== undefined) payload.contentAst = initialText;
    if (partial.contentAst !== undefined) payload.contentAst = partial.contentAst;
    if (partial.parentId !== undefined) payload.parentId = partial.parentId;
    if (partial.afterId !== undefined) payload.afterId = partial.afterId;
    if (partial.beforeId !== undefined) payload.beforeId = partial.beforeId;
    this.enqueueLocal(this.buildEnvelope("object.create", payload, [id]));
    return id;
  }

  /** Update object fields (object.update; at least one field required). */
  async updateObject(id: string, fields: UpdateObjectInput): Promise<void> {
    const payload: Record<string, unknown> = { objectId: id };
    if (fields.isEmbedded !== undefined) payload.isEmbedded = fields.isEmbedded;
    if (fields.contentAst !== undefined) payload.contentAst = fields.contentAst;
    if (fields.icon !== undefined) payload.icon = fields.icon;
    if (fields.color !== undefined) payload.color = fields.color;
    if (fields.coverAssetId !== undefined) payload.coverAssetId = fields.coverAssetId;
    if (fields.bannerAssetId !== undefined) payload.bannerAssetId = fields.bannerAssetId;
    if (fields.aliasedNodeId !== undefined) payload.aliasedNodeId = fields.aliasedNodeId;
    if (fields.description !== undefined) payload.description = fields.description;
    if (fields.listStyle !== undefined) payload.listStyle = fields.listStyle;
    this.enqueueLocal(this.buildEnvelope("object.update", payload, [id]));
  }

  /** Trash (default) or permanently delete an object and its subtree. */
  async deleteObject(id: string, opts: DeleteObjectOptions = {}): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "object.delete",
        { objectId: id, permanent: opts.permanent ?? false },
        [id],
      ),
    );
  }

  /**
   * Restore a trashed object and its subtree (object.restore — the same
   * first-class convergent op the undo journal and the merge flow compose;
   * LWW vs delete by log order). No-op when the node is active or unknown —
   * the op itself is idempotent, and the guard avoids noise writes. This is
   * the web surface the CLI's `object restore` already had.
   */
  async restoreObject(id: string): Promise<void> {
    const node = this.getNodeRaw(id);
    if (node === undefined || node.isActive) return;
    this.enqueueLocal(this.buildEnvelope("object.restore", { objectId: id }, [id]));
  }

  /**
   * Empty the trash (trash.empty): permanently delete every soft-trashed
   * subtree root. The op evaluates the set at apply time — an object.restore
   * that lands before it survives, one after is log-order LWW. Irreversible,
   * so the Trash hub confirms first; permanent deletes never enter the undo
   * journal. No-op when the trash is already empty (the applier no-ops).
   */
  async emptyTrash(): Promise<void> {
    this.enqueueLocal(this.buildEnvelope("trash.empty", {}, []));
  }

  /**
   * Reparent a node (outliner indent/outdent gesture) — issues `object.move`.
   * `parentId` null means workspace root — legal for any non-class node (a
   * parentless node simply renders with document chrome; only a class under
   * a parent violates the store's placement CHECK). Pass `afterId` to land
   * the node immediately after that sibling in the parent's child order
   * (Enter placement); omit it to append at the end (Tab indent). Applied
   * locally, push kicked off.
   */
  async moveObject(
    id: string,
    parentId: string | null,
    afterId?: string,
    beforeId?: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = { objectId: id, parentId };
    if (afterId !== undefined) payload.afterId = afterId;
    if (beforeId !== undefined) payload.beforeId = beforeId;
    this.enqueueLocal(this.buildEnvelope("object.move", payload, [id]));
  }

  /**
   * Merge one page into another (SCHEMA.md "Node merge"): `planMerge` computes
   * the deterministic plan of EXISTING ops from the local store's read state —
   * children move, class/tag/property/collection remap, mention +
   * property-reference rewrites, field copy, the source trash LAST — and the
   * client applies the whole plan as ONE undo-journal batch (a single undo
   * restores the merge). `MergeGuardError` fails loud before any op is
   * emitted; the wire is untouched (every op is an ordinary convergent op).
   */
  async mergeNodes(sourceId: string, targetId: string): Promise<MergePlanSummary> {
    const plan = planMerge(this.store.database, sourceId, targetId);
    this.undoJournal.batch(() => {
      for (const op of plan.ops) {
        this.enqueueLocal(
          this.buildEnvelope(op.opType, op.payload, [plan.sourceId, plan.targetId]),
        );
      }
    });
    return plan.summary;
  }

  /**
   * OR-set class membership add (the `#` / `+` set gesture). No-op when the
   * class is already assigned. Membership is NOT an object.update field:
   * class_ids is a CRDT OR-Set whose add carrier is a re-issued
   * object.create on the same id — the applier's exists-branch seeds
   * class_member_set add-wins per pair without touching the tree
   * (store/appliers.ts applyObjectCreate, conflicts.ts class_conflict).
   * Immediate (not debounced) — a discrete gesture with the same optimistic
   * envelope path as any write.
   */
  async assignClass(id: string, classId: string): Promise<void> {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`assignClass: node ${id} not found`);
    if (node.classIds.includes(classId)) return;
    await this.createObject({
      id,
      parentId: node.parentId,
      contentAst: node.contentAst,
      classIds: [classId],
      // exactOptionalPropertyTypes: only present the key when set.
      ...(node.name !== null ? { name: node.name } : {}),
    });
  }

  /**
   * OR-set class membership remove — the class chip's × gesture
   * (class.unassign). No-op when the class is not assigned. The applier
   * tombstones the class_member_set pair add-wins and recomputes class_ids;
   * the effective read drops the class's derived defaults automatically and
   * authored property values survive (SCHEMA.md "Class properties").
   * Immediate (not debounced) — a discrete gesture, same optimistic envelope
   * path as any write.
   */
  /**
   * User-defined class ORDER (class.reorder, display-only LWW): writes the
   * full ordered member list; the applier keeps ordered members first and
   * appends any unlisted members sorted by id.
   */
  async reorderClasses(id: string, classIds: string[]): Promise<void> {
    this.enqueueLocal(this.buildEnvelope("class.reorder", { objectId: id, classIds }, [id]));
  }

  async unassignClass(id: string, classId: string): Promise<void> {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`unassignClass: node ${id} not found`);
    if (!node.classIds.includes(classId)) return;
    // Owner rule: authored values that merely MIRROR the departing
    // class's binding defaults carry no user data — the user never put
    // anything in that property. Sweep them (unset envelopes, explicit ops —
    // every client converges) before the membership remove. The provenance
    // flag (owner directive — value metadata, wire-neutral) makes
    // the call EXACT where present:
    //   metadata.provenance === "system" → the system materialized it —
    //     sweep even when it differs from the default;
    //   metadata.provenance === "user"   → the user explicitly wrote it —
    //     NEVER sweep, even when it equals the default;
    //   absent (legacy data)             → the original mirror heuristic.
    const bindings = this.getClassBindings(classId);
    if (bindings.length > 0) {
      const authored = this.getEffectiveProperties(id).filter((row) => row.source === "authored");
      for (const binding of bindings) {
        const defaultJson = JSON.stringify(binding.defaultValue ?? null);
        for (const row of authored) {
          if (row.propertySchemaId !== binding.propertySchemaId) continue;
          const provenance =
            typeof row.metadata?.provenance === "string" ? row.metadata.provenance : null;
          const mirrorsDefault =
            JSON.stringify(row.value) === defaultJson &&
            binding.defaultValue !== null &&
            binding.defaultValue !== undefined;
          const sweep =
            provenance === "system" ? true : provenance === "user" ? false : mirrorsDefault;
          if (!sweep) continue;
          const payload: Record<string, unknown> = {
            objectId: id,
            propertySchemaId: binding.propertySchemaId,
          };
          // PG5: unset by element id when the row carries a writer-minted
          // UUID element; the deterministic composite (node:schema:idx) is
          // not uuid-shaped — those rows unset by idx.
          if (
            typeof row.elementId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.elementId)
          ) {
            payload.elementId = row.elementId;
          } else {
            payload.idx = row.idx;
          }
          this.enqueueLocal(this.buildEnvelope("property.unset", payload, [id]));
        }
      }
    }
    this.enqueueLocal(this.buildEnvelope("class.unassign", { objectId: id, classId }, [id]));
  }

  /**
   * Assign a tag (any page) to a node — pages AND blocks (owner rule:
   * tags are node-scoped, the block metadata section renders them). The
   * add carrier is a re-issued object.create with the single tag, the same
   * OR-Set convergence pattern as classes.
   */
  async assignTag(id: string, tagId: string): Promise<void> {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`assignTag: node ${id} not found`);
    if (node.tagIds.includes(tagId)) return;
    await this.createObject({
      id,
      parentId: node.parentId,
      contentAst: node.contentAst,
      tagIds: [tagId],
      ...(node.name !== null ? { name: node.name } : {}),
    });
  }

  /** Remove a tag (OR-Set tombstone; loses to a concurrent newer add). */
  async unassignTag(id: string, tagId: string): Promise<void> {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`unassignTag: node ${id} not found`);
    if (!node.tagIds.includes(tagId)) return;
    this.enqueueLocal(this.buildEnvelope("tag.unassign", { objectId: id, tagId }, [id]));
  }

  /**
   * Create a class (class.create: node row + class registry row — the
   * registry row is what keeps the extends closure rebuild authoritative).
   * The store seeds the hierarchy self-row at create time, so no setExtends
   * is needed for a class that never extends anything.
   * Returns the new class id. Applied locally, push kicked off.
   */
  async createClass(
    name: string,
    opts?: { icon?: string; color?: string; id?: string },
  ): Promise<string> {
    // Caller-chosen id (the object.create pattern): system authoring
    // (ensureTaskFamily) creates the task class at its reserved seed id.
    const id = opts?.id ?? uuidv7();
    // Title-is-content: the class's name becomes its (text-only) content.
    const payload: Record<string, unknown> = {
      classId: id,
      contentAst: [{ type: "text", text: name }],
    };
    if (opts?.icon !== undefined) payload.icon = opts.icon;
    if (opts?.color !== undefined) payload.color = opts.color;
    this.enqueueLocal(this.buildEnvelope("class.create", payload, [id]));
    return id;
  }

  /**
   * Replace a class's full extends parent set (class.setExtends — m2m,
   * replace semantics; an empty array detaches all parents). The store keeps
   * the transitive closure in sync and fails loud on cycles (CycleError),
   * which callers surface as a transient message.
   */
  async setClassExtends(classId: string, parentClassIds: string[]): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "class.setExtends",
        { classId, parentClassIds },
        [classId, ...parentClassIds],
      ),
    );
  }

  /**
   * Upsert a class → property-schema binding (class.property.set). The
   * payload PATCHES the row: omitted fields keep their existing values.
   * Applied locally, push kicked off.
   */
  async setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): Promise<void> {
    const payload: Record<string, unknown> = { classId, propertySchemaId };
    if (fields.sequence !== undefined) payload.sequence = fields.sequence;
    if (fields.required !== undefined) payload.required = fields.required;
    if (fields.defaultValue !== undefined) payload.defaultValue = fields.defaultValue;
    if (fields.active !== undefined) payload.active = fields.active;
    this.enqueueLocal(this.buildEnvelope("class.property.set", payload, [classId]));
  }

  /** Remove a class → property-schema binding (class.property.unset). */
  async unsetClassProperty(classId: string, propertySchemaId: string): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "class.property.unset",
        { classId, propertySchemaId },
        [classId],
      ),
    );
  }

  /**
   * Create a property schema (propertySchema.create); returns the new id.
   * The bindings picker's "+ new schema" path.
   */
  async createPropertySchema(input: CreatePropertySchemaInput): Promise<string> {
    const id = input.id ?? uuidv7();
    const payload: Record<string, unknown> = {
      propertySchemaId: id,
      name: input.name,
      type: input.type,
    };
    if (input.multi !== undefined) payload.multi = input.multi;
    if (input.scope !== undefined) payload.scope = input.scope;
    if (input.options !== undefined) payload.options = input.options;
    if (input.targetClassFilter !== undefined) payload.targetClassFilter = input.targetClassFilter;
    if (input.datePrecision !== undefined) payload.datePrecision = input.datePrecision;
    if (input.dateQualified !== undefined) payload.dateQualified = input.dateQualified;
    this.enqueueLocal(this.buildEnvelope("propertySchema.create", payload, []));
    return id;
  }

  /**
   * Patch a property schema's metadata (propertySchema.update): name/options
   * plus the SCHEMA.md "Dates" fields (the Class View bindings editor's
   * precision/qualified controls). Omitted fields keep their values.
   */
  async updatePropertySchema(propertySchemaId: string, fields: UpdatePropertySchemaInput): Promise<void> {
    const payload: Record<string, unknown> = { propertySchemaId };
    if (fields.name !== undefined) payload.name = fields.name;
    if (fields.options !== undefined) payload.options = fields.options;
    if (fields.datePrecision !== undefined) payload.datePrecision = fields.datePrecision;
    if (fields.dateQualified !== undefined) payload.dateQualified = fields.dateQualified;
    if (fields.numberPad !== undefined) payload.numberPad = fields.numberPad;
    if (fields.numberDecimals !== undefined) payload.numberDecimals = fields.numberDecimals;
    if (fields.numberRounding !== undefined) payload.numberRounding = fields.numberRounding;
    if (fields.display !== undefined) payload.display = fields.display;
    if (fields.readonly !== undefined) payload.readonly = fields.readonly;
    if (fields.hideWhenEmpty !== undefined) payload.hideWhenEmpty = fields.hideWhenEmpty;
    this.enqueueLocal(this.buildEnvelope("propertySchema.update", payload, []));
  }

  /**
   * Soft-delete a property schema (propertySchema.delete — the conversion
   * flow's final step). Authored values under the schema survive
   * in the log; recreate-under-the-same-id reactivates (the applier upsert).
   */
  async deletePropertySchema(propertySchemaId: string): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope("propertySchema.delete", { propertySchemaId }, []),
    );
  }

  /**
   * Author a property value (property.set) — the panel's edit path. Writing
   * an authored value shadows any derived class-binding default at the slot.
   * `metadata` carries per-value qualifiers (SCHEMA.md "Dates": dateQualified
   * schemas persist startDate/endDate here).
   */
  async setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx = 0,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const payload: Record<string, unknown> = { objectId, propertySchemaId, value, idx };
    if (metadata !== undefined) payload.metadata = metadata;
    this.enqueueLocal(this.buildEnvelope("property.set", payload, [objectId]));
  }

  /** Clear an authored property value (property.unset) — the default resurfaces. */
  async unsetProperty(objectId: string, propertySchemaId: string, idx = 0): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "property.unset",
        { objectId, propertySchemaId, idx },
        [objectId],
      ),
    );
  }

  /**
   * "Promote to block" (SCHEMA.md "Node-backed text properties"): detach a
   * node-backed text property value and surface the carrier in the owner's
   * body as an ordinary child. Composed from existing ops — property.unset
   * (whose applier trashes the now-unreferenced carrier, trash + retention
   * per the spec) followed by object.restore (revives the carrier subtree as
   * a body child; a safe no-op when the unset left it alive, e.g. another
   * slot still references it). Display state only: no move op — the carrier
   * keeps its tree position and renders in the body once no value references
   * it. Fails loud when the slot holds no authored value or the value is not
   * a node-backed reference.
   */
  async promotePropertyCarrier(objectId: string, propertySchemaId: string, idx = 0): Promise<void> {
    const row = this.store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
      )
      .get(objectId, propertySchemaId, idx) as { value: string } | undefined;
    if (row === undefined) {
      throw new Error(
        `promotePropertyCarrier: no authored value at ${propertySchemaId}:${idx} on ${objectId}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = undefined;
    }
    const carrier =
      typeof parsed === "object" && parsed !== null && "nodeId" in parsed
        ? String((parsed as { nodeId: unknown }).nodeId)
        : typeof parsed === "string" && UUID_LIKE.test(parsed)
          ? parsed
          : null;
    if (carrier === null) {
      throw new Error(
        `promotePropertyCarrier: value at ${propertySchemaId}:${idx} is not a node-backed carrier reference`,
      );
    }
    // One gesture, two envelopes: journal them as a single entry (the unset
    // and the restore undo together, in reverse).
    this.undoJournal.batch(() => {
      this.enqueueLocal(
        this.buildEnvelope("property.unset", { objectId, propertySchemaId, idx }, [objectId]),
      );
      this.enqueueLocal(
        this.buildEnvelope("object.restore", { objectId: carrier }, [objectId, carrier]),
      );
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

  // --- assets (REST upload + op-log link) -------------------------------------

  private requireRest(): { serverUrl: string; apiKey: string } {
    if (this.restServerUrl === null || this.restApiKey === null) {
      throw new Error(
        "WorkspaceClient: this call requires serverUrl + apiKey (use createHttp)",
      );
    }
    return { serverUrl: this.restServerUrl, apiKey: this.restApiKey };
  }

  // --- per-user UI prefs (favorites/recents — server-side UI state) -------------

  /**
   * GET /api/me/prefs (session or API-key credential). On success the local
   * cache is refreshed so device-local readers (sidebar lists, palette
   * Recent) see the same source. Offline/unreachable (or a client without
   * REST config): the cached copy answers, tagged `source: "local"`.
   */
  async getPrefs(): Promise<UserPrefs & { source: UserPrefsSource }> {
    if (this.restServerUrl !== null && this.restApiKey !== null) {
      try {
        const response = await fetch(`${this.restServerUrl.replace(/\/$/, "")}/api/me/prefs`, {
          headers: { "X-API-Key": this.restApiKey },
        });
        if (response.ok) {
          const prefs = normalizeUserPrefs(await response.json());
          writeDevicePrefList("favorites", prefs.favorites);
          writeDevicePrefList("recents", prefs.recents);
          return { ...prefs, source: "server" };
        }
      } catch {
        // Unreachable — the cached copy below is the honest offline answer.
      }
    }
    return {
      favorites: readDevicePrefList("favorites"),
      recents: readDevicePrefList("recents"),
      source: "local",
    };
  }

  /**
   * PUT /api/me/prefs (merge patch; each present list replaces wholesale).
   * The local cache updates first — optimistic and honest offline: when the
   * server cannot be reached the write persists device-locally and the next
   * successful call syncs it. Resolves `source: "server" | "local"`.
   */
  async patchPrefs(patch: PrefsPatch): Promise<UserPrefs & { source: UserPrefsSource }> {
    const merged: UserPrefs = {
      favorites: patch.favorites ?? readDevicePrefList("favorites"),
      recents: patch.recents ?? readDevicePrefList("recents"),
    };
    if (patch.favorites !== undefined) writeDevicePrefList("favorites", patch.favorites);
    if (patch.recents !== undefined) writeDevicePrefList("recents", patch.recents);
    if (this.restServerUrl !== null && this.restApiKey !== null) {
      try {
        const response = await fetch(`${this.restServerUrl.replace(/\/$/, "")}/api/me/prefs`, {
          method: "PUT",
          headers: { "X-API-Key": this.restApiKey, "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (response.ok) {
          const prefs = normalizeUserPrefs(await response.json());
          writeDevicePrefList("favorites", prefs.favorites);
          writeDevicePrefList("recents", prefs.recents);
          return { ...prefs, source: "server" };
        }
      } catch {
        // Unreachable — the local write above already landed.
      }
    }
    return { ...merged, source: "local" };
  }

  // --- per-user hosted section views (custom tabs — the prefs channel) --------

  private sectionViewsUrl(nodeId: string, sectionKey: string, suffix = ""): string {
    const { serverUrl } = this.requireRest();
    return `${serverUrl.replace(/\/$/, "")}/api/me/nodes/${encodeURIComponent(nodeId)}/sections/${encodeURIComponent(sectionKey)}/views${suffix}`;
  }

  /** GET the section's custom views in tab order. Throws when the server answers non-ok. */
  async listSectionViews(nodeId: string, sectionKey: string): Promise<SectionView[]> {
    const { apiKey } = this.requireRest();
    const response = await fetch(this.sectionViewsUrl(nodeId, sectionKey), {
      headers: { "X-API-Key": apiKey },
    });
    if (!response.ok) {
      throw new Error(
        `list section views failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return normalizeSectionViewList(await response.json());
  }

  /** POST a new view (appended after the last tab). Throws on 4xx/5xx (409 = name collision). */
  async createSectionView(input: {
    nodeId: string;
    sectionKey: string;
    name: string;
    queryAst: unknown;
    viewMode?: string | null;
  }): Promise<SectionView> {
    const { apiKey } = this.requireRest();
    const response = await fetch(this.sectionViewsUrl(input.nodeId, input.sectionKey), {
      method: "POST",
      headers: { "X-API-Key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        queryAst: input.queryAst,
        ...(input.viewMode != null ? { viewMode: input.viewMode } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(
        `create section view failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return normalizeSectionView((await response.json()).view);
  }

  /** PATCH a view's name. 404 = missing/foreign row (also throws). */
  async renameSectionView(
    nodeId: string,
    sectionKey: string,
    viewId: string,
    name: string,
  ): Promise<SectionView> {
    const { apiKey } = this.requireRest();
    const response = await fetch(
      this.sectionViewsUrl(nodeId, sectionKey, `/${encodeURIComponent(viewId)}`),
      {
        method: "PATCH",
        headers: { "X-API-Key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `rename section view failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return normalizeSectionView((await response.json()).view);
  }

  /** PUT the full ordered id list; sequences rewrite 0..n-1. Throws on an incomplete list. */
  async reorderSectionViews(
    nodeId: string,
    sectionKey: string,
    orderedIds: string[],
  ): Promise<SectionView[]> {
    const { apiKey } = this.requireRest();
    const response = await fetch(this.sectionViewsUrl(nodeId, sectionKey, "/order"), {
      method: "PUT",
      headers: { "X-API-Key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ orderedIds }),
    });
    if (!response.ok) {
      throw new Error(
        `reorder section views failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return normalizeSectionViewList(await response.json());
  }

  /** DELETE a view (204). 404 = missing/foreign row (also throws). */
  async deleteSectionView(nodeId: string, sectionKey: string, viewId: string): Promise<void> {
    const { apiKey } = this.requireRest();
    const response = await fetch(
      this.sectionViewsUrl(nodeId, sectionKey, `/${encodeURIComponent(viewId)}`),
      { method: "DELETE", headers: { "X-API-Key": apiKey } },
    );
    if (!response.ok) {
      throw new Error(
        `delete section view failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
  }

  /**
   * Upload file bytes to the server's CAS asset store (POST /api/assets).
   * Returns the server-issued asset metadata; the caller links it into the
   * graph (asset node + property.set) — this method does NOT touch the store.
   */
  async uploadAsset(file: Blob, filename: string): Promise<AssetUploadResult> {
    const { serverUrl, apiKey } = this.requireRest();
    return postAssetUpload(serverUrl, apiKey, this.workspaceId, file, filename);
  }

  /**
   * Record an uploaded asset on a node (asset.attach op, the same envelope
   * the server submits when the multipart carries an objectId). Enqueued
   * client-side so the derived node_asset row — and with it the attachment
   * chip's name/download read — is local immediately (local-first), then
   * pushed with the rest of the outbox.
   */
  async attachAsset(objectId: string, asset: AssetUploadResult): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "asset.attach",
        {
          objectId,
          assetId: asset.assetId,
          hash: asset.hash,
          mimeType: asset.mimeType,
          size: asset.size,
          originalName: asset.originalName,
        },
        [objectId, asset.assetId],
      ),
    );
  }

  /**
   * Download an asset's bytes (GET /api/assets/:id, workspace key) — the raw
   * read the export engine's include-assets bundle uses (distinct from
   * downloadAsset, which opens a tab, and getAssetDataUrl, images only).
   */
  async fetchAssetBytes(assetId: string): Promise<Blob> {
    const { serverUrl, apiKey } = this.requireRest();
    return fetchAssetBlob(serverUrl, apiKey, assetId, this.workspaceId);
  }

  /**
   * Download an asset's bytes (GET /api/assets/:id, workspace key) and open
   * them in a new tab as a blob URL — the key stays out of any URL.
   */
  async downloadAsset(assetId: string): Promise<void> {
    const { serverUrl, apiKey } = this.requireRest();
    const blob = await fetchAssetBlob(serverUrl, apiKey, assetId);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
  }

  /**
   * Property value history feed: paginated GET /api/operations
   * (the relay-log read), filtered client-side to property.* ops
   * for one node + schema, newest-first by HLC. The feed entries are
   * envelope-v3 objects — seq, hlc, actor, timestamp, payload — everything
   * the history modal renders. Throws when the feed is unreachable (the
   * modal renders the device-local note); bounded at 30 pages (300k
   * envelopes) so a huge log cannot hang the UI.
   */
  async fetchOperationsFor(
    objectId: string,
    propertySchemaId: string,
  ): Promise<OperationFeedEntry[]> {
    const matches = (op: OperationFeedEntry): boolean =>
      (op.opType === "property.set" || op.opType === "property.unset") &&
      typeof op.payload === "object" &&
      op.payload !== null &&
      op.payload.objectId === objectId &&
      op.payload.propertySchemaId === propertySchemaId;
    return this.fetchOperationFeed(matches);
  }

  /**
   * Per-node version history feed: the same relay-log read filtered to the
   * ops whose payload names THIS node as `objectId` — object.create/update/
   * delete/restore/move, property.set/unset, class/tag unassigns, asset
   * attach/detach. Newest-first by HLC; same 30-page bound and the same
   * throw-when-unreachable contract as the property feed (the section
   * renders the device-local note). This is a pure projection slice — the
   * wire is untouched.
   */
  async fetchNodeHistory(nodeId: string): Promise<OperationFeedEntry[]> {
    const matches = (op: OperationFeedEntry): boolean =>
      typeof op.payload === "object" &&
      op.payload !== null &&
      op.payload.objectId === nodeId;
    return this.fetchOperationFeed(matches);
  }

  /**
   * The paged GET /api/operations relay-log read both history feeds share:
   * envelope-v3 entries trimmed to seq/hlc/actor/timestamp/payload, filtered
   * by `matches`, sorted newest-first by HLC. Bounded at 30 pages (300k
   * envelopes) so a huge log cannot hang the UI; throws when the feed is
   * unreachable.
   */
  private async fetchOperationFeed(
    matches: (op: OperationFeedEntry) => boolean,
  ): Promise<OperationFeedEntry[]> {
    const { serverUrl, apiKey } = this.requireRest();
    const entries: OperationFeedEntry[] = [];
    let afterSeq = 0;
    for (let page = 0; page < 30; page++) {
      const url = `${serverUrl.replace(/\/$/, "")}/api/operations?afterSeq=${afterSeq}&limit=10000`;
      const response = await fetch(url, {
        headers: { "X-API-Key": apiKey, "X-Workspace-Id": this.workspaceId },
      });
      if (!response.ok) {
        throw new Error(`operations feed failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        operations: OperationFeedEntry[];
        nextAfterSeq: number;
        hasMore: boolean;
      };
      for (const op of body.operations) {
        if (matches(op)) entries.push(op);
      }
      if (!body.hasMore) break;
      afterSeq = body.nextAfterSeq;
    }
    entries.sort(
      (a, b) =>
        b.hlc.physical - a.hlc.physical ||
        b.hlc.logical - a.hlc.logical ||
        (a.seq < b.seq ? 1 : -1),
    );
    return entries;
  }

  /**
   * Push pending outbox ops now. Writes only kick a best-effort push; await
   * this when delivery must be deterministic (tests, "save & close"). The
   * engine's onPush/onPull callbacks notify with change-info — no wrapper
   * notify (an empty outbox changes nothing).
   */
  async push(): Promise<void> {
    await this.requireEngine().push();
  }

  /** Pull now: snapshot shortcut when newer, then seq catch-up. */
  async pull(): Promise<void> {
    await this.requireEngine().pull();
  }

  // --- realtime (WS acceleration path) ------------------------------------------------

  /**
   * Wire the transport's realtime channel: remote ops frames apply straight
   * to the store (buffered around pulls; the seq cursor remains
   * authoritative) and connection state changes notify subscribers so the UI
   * can refresh its status. Idempotent — restarts the channel when already
   * running.
   */
  startRealtime(): void {
    const engine = this.requireEngine();
    this.stopRealtime();
    const stopChannel = engine.startRealtime();
    // Engine status transitions reach subscribers, but a status flip is not
    // data churn: notify with an explicitly empty change set so the read
    // cache invalidates nothing (the footer re-reads status on the same
    // notification).
    const stopStatus = engine.subscribeStatus(() =>
      this.notify({ affectedNodeIds: [], structural: false }),
    );
    this.realtimeStop = () => {
      stopStatus();
      stopChannel();
    };
    this.notify();
  }

  stopRealtime(): void {
    if (this.realtimeStop === null) return;
    this.realtimeStop();
    this.realtimeStop = null;
    this.notify();
  }

  isRealtimeActive(): boolean {
    return this.realtimeStop !== null;
  }

  // --- status snapshot (sync UI) ---------------------------------------------------------

  /** Recent semantic conflicts (newest last, bounded at CONFLICT_LOG_CAP). */
  conflictHistory(): ConflictHistoryEntry[] {
    return [...this.conflictLog];
  }

  /** Engine + outbox + realtime state for the footer status indicator. */
  status(): SyncStatusSnapshot {
    if (this.engine === null) return { ...IDLE_SNAPSHOT };
    const counts = this.engine.getOutboxCounts();
    return {
      status: this.engine.getStatus(),
      error: this.engine.getLastError()?.message ?? null,
      pending: counts.pending,
      failed: counts.failed,
      quarantined: counts.quarantined,
      parked: this.engine.getParkedCount(),
      realtime: this.isRealtimeActive(),
      cursorSeq: this.engine.getCursorSeq(),
    };
  }

  /**
   * Apply a batch of remote envelopes (realtime frames / external injection)
   * through the engine: one store transaction, conflict detection against
   * local pending ops, HLC merge. Unknown seqs (null) keep the cursor; the
   * next pull re-fetches anything the batch covered. The notification carries
   * the batch's own change-info (the engine's onRemoteBatch callback fires
   * from inside onRemoteBatch only when no pull defers it — this wrapper
   * notify also covers the deferred and zero-applied paths).
   */
  applyRemoteBatch(envelopes: Envelope[], seqs?: Record<string, number> | null): void {
    this.requireEngine().onRemoteBatch(envelopes, seqs ?? {});
    const info = summarizeEnvelopes(envelopes);
    // Remote envelopes may carry incomplete affected metadata; when we can
    // infer nothing, fall back to the scope-unknown notification (full
    // invalidation) rather than silently refreshing nothing.
    if (info.affectedNodeIds.length === 0 && !info.structural) this.notify();
    else this.notifyFromInfo(info);
  }


  // --- notifications -----------------------------------------------------------






}
