/**
 * serverIdMap — lightweight UUID → server UUID mapping.
 *
 * The API is UUID-native, so the client-generated block UUID is the canonical
 * server UUID in almost all flows. This module is retained only for legacy
 * importer paths that may initially assign a temporary block UUID and later
 * need to remap it to the server's canonical UUID. Numeric server IDs are no
 * longer stored.
 */

const blockToServer = new Map<string, string>();

export function registerServerId(blockId: string, serverUuid: string): void {
  blockToServer.set(blockId, serverUuid);
}

export function getServerId(blockId: string): string | null {
  return blockToServer.get(blockId) ?? null;
}

export function clearServerId(blockId: string): void {
  blockToServer.delete(blockId);
}

/**
 * Remap a temporary blockId to the server's canonical block UUID.
 */
export function remapBlockId(oldBlockId: string, newBlockId: string): void {
  const serverUuid = blockToServer.get(oldBlockId);
  if (serverUuid !== undefined) {
    blockToServer.delete(oldBlockId);
    blockToServer.set(newBlockId, serverUuid);
  }
}
