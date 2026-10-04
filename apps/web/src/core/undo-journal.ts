/**
 * undo-journal.ts — the session-local op-inverse undo journal (§34.64).
 *
 * Model law: the operation log is the only authority, and this journal is a
 * pure CLIENT convenience — it never invents a new op type. Every locally
 * authored envelope the client successfully applies through its outbox path
 * is recorded with its INVERSE intent, where the inverse is composed EXCLUSIVELY
 * from existing ops whose payloads were captured from the store AT APPLY TIME
 * (the pre-op snapshot lives in the journal entry). Undo/redo therefore ride
 * the normal write path as ordinary ops and converge like any other write.
 *
 * Session-local honesty: the journal is in-memory, per client, per tab. It
 * never claims cross-tab or cross-device undo — another device's ops never
 * enter it (only this client's outbox ops are recorded), a reload starts an
 * empty journal, and the durable unpushed-backlog replay at bootstrap
 * deliberately bypasses it.
 *
 * The editor-interaction rule (docs/ux.md "Undo and redo"): while a text
 * field or the outliner editor (contentEditable) owns the focus, the local
 * text behavior keeps the keystroke and the global journal stays out of the
 * way; every other surface (structural gestures, property edits, deletes,
 * moves, renames) is journaled and reachable via the global chords.
 *
 * The inversion matrix (invertEnvelope below) — per op family:
 *
 *  - object.update      → object.update restoring the pre-op values of
 *                         exactly the touched fields (captured). A prior
 *                         NULL icon/description cannot be expressed on the
 *                         wire (the payload grammar has no icon/description
 *                         clear) — such an update is NOT journaled rather
 *                         than half-undone.
 *  - object.create        → object.delete (soft — trash keeps the subtree
 *                         restorable). The re-issued create (the OR-Set add
 *                         carrier behind assign class/tag) inverts per added
 *                         membership: class.unassign / tag.unassign.
 *  - object.delete        → object.restore (soft deletes only; a PERMANENT
 *                         delete is data loss and is not journaled).
 *  - object.restore       → object.delete (soft).
 *  - object.move          → object.move to the prior parent, anchored by the
 *                         prior sibling read (afterId, else beforeId) so the
 *                         node lands where it stood; roots carry no anchor
 *                         (root display order is name-sorted, not positional).
 *  - property.set         → property.set with the captured prior row (value +
 *                         idx + elementId + metadata), or property.unset when
 *                         the slot was empty. A PG5 element add inverts as an
 *                         element-addressed remove.
 *  - property.unset       → property.set restoring the captured row (nothing
 *                         to restore → the unset is a no-op, not journaled).
 *  - class.unassign       → the add carrier: object.create {classIds:[id]}.
 *  - tag.unassign         → the add carrier: object.create {tagIds:[id]}.
 *  - class.reorder        → class.reorder with the prior effective order.
 *  - class.property.set   → class.property.set restoring the touched binding
 *                         fields; a first-time bind inverts as
 *                         class.property.unset.
 *  - class.property.unset → class.property.set restoring the full captured row.
 *  - class.setExtends     → class.setExtends with the prior parent set.
 *  - class.create         → class.delete. (class.delete itself is NOT
 *                         journaled: the applier tombstones memberships.)
 *  - class.update         → class.update restoring touched fields (same NULL
 *                         icon/description caveat as object.update).
 *  - propertySchema.*     → create↔delete / update restoring touched fields
 *                         (the full prior row is captured).
 *  - asset.attach/detach  → detach/attach with the captured prior row.
 *  - collection.member.*  → the complement (membership captured; a redundant
 *                         add/remove is a no-op, not journaled).
 *  - workspace.feature.set→ the same op with the captured prior enabled state.
 *
 * Text coalescing: contiguous contentAst-only updates of one node inside a
 * short window merge into ONE entry, so typing-undo is paragraph-grained
 * (the standard editor expectation). Structural ops never coalesce.
 *
 * Wire wart on record: class.property.set cannot express "no default" —
 * default_value SQL NULL and an explicit JSON null are indistinguishable on
 * the write path. Undoing a default edit whose prior was NULL restores an
 * explicit JSON null (the closest honest value), noted here rather than
 * silently approximated.
 */

import type { ContentAst, Envelope } from "@notees/protocol";

/** One op to apply — op type + payload + affected ids (the buildEnvelope triple). */
export interface UndoOpSpec {
  opType: string;
  payload: Record<string, unknown>;
  affected: string[];
}

