/**
 * OPFS persistence for the store worker: one SQLite image per workspace at
 * `navigator.storage.getDirectory()` → `notees/<workspaceId>.db`.
 *
 * Everything goes through the OpfsStore interface so worker-core stays
 * framework- and environment-agnostic: tests substitute an in-memory,
 * Map-backed implementation; the worker entry uses opfsStore().
 */

export interface OpfsStore {
  /** The saved bytes, or null when the file does not exist yet. */
  loadFile(name: string): Promise<Uint8Array | null>;
  saveFile(name: string, bytes: Uint8Array): Promise<void>;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/**
 * OPFS-backed OpfsStore rooted at the `notees/` directory of the origin's
 * per-origin storage bucket. The directory handle is resolved lazily and
 * cached; loadFile returns null for a missing file so a first boot opens a
 * fresh store.
 */
export function opfsStore(): OpfsStore {
  let dirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  const dir = (): Promise<FileSystemDirectoryHandle> => {
    dirPromise ??= navigator.storage.getDirectory().then((root) =>
      root.getDirectoryHandle("notees", { create: true }),
    );
    return dirPromise;
  };
  return {
    async loadFile(name) {
      try {
        const handle = await (await dir()).getFileHandle(name);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    },
    async saveFile(name, bytes) {
      const handle = await (await dir()).getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      // Copy into a plain ArrayBuffer: FileSystemWriteChunkType requires an
      // unshared view (Uint8Array<ArrayBufferLike> does not typecheck).
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      await writable.write(buffer);
      await writable.close();
    },
  };
}
