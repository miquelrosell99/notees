/**
 * Runtime public API.
 *
 * The runtime is a pure derived-state engine. It owns operations and
 * projection but makes no API calls. Persistence is handled by SyncManager.
 */

export { OperationRuntime } from './OperationRuntime';
export type { OperationRuntimeSnapshot } from './OperationRuntime';
export { getOperationRuntime, setOperationRuntime } from './runtimeInstance';
export { applyOperation, applyOperations } from './operationReducer';
export {
  isPending,
  isInFlight,
  isAcknowledged,
  isFailed,
  canRetry,
  withState,
  withInFlight,
  withAcknowledged,
  withFailed,
  withRetry,
} from './operation';
export type {
  Operation,
  OperationState,
  OperationType,
  CoreNode,
  UpdateContentPayload,
  MovePayload,
  CreatePayload,
  DeletePayload,
  SetCollapsedPayload,
  SetClassesPayload,
  SetTagsPayload,
} from './operation';
export {
  getNode,
  getChildren,
  getSiblings,
  getDescendants,
  getAllNodes,
  getAllPages,
  getUnpersistedNodes,
  getNodeByServerId,
} from './graphHelpers';
export {
  getRuntimeEventBus,
  loadNodes,
  upsertNodes,
  removeNodes,
  applyRuntimeIntent,
} from './eventBus';
export type { RuntimeEventBus } from './eventBus';