/** The journal-state slice the chrome renders (palette rows, keymap gating). */
export interface UndoUiState {
  canUndo: boolean;
  canRedo: boolean;
  /** "Undo edit text" — null when the stack is empty. */
  undoLabel: string | null;
  /** "Redo edit text" — null when the stack is empty. */
  redoLabel: string | null;
}

export const EMPTY_UNDO_STATE: UndoUiState = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
};

/**
 * One browsable history entry (§34.69 — v1's history menu with jump-to):
 * the label, the timestamp, and the node ids the entry touched. Jumping
 * opens the first affected node that still resolves — the honest move for a
 * session journal (it cannot restore a past caret or scroll position).
 */
export interface UndoHistoryEntry {
  /** The label verb ("edit text") — chrome renders "Undo <verb>". */
  verb: string;
  /** Last-edit time (ms epoch) — the menu's timestamp. */
  at: number;
  /** Node ids the entry's apply specs touched (deduped, in spec order). */
  affected: string[];
  /** `text:<nodeId>` for coalesced text edits — jumping is plain navigation. */
  coalesceKey: string | null;
}

// --- capture source ------------------------------------------------------------

/** Facts about a node row needed to invert ops that touched it. */
export interface UndoNodeSnapshot {
  presentAsMain: boolean;
  icon: string | null;
  color: string | null;
  contentAst: ContentAst;
  classIds: string[];
  tagIds: string[];
  active: boolean;
}

/** One property_value row, decoded (the row id IS the PG5 element id). */
export interface UndoPropertyValueSnapshot {
  elementId: string;
  idx: number;
  value: unknown;
  metadata: Record<string, unknown> | null;
}

/** One class_property binding row, decoded. */
export interface UndoBindingSnapshot {
  sequence: number;
  required: boolean | null;
  readonly: boolean | null;
  hideWhenEmpty: boolean | null;
  /** undefined = the row's default_value SQL NULL (no stored default). */
  defaultValue: unknown;
  active: boolean;
}

/** One property_schema row, decoded. */
export interface UndoSchemaSnapshot {
  name: string;
  type: string;
  multi: boolean;
  scope: string;
  options: unknown;
  targetClassFilter: string[] | null;
  datePrecision: string | null;
  dateQualified: boolean | null;
}

/** One node_asset row, decoded. */
export interface UndoAssetSnapshot {
  assetId: string;
  hash: string;
  mimeType: string;
  size: number;
  originalName: string;
}

/**
 * The pre-apply read seam: invertEnvelope asks these questions of the store
 * BEFORE the envelope is applied, so the answers are the honest pre-op state.
 * All reads are pure; the journal never writes through this interface.
 */
export interface UndoCaptureSource {
  /** The node's current row facts, null when the row is absent. */
  nodeSnapshot(id: string): UndoNodeSnapshot | null;
  /**
   * The node's current parent plus its sibling anchors under that parent
   * (afterId = preceding sibling, beforeId = following sibling — both null
   * when it stands alone or sits at the workspace root, where order is
   * name-sorted, not positional). Null when the node is absent.
   */
  nodePlacement(id: string): {
    parentId: string | null;
    afterId: string | null;
    beforeId: string | null;
  } | null;
  /** The class registry row's description (null when unset or absent). */
  classDescription(classId: string): string | null;
  /** The property_value row at the address (elementId wins over idx). */
  propertyValue(
    objectId: string,
    propertySchemaId: string,
    elementId: string | undefined,
    idx: number,
  ): UndoPropertyValueSnapshot | null;
  classBinding(classId: string, propertySchemaId: string): UndoBindingSnapshot | null;
  /** Direct extends parents, deterministic order. */
  classParents(classId: string): string[];
  schemaSnapshot(propertySchemaId: string): UndoSchemaSnapshot | null;
  assetSnapshot(objectId: string, assetId: string): UndoAssetSnapshot | null;
  collectionMembership(collectionId: string, objectId: string): boolean;
  /** Absent toggle row means enabled (the F2 empty-table default). */
  featureEnabled(feature: string): boolean;
}

