/**
 * Sync layer public API.
 *
 * The v1 per-operation REST sync manager has been removed. Only the v2
 * batch sync adapter remains in features/sync/SyncManagerV2. This module
 * keeps the small utilities that direct mutation hooks still depend on.
 */

export { waitForOperationAck } from './waitForOperation';
