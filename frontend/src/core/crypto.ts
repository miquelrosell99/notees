import type { Hlc } from './clock';

export interface OperationEnvelope {
  id: string;
  workspaceId: string;
  actorId: string;
  affectedNodeIds: string[];
  opType: string;
  hlc: Hlc;
  payload: unknown;
}

export async function encryptEnvelope(
  payload: unknown,
  _key: unknown,
  metadata: {
    id: string;
    workspaceId: string;
    actorId: string;
    affectedNodeIds: string[];
    opType: string;
    hlc: Hlc;
  }
): Promise<OperationEnvelope> {
  return {
    id: metadata.id,
    workspaceId: metadata.workspaceId,
    actorId: metadata.actorId,
    affectedNodeIds: metadata.affectedNodeIds,
    opType: metadata.opType,
    hlc: metadata.hlc,
    payload,
  };
}

export async function decryptEnvelope(envelope: OperationEnvelope, _key?: unknown): Promise<unknown> {
  return envelope.payload;
}
