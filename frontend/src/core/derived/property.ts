import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { compareHlc, type Hlc } from '../clock';
import { queryOne } from '../db/sqlite';

interface LwwRecord {
  hlc: Hlc;
  actorId: string;
}

function compareLww(incoming: LwwRecord, existing: LwwRecord): number {
  const hlcCmp = compareHlc(incoming.hlc, existing.hlc);
  if (hlcCmp !== 0) return hlcCmp;
  return incoming.actorId.localeCompare(existing.actorId);
}

function recordFromRow(
  row: { hlc_physical: number; hlc_logical: number; actor_id: string | null } | undefined,
  fallbackActorId: string
): LwwRecord | undefined {
  if (!row) return undefined;
  return {
    hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
    actorId: row.actor_id ?? fallbackActorId,
  };
}

interface PropertyKey {
  nodeId: string;
  schemaId: string;
  index: number;
}

function upsertTombstone(db: Database, key: PropertyKey, record: LwwRecord): void {
  db.run(
    `INSERT INTO property_value_tombstone (node_id, property_schema_id, idx, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id, property_schema_id, idx) DO UPDATE SET
       hlc_physical = excluded.hlc_physical,
       hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical AND excluded.actor_id > actor_id)`,
    [key.nodeId, key.schemaId, key.index, record.hlc.physical, record.hlc.logical, record.actorId]
  );
}

