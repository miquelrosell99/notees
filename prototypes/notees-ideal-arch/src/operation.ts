import type { Hlc } from "./clock";
import { uuidv7 } from "./uuid";

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
  "node.create",
  "node.delete",
  "node.move",
  "node.updateContent",
  "class.assign",
  "class.unassign",
  "property.set",
  "property.unset",
  "propertySchema.create",
  "propertySchema.update",
  "class.create",
  "class.update",
]);

export function createOperation(
  partial: Omit<OperationEnvelope, "id">,
  payload: unknown
): Operation {
  return {
    envelope: {
      id: uuidv7(),
      ...partial,
    },
    payload,
  };
}

export function validateOperation(op: Operation): boolean {
  if (!op?.envelope || !op?.payload) return false;
  const env = op.envelope;
  if (!env.id || !env.workspaceId || !env.actorId) return false;
  if (typeof env.hlc?.physical !== "number" || typeof env.hlc?.logical !== "number") return false;
  if (!Array.isArray(env.affectedNodeIds)) return false;
  if (!OP_TYPES.has(env.opType)) return false;
  return true;
}
