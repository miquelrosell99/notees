/**
 * Sync layer public API.
 *
 * The legacy v1 per-operation REST sync manager and the v2 batch sync adapter
 * have been removed. The SQLite core sync engine now persists operations.
 * This module keeps the small utilities that direct mutation hooks still
 * depend on.
 */

export { waitForOperationAck } from './waitForOperation';
