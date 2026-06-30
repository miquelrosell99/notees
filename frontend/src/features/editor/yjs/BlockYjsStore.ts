/**
 * BlockYjsStore — in-memory singleton that holds one Yjs document per block.
 *
 * The server is the source of truth; this store only keeps documents alive
 * while the frontend is running so that Lexical editors can bind to them and
 * so that incoming WebSocket Yjs updates can be applied.
 */

import * as Y from 'yjs';

type ChangeHandler = () => void;

interface Entry {
  doc: Y.Doc;
  handlers: Set<ChangeHandler>;
}

/**
 * Singleton store keyed by block UUID.
 *
 * Note: Lexical's Yjs collaboration binding requires an `Y.XmlElement` as the
 * shared root, so each document exposes a single shared type named `content`
 * as an `Y.XmlElement`. The backend stores the opaque Yjs update blob and does
 * not interpret the shared type, so this shape is an implementation detail of
 * the client-side binding.
 */
export class BlockYjsStore {
  private entries = new Map<string, Entry>();

  /** Return an existing doc for a block, or create a new one. */
  getDoc(blockUuid: string): Y.Doc {
    let entry = this.entries.get(blockUuid);
    if (!entry) {
      const doc = new Y.Doc();
      // Ensure the shared root exists immediately so subscribers can observe it.
      doc.get('content', Y.XmlElement);
      const handlers = new Set<ChangeHandler>();

      doc.on('update', () => {
        for (const handler of handlers) {
          try {
            handler();
          } catch {
            // Ignore subscriber errors to keep the binding alive.
          }
        }
      });

      entry = { doc, handlers };
      this.entries.set(blockUuid, entry);
    }
    return entry.doc;
  }

  /** Apply a remote Yjs update to the block's document. */
  applyUpdate(blockUuid: string, update: Uint8Array): void {
    const doc = this.getDoc(blockUuid);
    Y.applyUpdate(doc, update, 'remote');
  }

  /**
   * Subscribe to changes for a block's document.
   *
   * The handler is called whenever the document produces a Yjs update (local
   * or remote). Returns an unsubscribe function.
   */
  subscribe(blockUuid: string, handler: ChangeHandler): () => void {
    const entry = this.entries.get(blockUuid);
    if (!entry) {
      // Subscribe must work even if the doc has not been created yet; create
      // it lazily so the handler can be registered.
      this.getDoc(blockUuid);
      return this.subscribe(blockUuid, handler);
    }
    entry.handlers.add(handler);
    return () => {
      entry.handlers.delete(handler);
    };
  }

  /**
   * Access the shared `content` XmlElement for a block.
   *
   * This is a convenience helper for code that needs the shared root directly.
   */
  getContent(blockUuid: string): Y.XmlElement {
    return this.getDoc(blockUuid).get('content', Y.XmlElement);
  }
}

export const blockYjsStore = new BlockYjsStore();
