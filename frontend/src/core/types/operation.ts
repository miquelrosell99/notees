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
  'class.assign',
  'class.unassign',
  'property.set',
  'property.unset',
  'propertySchema.create',
  'propertySchema.update',
  'class.create',
  'class.update',
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
  'plugin.op',
]);

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