function getTombstone(db: Database, key: PropertyKey, fallbackActorId: string): LwwRecord | undefined {
  const row = queryOne<{ hlc_physical: number; hlc_logical: number; actor_id: string | null }>(
    db,
    'SELECT hlc_physical, hlc_logical, actor_id FROM property_value_tombstone WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
    [key.nodeId, key.schemaId, key.index]
  );
  return recordFromRow(row, fallbackActorId);
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function boolToTriState(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function applyPropertySchemaCreate(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO property_schema (
       id, workspace_id, name, icon, type, multi, is_system, scope, node_id,
       icon_visibility, validation_rules, required, readonly, hide_when_empty,
       default_value, class_filter_uuids, options, computed, active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.schemaId as string,
      op.envelope.workspaceId,
      payload.name as string,
      (payload.icon as string | null | undefined) ?? null,
      (payload.type as string) ?? 'text',
      payload.multi ? 1 : 0,
      payload.isSystem ? 1 : 0,
      (payload.scope as string) ?? 'global',
      (payload.nodeId as string | null | undefined) ?? null,
      (payload.iconVisibility as string | undefined) ?? null,
      jsonOrNull(payload.validationRules),
      payload.required ? 1 : 0,
      payload.readonly ? 1 : 0,
      payload.hideWhenEmpty ? 1 : 0,
      jsonOrNull(payload.defaultValue),
      jsonOrNull((payload.classFilterUuids as string[] | undefined) ?? []),
      jsonOrNull((payload.options as unknown[] | undefined) ?? []),
      jsonOrNull(payload.computed),
      1,
      now,
      now,
    ]
  );
}

function applyPropertySchemaUpdate(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  const schemaId = payload.schemaId as string;
  const now = new Date().toISOString();

  const columns: string[] = [];
  const values: (string | number | null)[] = [];

  const addColumn = (name: string, value: string | number | null): void => {
    columns.push(`${name} = ?`);
    values.push(value);
  };

  if ('name' in payload) addColumn('name', payload.name as string);
  if ('icon' in payload) addColumn('icon', (payload.icon as string | null | undefined) ?? null);
  if ('type' in payload) addColumn('type', (payload.type as string) ?? 'text');
  if ('multi' in payload) addColumn('multi', payload.multi ? 1 : 0);
  if ('scope' in payload) addColumn('scope', (payload.scope as string) ?? 'global');
  if ('nodeId' in payload) addColumn('node_id', (payload.nodeId as string | null | undefined) ?? null);
  if ('iconVisibility' in payload) addColumn('icon_visibility', (payload.iconVisibility as string | undefined) ?? null);
  if ('validationRules' in payload) addColumn('validation_rules', jsonOrNull(payload.validationRules));
  if ('required' in payload) addColumn('required', payload.required ? 1 : 0);
  if ('readonly' in payload) addColumn('readonly', payload.readonly ? 1 : 0);
  if ('hideWhenEmpty' in payload) addColumn('hide_when_empty', payload.hideWhenEmpty ? 1 : 0);
  if ('defaultValue' in payload) addColumn('default_value', jsonOrNull(payload.defaultValue));
  if ('classFilterUuids' in payload) addColumn('class_filter_uuids', jsonOrNull((payload.classFilterUuids as string[] | null | undefined) ?? []));
  if ('options' in payload) addColumn('options', jsonOrNull((payload.options as unknown[] | null | undefined) ?? []));
  if ('computed' in payload) addColumn('computed', jsonOrNull(payload.computed));

  if (columns.length === 0) return;

  addColumn('updated_at', now);
  values.push(schemaId);

  db.run(`UPDATE property_schema SET ${columns.join(', ')} WHERE id = ?`, values);
}

function applyPropertySchemaDelete(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  db.run('UPDATE property_schema SET active = 0, updated_at = ? WHERE id = ?', [now, payload.schemaId as string]);
}

function applyClassPropertyEdgeCreate(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  db.run(
    `INSERT OR REPLACE INTO class_property_edge (
       class_id, property_schema_id, sequence, default_value, hidden,
       required, readonly, hide_when_empty
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.classId as string,
      payload.propertySchemaId as string,
      (payload.sequence as number | undefined) ?? 0,
      jsonOrNull(payload.defaultValue),
      payload.hidden ? 1 : 0,
      boolToTriState(payload.required as boolean | null | undefined),
      boolToTriState(payload.readonly as boolean | null | undefined),
      boolToTriState(payload.hideWhenEmpty as boolean | null | undefined),
    ]
  );
}

function applyClassPropertyEdgeUpdate(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  const classId = payload.classId as string;
  const propertySchemaId = payload.propertySchemaId as string;

  const columns: string[] = [];
  const values: (string | number | null)[] = [];

  const addColumn = (name: string, value: string | number | null): void => {
    columns.push(`${name} = ?`);
    values.push(value);
  };

  if ('sequence' in payload) addColumn('sequence', payload.sequence as number);
  if ('defaultValue' in payload) addColumn('default_value', jsonOrNull(payload.defaultValue));
  if ('hidden' in payload) addColumn('hidden', payload.hidden ? 1 : 0);
  if ('required' in payload) addColumn('required', boolToTriState(payload.required as boolean | null | undefined));
  if ('readonly' in payload) addColumn('readonly', boolToTriState(payload.readonly as boolean | null | undefined));
  if ('hideWhenEmpty' in payload) addColumn('hide_when_empty', boolToTriState(payload.hideWhenEmpty as boolean | null | undefined));

  if (columns.length === 0) return;

  values.push(classId, propertySchemaId);
  db.run(`UPDATE class_property_edge SET ${columns.join(', ')} WHERE class_id = ? AND property_schema_id = ?`, values);
}

function applyClassPropertyEdgeDelete(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  db.run(
    'DELETE FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?',
    [payload.classId as string, payload.propertySchemaId as string]
  );
}

function applyClassPropertyEdgeReorder(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  const classId = payload.classId as string;
  const orderedIds = (payload.orderedPropertySchemaIds as string[] | undefined) ?? [];
  for (let i = 0; i < orderedIds.length; i++) {
    db.run(
      'UPDATE class_property_edge SET sequence = ? WHERE class_id = ? AND property_schema_id = ?',
      [i, classId, orderedIds[i]]
    );
  }
}

export function applyPropertyOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;

  if (opType === 'propertySchema.create') {
    applyPropertySchemaCreate(db, op);
    return;
  }
  if (opType === 'propertySchema.update') {
    applyPropertySchemaUpdate(db, op);
    return;
  }
  if (opType === 'propertySchema.delete') {
    applyPropertySchemaDelete(db, op);
    return;
  }
  if (opType === 'classPropertyEdge.create') {
    applyClassPropertyEdgeCreate(db, op);
    return;
  }
  if (opType === 'classPropertyEdge.update') {
    applyClassPropertyEdgeUpdate(db, op);
    return;
  }
  if (opType === 'classPropertyEdge.delete') {
    applyClassPropertyEdgeDelete(db, op);
    return;
  }
  if (opType === 'classPropertyEdge.reorder') {
    applyClassPropertyEdgeReorder(db, op);
    return;
  }

  const payload = op.payload as Record<string, unknown>;
  const incoming: LwwRecord = { hlc: op.envelope.hlc, actorId: op.envelope.actorId };
  const key: PropertyKey = {
    nodeId: payload.nodeId as string,
    schemaId: payload.schemaId as string,
    index: (payload.index as number) ?? 0,
  };

  if (opType === 'property.set') {
    const existingRow = queryOne<{
      id: string;
      hlc_physical: number;
      hlc_logical: number;
      actor_id: string | null;
    }>(
      db,
      'SELECT id, hlc_physical, hlc_logical, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
      [key.nodeId, key.schemaId, key.index]
    );

    const existing = recordFromRow(existingRow, incoming.actorId);
    const tombstone = getTombstone(db, key, incoming.actorId);

    if (tombstone && compareLww(incoming, tombstone) <= 0) {
      return;
    }

    if (existing) {
      if (compareLww(incoming, existing) > 0) {
        db.run(
          'UPDATE property_value SET value = ?, hlc_physical = ?, hlc_logical = ?, actor_id = ? WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
          [JSON.stringify(payload.value), incoming.hlc.physical, incoming.hlc.logical, incoming.actorId, key.nodeId, key.schemaId, key.index]
        );
      }
    } else {
      db.run(
        'INSERT INTO property_value (id, node_id, property_schema_id, value, idx, hlc_physical, hlc_logical, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          payload.propertyValueId as string,
          key.nodeId,
          key.schemaId,
          JSON.stringify(payload.value),
          key.index,
          incoming.hlc.physical,
          incoming.hlc.logical,
          incoming.actorId,
        ]
      );
    }
  } else if (opType === 'property.unset') {
    const existingRow = queryOne<{ hlc_physical: number; hlc_logical: number; actor_id: string | null }>(
      db,
      'SELECT hlc_physical, hlc_logical, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?',
      [key.nodeId, key.schemaId, key.index]
    );

    const existing = recordFromRow(existingRow, incoming.actorId);

    upsertTombstone(db, key, incoming);

    if (existing) {
      if (compareLww(incoming, existing) > 0) {
        db.run('DELETE FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?', [
          key.nodeId,
          key.schemaId,
          key.index,
        ]);
      }
    }
  }
}
