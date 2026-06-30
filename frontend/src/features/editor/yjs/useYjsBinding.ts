/**
 * useYjsBinding — binds a Lexical editor instance to a block-scoped Yjs doc.
 *
 * The hook wires:
 *   - local Lexical edits  -> Yjs update  -> WebSocket `yjs_update`
 *   - remote WebSocket `yjs_update`       -> Yjs doc    -> Lexical editor
 *
 * The existing `update_content` sync path is left untouched; CRDT and the
 * legacy path coexist for now.
 */

import { useEffect, useRef } from 'react';
import type { LexicalEditor } from 'lexical';
import { SKIP_COLLAB_TAG } from 'lexical';
import * as Y from 'yjs';
import {
  createBindingV2__EXPERIMENTAL,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';

import { liveSyncManager } from '@/features/collab';
import { getNodeYjsState } from '@/api/nodes';
import { getOperationRuntime } from '@/runtime';
import { blockYjsStore } from './BlockYjsStore';
import { ENABLE_CRDT_TEXT } from './config';
import { LiveSyncYjsProvider } from './LiveSyncYjsProvider';

function isServerBackedBlock(blockUuid: string): boolean {
  const runtime = getOperationRuntime();
  return runtime.snapshot().baseNodes.has(blockUuid);
}

const SYNCED_CONTENT_TAG = 'synced-content';

// Prevent duplicate concurrent Yjs-state fetches when an editor remounts rapidly
// (e.g. during focus shifts or React StrictMode double-mounts).
const inFlightYjsFetches = new Set<string>();

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Bind a Lexical editor to the shared Yjs document for `blockUuid`.
 *
 * Returns a cleanup function that tears down the binding and WebSocket
 * listener. The hook itself also cleans up automatically on unmount.
 */
export function useYjsBinding(
  blockUuid: string | null,
  editor: LexicalEditor | null,
): () => void {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!ENABLE_CRDT_TEXT || !blockUuid || !editor) return;

    const doc = blockYjsStore.getDoc(blockUuid);
    const docMap = new Map<string, Y.Doc>();
    docMap.set(blockUuid, doc);

    const provider = new LiveSyncYjsProvider(doc, blockUuid);
    const binding = createBindingV2__EXPERIMENTAL(editor, blockUuid, doc, docMap, {
      rootName: 'content',
    });

    // Seed the Yjs doc from the current editor state when there is no server
    // state yet. This avoids the binding starting from an empty document while
    // the Lexical editor already has content from the prop.
    const bootstrapFromEditorIfEmpty = () => {
      if (binding.root.length === 0) {
        const state = editor.getEditorState();
        syncLexicalUpdateToYjsV2__EXPERIMENTAL(
          binding,
          provider,
          state,
          state,
          new Map([['root', true]]),
          new Set(),
          new Set(),
        );
      }
    };

    // Hydrate the binding with the latest server state on first mount.
    // Blocks that are not yet in the server-backed base state (e.g. newly
    // created local blocks) have no stored Yjs state; skip the fetch and
    // bootstrap from the editor to avoid predictable 404s.
    let cancelled = false;
    if (!isServerBackedBlock(blockUuid)) {
      bootstrapFromEditorIfEmpty();
    } else if (!inFlightYjsFetches.has(blockUuid)) {
      inFlightYjsFetches.add(blockUuid);
      getNodeYjsState(blockUuid)
        .then((blob) => {
          inFlightYjsFetches.delete(blockUuid);
          if (cancelled) return;
          if (blob.byteLength > 0) {
            blockYjsStore.applyUpdate(blockUuid, new Uint8Array(blob));
          } else {
            bootstrapFromEditorIfEmpty();
          }
        })
        .catch(() => {
          inFlightYjsFetches.delete(blockUuid);
          // Ignore fetch failures; seed from the editor so local edits still
          // produce meaningful Yjs updates.
          bootstrapFromEditorIfEmpty();
        });
    }

    // Local Lexical changes -> Yjs doc.
    const removeUpdateListener = editor.registerUpdateListener(
      ({ prevEditorState, editorState, dirtyElements, normalizedNodes, tags }) => {
        if (tags.has(SKIP_COLLAB_TAG) || tags.has(SYNCED_CONTENT_TAG)) return;
        syncLexicalUpdateToYjsV2__EXPERIMENTAL(
          binding,
          provider,
          prevEditorState,
          editorState,
          dirtyElements,
          normalizedNodes,
          tags,
        );
      },
    );

    // Remote Yjs changes -> Lexical editor.
    const onYjsTreeChanges = (
      events: Y.YEvent<Y.XmlElement | Y.XmlText>[],
      transaction: Y.Transaction,
    ) => {
      if (transaction.origin === binding) return;
      const isFromUndoManager = transaction.origin instanceof Y.UndoManager;
      syncYjsChangesToLexicalV2__EXPERIMENTAL(
        binding,
        provider,
        events,
        transaction,
        isFromUndoManager,
      );
    };
    binding.root.observeDeep(onYjsTreeChanges);

    // WebSocket remote updates -> Yjs doc.
    const unsubscribeWs = liveSyncManager.onYjsUpdate((msg) => {
      if (msg.node_uuid !== blockUuid) return;
      blockYjsStore.applyUpdate(blockUuid, base64ToUint8Array(msg.update_blob));
    });

    provider.connect();

    const cleanup = () => {
      cancelled = true;
      removeUpdateListener();
      binding.root.unobserveDeep(onYjsTreeChanges);
      unsubscribeWs();
      provider.disconnect();
    };
    cleanupRef.current = cleanup;

    return cleanup;
  }, [blockUuid, editor]);

  return () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  };
}
