/**
 * The session-local undo-journal domain: the pre-apply capture source (pure
 * store reads behind the inversion matrix) and the undo/redo/history chrome
 * API. The journal composes existing ops through the normal write path —
 * see undo-journal.ts for the inversion matrix. Standalone domain — takes
 * the shared ClientContext, no inheritance.
 */

import type {
  UndoCaptureSource,
  UndoHistoryEntry,
  UndoUiState,
} from "../undo-journal.js";
import type { ClientContext } from "./client-context.js";
import { parseContentAst, parseListStyle } from "./mappers.js";

/**
 * The journal's pre-apply read seam — pure store reads (see undo-journal.ts).
 * A standalone factory (not a domain method): the ClientContext constructs
 * its UndoJournal at context-construction time, before any domain exists,
 * so the context takes this factory and calls it with itself.
 */
export function buildUndoCaptureSource(ctx: ClientContext): UndoCaptureSource {
  const db = () => ctx.store.database;
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
      const row = ctx.store.getNode(id);
      if (row === undefined) return null;
      return {
        isClass: row.is_class === 1,
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
      const row = ctx.store.getNode(id);
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
    propertyValues: (objectId, propertySchemaId) => {
      const rows = db()
        .prepare(
          "SELECT id, idx, value, metadata FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id",
        )
        .all(objectId, propertySchemaId) as Array<{
        id: string;
        idx: number;
        value: string;
        metadata: string | null;
      }>;
      return rows.map((row) => {
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
      });
    },
    classBinding: (classId, propertySchemaId) => {
      const row = db()
        .prepare(
          `SELECT active
           FROM class_property WHERE class_id = ? AND property_schema_id = ?`,
        )
        .get(classId, propertySchemaId) as
        | {
            active: number;
          }
        | undefined;
      if (row === undefined) return null;
      return {
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
          `SELECT name, type, multi, icon, scope_class_ids, validation_rules, options, target_class_filter, date_precision, date_qualified,
                  display, hide_when_empty, default_value
           FROM property_schema WHERE id = ?`,
        )
        .get(propertySchemaId) as
        | {
            name: string;
            type: string;
            multi: number;
            icon: string | null;
            scope_class_ids: string | null;
            validation_rules: string | null;
            options: string;
            target_class_filter: string | null;
            date_precision: string | null;
            date_qualified: number | null;
            display: string | null;
            hide_when_empty: number | null;
            default_value: string | null;
          }
        | undefined;
      if (row === undefined) return null;
      const filter = parseJson(row.target_class_filter);
      return {
        name: row.name,
        type: row.type,
        multi: row.multi === 1,
        icon: row.icon,
        scopeClassIds: (() => {
          const parsed = parseJson(row.scope_class_ids);
          return Array.isArray(parsed)
            ? parsed.filter((v): v is string => typeof v === "string")
            : null;
        })(),
        validationRules: (() => {
          const parsed = parseJson(row.validation_rules);
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as { min?: number; max?: number; pattern?: string })
            : null;
        })(),
        options: parseJson(row.options),
        targetClassFilter: Array.isArray(filter)
          ? filter.filter((v): v is string => typeof v === "string")
          : null,
        datePrecision: row.date_precision,
        dateQualified: nullableBool(row.date_qualified),
        display: row.display === "bullet" || row.display === "inline" ? row.display : null,
        hideWhenEmpty: nullableBool(row.hide_when_empty),
        defaultValue: row.default_value === null ? null : parseJson(row.default_value),
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
    propertyAssignment: (objectId, propertySchemaId) => {
      const row = db()
        .prepare(
          "SELECT 1 FROM node_property WHERE node_id = ? AND property_schema_id = ?",
        )
        .get(objectId, propertySchemaId);
      return row !== undefined;
    },
    featureEnabled: (feature) => {
      const row = db()
        .prepare(
          "SELECT enabled FROM workspace_feature WHERE workspace_id = ? AND feature = ?",
        )
        .get(ctx.workspaceId, feature) as { enabled: number } | undefined;
      // Absent row = enabled (the empty-table default).
      return row === undefined || row.enabled === 1;
    },
    featureSettings: (feature) => {
      const row = db()
        .prepare(
          "SELECT settings FROM workspace_feature WHERE workspace_id = ? AND feature = ?",
        )
        .get(ctx.workspaceId, feature) as { settings: string | null } | undefined;
      // Absent row OR old-shape payload (the stored NULL) = undefined —
      // distinct from the real empty record {} (SCHEMA.md "Workspace
      // features"); the feature-set inverse restores the absence honestly.
      if (row === undefined || row.settings === null) return undefined;
      return JSON.parse(row.settings) as Record<string, unknown>;
    },
    externalRefTarget: (ref) => ctx.store.resolveExternalRef(ctx.workspaceId, ref),
  };
}

export class WorkspaceClientUndo {
  constructor(private readonly ctx: ClientContext) {}

  // --- undo journal -------------------------------------------------------------

  /**
   * The session journal state for chrome (keymap gating, palette
   * rows): availability plus the "Undo <verb>" / "Redo <verb>" labels. Async
   * to match the WorkerClient proxy (the union type is what App consumes).
   */
  async undoState(): Promise<UndoUiState> {
    return this.ctx.engine === null
      ? { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
      : this.ctx.undoJournal.state();
  }

  /**
   * The browsable history behind the jump-to menu: the undo stack
   * oldest-first with labels + timestamps + affected node ids. Empty when
   * the journal is (new session, new workspace).
   */
  async undoHistory(): Promise<UndoHistoryEntry[]> {
    return this.ctx.engine === null ? [] : this.ctx.undoJournal.history();
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
    const entry = this.ctx.undoJournal.takeUndo();
    if (entry === null) return false;
    try {
      this.ctx.undoJournal.batch(() => {
        for (const spec of entry.inverseSpecs) {
          this.ctx.enqueueLocal(
            this.ctx.buildEnvelope(spec.opType, spec.payload, spec.affected),
            "undo",
            entry.verb,
          );
        }
      });
    } catch (error) {
      this.ctx.undoJournal.restoreUndo(entry);
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
    const entry = this.ctx.undoJournal.takeRedo();
    if (entry === null) return false;
    try {
      this.ctx.undoJournal.batch(() => {
        for (const spec of entry.inverseSpecs) {
          this.ctx.enqueueLocal(
            this.ctx.buildEnvelope(spec.opType, spec.payload, spec.affected),
            "redo",
            entry.verb,
          );
        }
      });
    } catch (error) {
      this.ctx.undoJournal.restoreRedo(entry);
      throw error;
    }
    return true;
  }

  /** Test/dev seam: how many entries the session journal currently holds. */
  undoDepth(): { undo: number; redo: number } {
    return { undo: this.ctx.undoJournal.undoDepth(), redo: this.ctx.undoJournal.redoDepth() };
  }
}