// --- inversion -----------------------------------------------------------------

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The deterministic positional property element id (packages/store schema.ts —
 *  the single-value slot's row id, unchanged since pre-PG5). */
function positionalElementId(objectId: string, propertySchemaId: string, idx: number): string {
  return `${objectId}:${propertySchemaId}:${idx}`;
}

/** Restore spec for an object.update / class.update payload: exactly the
 *  touched fields, values from the snapshot. Returns null when a touched
 *  field cannot be honestly expressed on the wire. */
function restoreUpdateSpec(
  opType: "object.update" | "class.update",
  objectId: string,
  payload: Record<string, unknown>,
  snap: UndoNodeSnapshot,
  description: string | null,
): UndoOpSpec | null {
  const restore: Record<string, unknown> = { objectId };
  if (hasOwn(payload, "contentAst")) restore.contentAst = snap.contentAst;
  if (hasOwn(payload, "presentAsMain") && opType === "object.update") {
    restore.presentAsMain = snap.presentAsMain;
  }
  if (hasOwn(payload, "color")) restore.color = snap.color;
  if (hasOwn(payload, "icon")) {
    // The payload grammar has no "clear icon" — a prior NULL is inexpressible.
    if (snap.icon === null) return null;
    restore.icon = snap.icon;
  }
  if (hasOwn(payload, "description") && opType === "class.update") {
    if (description === null) return null;
    restore.description = description;
  }
  if (Object.keys(restore).length === 1) return null; // nothing touched — no-op
  return { opType, payload: restore, affected: [objectId] };
}

/**
 * Compute the inverse of one locally-authored envelope from the captured
 * pre-op state. Returns the inverse specs, or NULL when the envelope must
 * not enter the journal — either not honestly invertible (permanent delete,
 * class.delete, an inexpressible restore) or a structural no-op (restoring
 * an active node, unassigning what is not assigned, a redundant membership
 * flip). The journal only ever records local outbox ops, so every envelope
 * seen here is this client's own.
 */
export function invertEnvelope(
  envelope: Envelope,
  capture: UndoCaptureSource,
): UndoOpSpec[] | null {
  const p = envelope.payload as Record<string, unknown>;
  switch (envelope.opType) {
    case "object.create": {
      const objectId = asString(p.objectId);
      if (objectId === null) return null;
      const snap = capture.nodeSnapshot(objectId);
      if (snap === null) {
        // Fresh node: trash it (soft — the subtree survives for restore).
        return [
          {
            opType: "object.delete",
            payload: { objectId, permanent: false },
            affected: [objectId],
          },
        ];
      }
      // Re-issued create = the OR-Set add carrier (assign class/tag): invert
      // per membership the payload actually added.
      const addedClasses = asStringArray(p.classIds).filter((c) => !snap.classIds.includes(c));
      const addedTags = asStringArray(p.tagIds).filter((t) => !snap.tagIds.includes(t));
      if (addedClasses.length === 0 && addedTags.length === 0) return null;
      return [
        ...addedClasses.map((classId) => ({
          opType: "class.unassign",
          payload: { objectId, classId },
          affected: [objectId],
        })),
        ...addedTags.map((tagId) => ({
          opType: "tag.unassign",
          payload: { objectId, tagId },
          affected: [objectId],
        })),
      ];
    }
    case "object.update": {
      const objectId = asString(p.objectId);
      if (objectId === null || hasOwn(p, "contentDeltaB64")) return null;
      const snap = capture.nodeSnapshot(objectId);
      if (snap === null) return null;
      const spec = restoreUpdateSpec("object.update", objectId, p, snap, null);
      return spec === null ? null : [spec];
    }
    case "object.delete": {
      const objectId = asString(p.objectId);
      if (objectId === null || p.permanent === true) return null; // permanent = data loss
      const snap = capture.nodeSnapshot(objectId);
      if (snap === null || !snap.active) return null; // already trashed — no-op
      return [{ opType: "object.restore", payload: { objectId }, affected: [objectId] }];
    }
    case "object.restore": {
      const objectId = asString(p.objectId);
      if (objectId === null) return null;
      const snap = capture.nodeSnapshot(objectId);
      if (snap === null || snap.active) return null; // nothing to restore — no-op
      return [
        {
          opType: "object.delete",
          payload: { objectId, permanent: false },
          affected: [objectId],
        },
      ];
    }
    case "object.move": {
      const objectId = asString(p.objectId);
      if (objectId === null) return null;
      const placement = capture.nodePlacement(objectId);
      if (placement === null) return null;
      const payload: Record<string, unknown> = { objectId, parentId: placement.parentId };
      if (placement.afterId !== null) payload.afterId = placement.afterId;
      else if (placement.beforeId !== null) payload.beforeId = placement.beforeId;
      return [{ opType: "object.move", payload, affected: [objectId] }];
    }
    case "class.create": {
      const classId = asString(p.classId);
      if (classId === null) return null;
      return [{ opType: "class.delete", payload: { classId }, affected: [classId] }];
    }
    case "class.update": {
      const classId = asString(p.classId);
      if (classId === null) return null;
      const snap = capture.nodeSnapshot(classId);
      if (snap === null) return null;
      const spec = restoreUpdateSpec(
        "class.update",
        classId,
        p,
        snap,
        capture.classDescription(classId),
      );
      return spec === null ? null : [spec];
    }
    case "class.delete":
      // The applier tombstones every member's class_membership — no honest
      // inverse composes from existing ops.
      return null;
    case "class.unassign": {
      const objectId = asString(p.objectId);
      const classId = asString(p.classId);
      if (objectId === null || classId === null) return null;
      const snap = capture.nodeSnapshot(objectId);
      if (snap === null || !snap.classIds.includes(classId)) return null;
      // The add carrier re-issue (the same OR-Set seed assignClass issues).
      return [
        {
          opType: "object.create",
          payload: { objectId, classIds: [classId] },
          affected: [objectId],
        },
      ];
    }
    case "tag.unassign": {
      const objectId = asString(p.objectId);
      const tagId = asString(p.tagId);
      if (objectId === null || tagId === null) return null;
      const snap = capture.nodeSnapshot(objectId);
      if (snap === null || !snap.tagIds.includes(tagId)) return null;
      return [
        {
          opType: "object.create",
          payload: { objectId, tagIds: [tagId] },
          affected: [objectId],
        },
      ];
    }
    case "class.reorder": {
      const objectId = asString(p.objectId);
      if (objectId === null) return null;
      const snap = capture.nodeSnapshot(objectId);
      if (snap === null) return null;
      // class_ids is the effective ordered list (user order first, then
      // unlisted by id — re-issuing it reproduces the same effective order).
      return [
        {
          opType: "class.reorder",
          payload: { objectId, classIds: snap.classIds },
          affected: [objectId],
        },
      ];
    }
    case "class.setExtends": {
      const classId = asString(p.classId);
      if (classId === null) return null;
      const prior = capture.classParents(classId);
      return [
        {
          opType: "class.setExtends",
          payload: { classId, parentClassIds: prior },
          affected: [classId, ...prior],
        },
      ];
    }
    case "class.property.set": {
      const classId = asString(p.classId);
      const propertySchemaId = asString(p.propertySchemaId);
      if (classId === null || propertySchemaId === null) return null;
      const BINDING_FIELDS = [
        "sequence",
        "required",
        "readonly",
        "hideWhenEmpty",
        "defaultValue",
        "active",
      ] as const;
      const touched = BINDING_FIELDS.filter((field) => hasOwn(p, field));
      if (touched.length === 0) return null;
      const prior = capture.classBinding(classId, propertySchemaId);
      if (prior === null) {
        // First bind — remove it again.
        return [
          {
            opType: "class.property.unset",
            payload: { classId, propertySchemaId },
            affected: [classId],
          },
        ];
      }
      const restore: Record<string, unknown> = { classId, propertySchemaId };
      for (const field of touched) {
        // Wire warts, both applier-sanctioned: default_value SQL NULL cannot
        // be re-expressed (restored as an explicit JSON null), and the
        // nullable flags coerce payload null → 0/false at apply time — so a
        // NULL prior flag restores as false (the "cleared" value the UI
        // itself can only ever write).
        const value = prior[field as keyof UndoBindingSnapshot];
        if (field === "defaultValue" && value === undefined) restore[field] = null;
        else if (
          (field === "required" || field === "readonly" || field === "hideWhenEmpty") &&
          value === null
        ) {
          restore[field] = false;
        } else {
          restore[field] = value;
        }
      }
      return [{ opType: "class.property.set", payload: restore, affected: [classId] }];
    }
    case "class.property.unset": {
      const classId = asString(p.classId);
      const propertySchemaId = asString(p.propertySchemaId);
      if (classId === null || propertySchemaId === null) return null;
      const prior = capture.classBinding(classId, propertySchemaId);
      if (prior === null) return null; // nothing bound — no-op
      const nullableFlag = (value: boolean | null): boolean | null => value ?? false;
      const payload: Record<string, unknown> = {
        classId,
        propertySchemaId,
        sequence: prior.sequence,
        required: nullableFlag(prior.required),
        readonly: nullableFlag(prior.readonly),
        hideWhenEmpty: nullableFlag(prior.hideWhenEmpty),
        defaultValue: prior.defaultValue === undefined ? null : prior.defaultValue,
        active: prior.active,
      };
      return [{ opType: "class.property.set", payload, affected: [classId] }];
    }
    case "propertySchema.create": {
      const propertySchemaId = asString(p.propertySchemaId);
      if (propertySchemaId === null) return null;
      return [
        {
          opType: "propertySchema.delete",
          payload: { propertySchemaId },
          affected: [],
        },
      ];
    }
    case "propertySchema.update": {
      const propertySchemaId = asString(p.propertySchemaId);
      if (propertySchemaId === null) return null;
      const prior = capture.schemaSnapshot(propertySchemaId);
      if (prior === null) return null;
      const restore: Record<string, unknown> = { propertySchemaId };
      if (hasOwn(p, "name")) restore.name = prior.name;
      if (hasOwn(p, "options")) restore.options = prior.options ?? [];
      if (hasOwn(p, "datePrecision")) {
        // SQL NULL = the day default — the enum has no null, so restore the
        // effective value explicitly.
        restore.datePrecision = prior.datePrecision ?? "day";
      }
      if (hasOwn(p, "dateQualified")) restore.dateQualified = prior.dateQualified ?? false;
      if (Object.keys(restore).length === 1) return null;
      return [{ opType: "propertySchema.update", payload: restore, affected: [] }];
    }
    case "propertySchema.delete": {
      const propertySchemaId = asString(p.propertySchemaId);
      if (propertySchemaId === null) return null;
      const prior = capture.schemaSnapshot(propertySchemaId);
      if (prior === null) return null;
      const payload: Record<string, unknown> = {
        propertySchemaId,
        name: prior.name,
        type: prior.type,
        multi: prior.multi,
        scope: prior.scope,
      };
      if (Array.isArray(prior.options)) payload.options = prior.options;
      if (prior.targetClassFilter !== null) payload.targetClassFilter = prior.targetClassFilter;
      if (prior.datePrecision !== null) payload.datePrecision = prior.datePrecision;
      if (prior.dateQualified !== null) payload.dateQualified = prior.dateQualified === true;
      return [{ opType: "propertySchema.create", payload, affected: [] }];
    }
    case "property.set": {
      const objectId = asString(p.objectId);
      const propertySchemaId = asString(p.propertySchemaId);
      if (objectId === null || propertySchemaId === null) return null;
      const idx = typeof p.idx === "number" ? p.idx : 0;
      const elementId = asString(p.elementId) ?? undefined;
      if (elementId !== undefined) {
        // PG5 element add — remove that element.
        return [
          {
            opType: "property.unset",
            payload: { objectId, propertySchemaId, elementId },
            affected: [objectId],
          },
        ];
      }
      const prior = capture.propertyValue(objectId, propertySchemaId, undefined, idx);
      if (prior === null) {
        return [
          {
            opType: "property.unset",
            payload: { objectId, propertySchemaId, idx },
            affected: [objectId],
          },
        ];
      }
      const payload: Record<string, unknown> = {
        objectId,
        propertySchemaId,
        value: prior.value,
        idx: prior.idx,
      };
      if (prior.elementId !== positionalElementId(objectId, propertySchemaId, prior.idx)) {
        payload.elementId = prior.elementId;
      }
      if (prior.metadata !== null) payload.metadata = prior.metadata;
      return [{ opType: "property.set", payload, affected: [objectId] }];
    }
    case "property.unset": {
      const objectId = asString(p.objectId);
      const propertySchemaId = asString(p.propertySchemaId);
      if (objectId === null || propertySchemaId === null) return null;
      const idx = typeof p.idx === "number" ? p.idx : 0;
      const elementId = asString(p.elementId) ?? undefined;
      const prior = capture.propertyValue(objectId, propertySchemaId, elementId, idx);
      if (prior === null) return null; // nothing there — no-op
      const payload: Record<string, unknown> = {
        objectId,
        propertySchemaId,
        value: prior.value,
        idx: prior.idx,
      };
      if (prior.elementId !== positionalElementId(objectId, propertySchemaId, prior.idx)) {
        payload.elementId = prior.elementId;
      }
      if (prior.metadata !== null) payload.metadata = prior.metadata;
      return [{ opType: "property.set", payload, affected: [objectId] }];
    }
    case "asset.attach": {
      const objectId = asString(p.objectId);
      const assetId = asString(p.assetId);
      if (objectId === null || assetId === null) return null;
      const prior = capture.assetSnapshot(objectId, assetId);
      if (prior !== null) {
        // The attach upserted an existing row — restore the captured fields.
        return [
          {
            opType: "asset.attach",
            payload: {
              objectId,
              assetId,
              hash: prior.hash,
              mimeType: prior.mimeType,
              size: prior.size,
              originalName: prior.originalName,
            },
            affected: [objectId, assetId],
          },
        ];
      }
      return [
        {
          opType: "asset.detach",
          payload: { objectId, assetId },
          affected: [objectId, assetId],
        },
      ];
    }
    case "asset.detach": {
      const objectId = asString(p.objectId);
      const assetId = asString(p.assetId);
      if (objectId === null || assetId === null) return null;
      const prior = capture.assetSnapshot(objectId, assetId);
      if (prior === null) return null;
      return [
        {
          opType: "asset.attach",
          payload: {
            objectId,
            assetId,
            hash: prior.hash,
            mimeType: prior.mimeType,
            size: prior.size,
            originalName: prior.originalName,
          },
          affected: [objectId, assetId],
        },
      ];
    }
    case "collection.member.add": {
      const collectionId = asString(p.collectionId);
      const objectId = asString(p.objectId);
      if (collectionId === null || objectId === null) return null;
      if (capture.collectionMembership(collectionId, objectId)) return null; // already a member — no-op
      return [
        {
          opType: "collection.member.remove",
          payload: { collectionId, objectId },
          affected: [collectionId, objectId],
        },
      ];
    }
    case "collection.member.remove": {
      const collectionId = asString(p.collectionId);
      const objectId = asString(p.objectId);
      if (collectionId === null || objectId === null) return null;
      if (!capture.collectionMembership(collectionId, objectId)) return null; // not a member — no-op
      return [
        {
          opType: "collection.member.add",
          payload: { collectionId, objectId },
          affected: [collectionId, objectId],
        },
      ];
    }
    case "workspace.feature.set": {
      const feature = asString(p.feature);
      if (feature === null || typeof p.enabled !== "boolean") return null;
      const prior = capture.featureEnabled(feature);
      if (prior === p.enabled) return null; // redundant toggle — no-op
      return [
        {
          opType: "workspace.feature.set",
          payload: { feature, enabled: prior },
          affected: [],
        },
      ];
    }
    default:
      return null;
  }
}

// --- labels --------------------------------------------------------------------

const OP_VERBS: Record<string, string> = {
  "object.create": "create",
  "object.update": "update",
  "object.delete": "delete",
  "object.restore": "restore",
  "object.move": "move",
  "class.create": "create class",
  "class.update": "update class",
  "class.unassign": "remove class",
  "class.reorder": "reorder classes",
  "tag.unassign": "remove tag",
  "class.setExtends": "set class extends",
  "class.property.set": "set class property",
  "class.property.unset": "remove class property",
  "propertySchema.create": "create property schema",
  "propertySchema.update": "update property schema",
  "propertySchema.delete": "delete property schema",
  "property.set": "set property",
  "property.unset": "clear property",
  "asset.attach": "attach asset",
  "asset.detach": "detach asset",
  "collection.member.add": "add to collection",
  "collection.member.remove": "remove from collection",
  "workspace.feature.set": "toggle feature",
};

/**
 * The label verb for a journaled envelope ("edit text", "delete", …) — from
 * the op type, refined for the common cases. The create add-carrier reads as
 * "assign class"/"assign tag" (what the gesture did), not "create".
 */
export function undoVerbFor(envelope: Envelope, capture: UndoCaptureSource): string {
  const p = envelope.payload as Record<string, unknown>;
  if (envelope.opType === "object.update") {
    const touched = Object.keys(p).filter((key) => key !== "objectId");
    if (touched.includes("contentAst") && touched.length === 1) return "edit text";
    if (touched.length === 1 && touched[0] === "icon") return "change icon";
    if (touched.length === 1 && touched[0] === "color") return "change color";
    if (touched.includes("presentAsMain")) return p.presentAsMain === true ? "promote" : "demote";
    return "update";
  }
  if (envelope.opType === "object.create") {
    const objectId = asString(p.objectId);
    const isCarrier =
      objectId !== null &&
      capture.nodeSnapshot(objectId) !== null &&
      (asStringArray(p.classIds).length > 0 || asStringArray(p.tagIds).length > 0);
    if (isCarrier) {
      if (asStringArray(p.classIds).length > 0) return "assign class";
      return "assign tag";
    }
  }
  if (envelope.opType === "class.update") {
    const touched = Object.keys(p).filter((key) => key !== "classId");
    if (touched.length === 1 && touched[0] === "icon") return "change class icon";
    if (touched.length === 1 && touched[0] === "color") return "change class color";
  }
  return OP_VERBS[envelope.opType] ?? envelope.opType;
}

// --- journal ---------------------------------------------------------------------

/** One journal entry: what applying it does, and what undoing it does. */
export interface UndoEntry {
  /** The original op(s) — (re)applied on redo. */
  applySpecs: UndoOpSpec[];
  /** The captured inverses — applied on undo, in order. */
  inverseSpecs: UndoOpSpec[];
  /** The label verb ("edit text") — chrome renders "Undo <verb>". */
  verb: string;
  /** Last-edit time (the coalescing freshness anchor). */
  at: number;
  /** `text:<nodeId>` for coalescable text edits, else null. */
  coalesceKey: string | null;
}

/** The journal-mode of one recorded application (which stack it lands on). */
export type UndoRecordMode = "normal" | "undo" | "redo";

/** What prepare() hands back: the capture result, committed after the apply. */
export interface PreparedUndoEntry {
  envelope: Envelope;
  inverseSpecs: UndoOpSpec[] | null;
  verb: string;
  coalesceKey: string | null;
}

export interface UndoJournalOptions {
  capture: UndoCaptureSource;
  /** Wall clock for coalescing/bounds; injectable in tests. */
  now?: () => number;
  /** Undo-stack bound; the redo stack is bounded the same way. */
  limit?: number;
  /** Same-node text edits inside this window coalesce into one entry. */
  coalesceWindowMs?: number;
}

/** Contiguous same-node text edits inside this window merge (paragraph-grained
 *  typing-undo). Two editor flushes land ~400 ms apart; 1500 ms keeps one
 *  continuous run one entry while a real pause starts the next. */
export const UNDO_COALESCE_WINDOW_MS = 1500;

export class UndoJournal {
  private readonly capture: UndoCaptureSource;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly coalesceWindowMs: number;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private batchDepth = 0;
  private batchBuffer: Array<{ entry: UndoEntry; mode: UndoRecordMode }> = [];

  constructor(options: UndoJournalOptions) {
    this.capture = options.capture;
    this.now = options.now ?? (() => Date.now());
    this.limit = options.limit ?? 200;
    this.coalesceWindowMs = options.coalesceWindowMs ?? UNDO_COALESCE_WINDOW_MS;
  }

  /**
   * Capture the inverse intent of an envelope BEFORE it is applied — call
   * exactly once per envelope, then commit() after the apply succeeded (a
   * throwing apply never commits: the op never entered the outbox, so it
   * must not enter the journal either).
   */
  prepare(envelope: Envelope): PreparedUndoEntry {
    const inverseSpecs = invertEnvelope(envelope, this.capture);
    const coalesceKey =
      envelope.opType === "object.update" &&
      inverseSpecs !== null &&
      Object.keys(envelope.payload as Record<string, unknown>).sort().join(",") ===
        "contentAst,objectId"
        ? `text:${(envelope.payload as { objectId?: unknown }).objectId}`
        : null;
    return {
      envelope,
      inverseSpecs,
      verb: undoVerbFor(envelope, this.capture),
      coalesceKey,
    };
  }

  /**
   * Record a successfully applied envelope. `mode` selects the stack:
   * "normal" (a user write) pushes the undo stack and clears the redo stack;
   * "undo"/"redo" journal the application to the OPPOSITE stack (the standard
   * model — undoing does not re-journal onto the undo stack, it journals
   * onto redo so redo can re-run it). `verbOverride` relabels the entry: the
   * undo/redo loops pass the ORIGINAL entry's verb so the opposite stack
   * reads "Redo delete" (the action being redone), not "Redo restore" (the
   * op that implemented the undo). Inside batch(), records are grouped.
   */
  commit(prepared: PreparedUndoEntry, mode: UndoRecordMode, verbOverride?: string): void {
    if (prepared.inverseSpecs === null) return;
    const entry: UndoEntry = {
      applySpecs: [
        {
          opType: prepared.envelope.opType,
          payload: prepared.envelope.payload as Record<string, unknown>,
          affected: prepared.envelope.affectedNodeIds,
        },
      ],
      inverseSpecs: prepared.inverseSpecs,
      verb: verbOverride ?? prepared.verb,
      at: this.now(),
      coalesceKey: prepared.coalesceKey,
    };
    if (this.batchDepth > 0) {
      this.batchBuffer.push({ entry, mode });
      return;
    }
    this.commitEntry(entry, mode);
  }

  private commitEntry(entry: UndoEntry, mode: UndoRecordMode): void {
    if (mode === "undo") {
      this.pushBounded(this.redoStack, entry);
      return;
    }
    if (mode === "redo") {
      this.pushBounded(this.undoStack, entry);
      return;
    }
    this.recordNormal(entry);
  }

  /**
   * Group the writes of one gesture into a SINGLE journal entry (inverses
   * reversed, so the composite undoes in the opposite order of the original
   * application). The undo/redo loops batch the inverse specs of one entry
   * so a multi-op gesture redos as one gesture, not N steps. Contiguous
   * same-mode records merge; records committed with a verb override keep
   * the FIRST record's verb (they all share it in the loops).
   */
  batch(fn: () => void): void {
    this.batchDepth += 1;
    try {
      fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth !== 0 || this.batchBuffer.length === 0) return;
      const buffered = this.batchBuffer;
      this.batchBuffer = [];
      let run: Array<{ entry: UndoEntry; mode: UndoRecordMode }> = [];
      const flush = (): void => {
        if (run.length === 0) return;
        const merged: UndoEntry =
          run.length === 1
            ? run[0]!.entry
            : {
                applySpecs: run.flatMap(({ entry }) => entry.applySpecs),
                inverseSpecs: run
                  .slice()
                  .reverse()
                  .flatMap(({ entry }) => entry.inverseSpecs),
                verb: run[0]!.entry.verb,
                at: run[run.length - 1]!.entry.at,
                coalesceKey: null,
              };
        this.commitEntry(merged, run[0]!.mode);
        run = [];
      };
      for (const record of buffered) {
        if (run.length > 0 && run[0]!.mode !== record.mode) flush();
        run.push(record);
      }
      flush();
    }
  }

  private recordNormal(entry: UndoEntry): void {
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      entry.coalesceKey !== null &&
      top !== undefined &&
      top.coalesceKey === entry.coalesceKey &&
      entry.at - top.at <= this.coalesceWindowMs
    ) {
      // Same node, still typing: keep the ORIGINAL inverse (restore the
      // pre-typing state) but re-point the apply side at the latest op, so
      // redo lands the final text.
      top.at = entry.at;
      top.applySpecs = entry.applySpecs;
      return;
    }
    this.pushBounded(this.undoStack, entry);
  }

  private pushBounded(stack: UndoEntry[], entry: UndoEntry): void {
    stack.push(entry);
    while (stack.length > this.limit) stack.shift();
  }

  /** Pop the next entry to undo (WorkspaceClient applies its inverseSpecs). */
  takeUndo(): UndoEntry | null {
    return this.undoStack.pop() ?? null;
  }

  /**
   * Pop the next entry to redo. Both stacks store entries in the same shape
   * — {applySpecs, inverseSpecs} — and BOTH pop directions apply the popped
   * entry's inverseSpecs: undo reverses the last transition, redo reverses
   * the reversal (the redo entry's inverseSpecs ARE the original gesture's
   * ops, freshly captured when the undo applied).
   */
  takeRedo(): UndoEntry | null {
    return this.redoStack.pop() ?? null;
  }

  /** Put a taken entry back after a failed apply (the entry is unspent). */
  restoreUndo(entry: UndoEntry): void {
    this.undoStack.push(entry);
  }

  restoreRedo(entry: UndoEntry): void {
    this.redoStack.push(entry);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undoLabel(): string | null {
    const top = this.undoStack[this.undoStack.length - 1];
    return top === undefined ? null : `Undo ${top.verb}`;
  }

  redoLabel(): string | null {
    const top = this.redoStack[this.redoStack.length - 1];
    return top === undefined ? null : `Redo ${top.verb}`;
  }

  undoDepth(): number {
    return this.undoStack.length;
  }

  redoDepth(): number {
    return this.redoStack.length;
  }

  /** New session / new workspace: drop everything (never survives a reload). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.batchBuffer = [];
    this.batchDepth = 0;
  }

  /**
   * The browsable undo stack, OLDEST first (the menu lists history forward;
   * the last row is the next undo). Bounded like the stack itself.
   */
  history(): UndoHistoryEntry[] {
    return this.undoStack.map((entry) => {
      const affected: string[] = [];
      for (const spec of entry.applySpecs) {
        for (const id of spec.affected) {
          if (!affected.includes(id)) affected.push(id);
        }
      }
      return { verb: entry.verb, at: entry.at, affected, coalesceKey: entry.coalesceKey };
    });
  }

  state(): UndoUiState {
    return {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoLabel: this.undoLabel(),
      redoLabel: this.redoLabel(),
    };
  }
}
