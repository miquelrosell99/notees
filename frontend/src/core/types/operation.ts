import type { Hlc } from '../clock';
import { uuidv7 } from '../uuid';

export interface OperationEnvelope {
  id: string;
  workspaceId: string;
  actorId: string;
  hlc: Hlc;
  affectedNodeIds: string[];
  opType: string;
}

export interface Operation {
  envelope: OperationEnvelope;
  payload: unknown;
}

const OP_TYPES = new Set([
  'node.create',
  'node.delete',
  'node.move',
  'node.updateContent',
  'node.addAlias',
  'node.removeAlias',
  'class.assign',
  'class.unassign',
  'property.set',
  'property.unset',
  'propertySchema.create',
  'propertySchema.update',
  'propertySchema.delete',
  'classPropertyEdge.create',
  'classPropertyEdge.update',
  'classPropertyEdge.delete',
  'classPropertyEdge.reorder',
  'class.create',
  'class.update',
  'class.delete',
  'class.setExtends',
  'nodeView.create',
  'nodeView.update',
  'nodeView.delete',
  'nodeView.reorder',
  'task.recordCompletion',
  'task.deleteCompletion',
  'task.setRecurrence',
  'task.deleteRecurrence',
  'asset.upload',
  'asset.delete',
  'activity.record',
  'link.click',
  'share.public.create',
  'share.public.revoke',
  'share.user.grant',
  'share.user.revoke',
  'user.favorite.add',
  'user.favorite.remove',
  'user.favorite.reorder',
  'plugin.op',
]);

export interface UserFavoriteAddPayload {
  nodeId: string;
}

export interface UserFavoriteRemovePayload {
  nodeId: string;
}

export interface UserFavoriteReorderPayload {
  nodeIds: string[];
}

export interface TaskRecordCompletionPayload {
  nodeId: string;
  completionId?: string;
  completedAt?: string;
}

export interface TaskDeleteCompletionPayload {
  nodeId: string;
  completionId: string;
}

export interface TaskSetRecurrencePayload {
  nodeId: string;
  recurrenceId?: string;
  rule: string;
}

export interface TaskDeleteRecurrencePayload {
  nodeId: string;
  recurrenceId: string;
}

export interface AssetUploadPayload {
  nodeId: string;
  assetHash: string;
  mimeType: string;
  size: number;
  originalName: string;
}

export interface AssetDeletePayload {
  nodeId: string;
  assetHash?: string;
}

export interface ActivityRecordPayload {
  activityType: string;
  nodeId?: string;
  metadata?: Record<string, unknown>;
}

export interface LinkClickPayload {
  nodeId: string;
  targetId?: string;
}

export interface SharePublicCreatePayload {
  nodeId: string;
  slug?: string;
  passwordHash?: string;
}

export interface SharePublicRevokePayload {
  nodeId: string;
}

export interface ShareUserGrantPayload {
  nodeId: string;
  userId: string;
  role: string;
}

export interface ShareUserRevokePayload {
  nodeId: string;
  userId: string;
}

export interface PluginOpPayload {
  pluginId: string;
  opType: string;
  data: Record<string, unknown>;
}

export interface PropertySchemaCreatePayload {
  schemaId: string;
  name: string;
  icon?: string | null;
  type?: string;
  multi?: boolean;
  scope?: 'global' | 'class' | 'node';
  nodeId?: string | null;
  iconVisibility?: string;
  validationRules?: Record<string, unknown> | null;
  required?: boolean;
  readonly?: boolean;
  hideWhenEmpty?: boolean;
  defaultValue?: unknown | null;
  classFilterUuids?: string[];
  options?: Array<{ uuid: string; name: string; icon?: string | null; color?: string | null; sequence?: number }>;
  computed?: { kind: string; expression: string } | null;
}

export interface PropertySchemaUpdatePayload {
  schemaId: string;
  name?: string | null;
  icon?: string | null;
  type?: string | null;
  multi?: boolean | null;
  scope?: 'global' | 'class' | 'node' | null;
  nodeId?: string | null;
  iconVisibility?: string | null;
  validationRules?: Record<string, unknown> | null;
  required?: boolean | null;
  readonly?: boolean | null;
  hideWhenEmpty?: boolean | null;
  defaultValue?: unknown | null;
  classFilterUuids?: string[] | null;
  options?: Array<{ uuid: string; name: string; icon?: string | null; color?: string | null; sequence?: number }> | null;
  computed?: { kind: string; expression: string } | null | null;
}

export interface PropertySchemaDeletePayload {
  schemaId: string;
}

export interface ClassPropertyEdgeCreatePayload {
  classId: string;
  propertySchemaId: string;
  sequence?: number;
  defaultValue?: unknown | null;
  hidden?: boolean;
  required?: boolean | null;
  readonly?: boolean | null;
  hideWhenEmpty?: boolean | null;
}

export interface ClassPropertyEdgeUpdatePayload {
  classId: string;
  propertySchemaId: string;
  sequence?: number;
  defaultValue?: unknown | null;
  hidden?: boolean;
  required?: boolean | null;
  readonly?: boolean | null;
  hideWhenEmpty?: boolean | null;
}

export interface ClassPropertyEdgeDeletePayload {
  classId: string;
  propertySchemaId: string;
}

export interface ClassPropertyEdgeReorderPayload {
  classId: string;
  orderedPropertySchemaIds: string[];
}

export interface ClassCreatePayload {
  classId: string;
  name: string;
  icon?: string | null;
  color?: string | null;
}

export interface ClassUpdatePayload {
  classId: string;
  name?: string;
  icon?: string | null;
  color?: string | null;
  description?: string | null;
}

export interface ClassDeletePayload {
  classId: string;
}

export interface ClassSetExtendsPayload {
  classId: string;
  extendsClassIds: string[];
}

export interface NodeViewCreatePayload {
  viewId: string;
  nodeId: string;
  name: string;
  viewType: string;
  orderIndex?: number;
  isDefault?: boolean;
  shownProperties?: Array<{ uuid: string; sequence: number }>;
  groupBy?: unknown | null;
  viewMode?: string | null;
  sortEntries?: unknown[];
  settings?: Record<string, unknown>;
  queryAst?: unknown;
}

export interface NodeViewUpdatePayload {
  viewId: string;
  name?: string | null;
  orderIndex?: number | null;
  isDefault?: boolean | null;
  shownProperties?: Array<{ uuid: string; sequence: number }> | null;
  groupBy?: unknown | null;
  viewMode?: string | null;
  sortEntries?: unknown[] | null;
  settings?: Record<string, unknown> | null;
  queryAst?: unknown | null;
}

export interface NodeViewDeletePayload {
  viewId: string;
}

export interface NodeViewReorderPayload {
  nodeId: string;
  viewType: string;
  orderedViewIds: string[];
}

export function createOperation(
  partial: Omit<OperationEnvelope, 'id'> & { id?: string },
  payload: unknown
): Operation {
  return {
    envelope: {
      id: partial.id ?? uuidv7(),
      ...partial,
    },
    payload,
  };
}

export function validateOperation(op: Operation): boolean {
  if (!op?.envelope || !op?.payload) return false;
  const env = op.envelope;
  if (!env.id || !env.workspaceId || !env.actorId) return false;
  if (typeof env.hlc?.physical !== 'number' || typeof env.hlc?.logical !== 'number') return false;
  if (!Array.isArray(env.affectedNodeIds)) return false;
  if (!OP_TYPES.has(env.opType)) return false;
  return true;
}
