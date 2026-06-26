/**
 * CrdtSpikePage — interactive harness for the M4 CRDT text spike.
 *
 * Renders two InlineEditor instances bound to the same Yjs document.
 * Buttons let you seed rich content and simulate concurrent edits.
 * The serialized AST of each editor is shown live so you can inspect merges.
 */

import { useMemo, useRef, useState, useCallback, type JSX } from 'react';
import * as Y from 'yjs';
import {
  $getRoot,
  $createTextNode,
  type LexicalEditor,
  type ParagraphNode,
} from 'lexical';
import { InMemoryProvider } from './inMemoryProvider';
import { SpikeInlineEditor } from './SpikeInlineEditor';
import { serializeContentAST } from '../editor/editorConfig';
import { applyASTToEditor, readASTFromEditor, richSeedAST } from './crdtSpikeHelpers';
import './CrdtSpikePage.css';

interface CrdtSpikePageProps {
  onEditorAReady?: (editor: LexicalEditor) => void;
  onEditorBReady?: (editor: LexicalEditor) => void;
}

export function CrdtSpikePage({ onEditorAReady, onEditorBReady }: CrdtSpikePageProps): JSX.Element {
  const docRef = useRef(new Y.Doc());
  const providerARef = useRef(new InMemoryProvider());
  const providerBRef = useRef(new InMemoryProvider());
  const editorARef = useRef<LexicalEditor | null>(null);
  const editorBRef = useRef<LexicalEditor | null>(null);

  const [snapshotA, setSnapshotA] = useState<string>('');
  const [snapshotB, setSnapshotB] = useState<string>('');

  const refreshSnapshots = useCallback(() => {
    if (editorARef.current) {
      setSnapshotA(serializeContentAST(readASTFromEditor(editorARef.current)));
    }
    if (editorBRef.current) {
      setSnapshotB(serializeContentAST(readASTFromEditor(editorBRef.current)));
    }
  }, []);

  const handleEditorAReady = useCallback(
    (editor: LexicalEditor) => {
      editorARef.current = editor;
      onEditorAReady?.(editor);
      refreshSnapshots();
    },
    [onEditorAReady, refreshSnapshots],
  );

  const handleEditorBReady = useCallback(
    (editor: LexicalEditor) => {
      editorBRef.current = editor;
      onEditorBReady?.(editor);
      refreshSnapshots();
    },
    [onEditorBReady, refreshSnapshots],
  );

  const seedRichContent = useCallback(() => {
    if (editorARef.current) {
      applyASTToEditor(editorARef.current, richSeedAST);
      // Let the binding propagate the update before snapshotting.
      setTimeout(refreshSnapshots, 50);
    }
  }, [refreshSnapshots]);

  const appendToEditor = useCallback(
    (editor: LexicalEditor | null, suffix: string) => {
      if (!editor) return;
      editor.update(() => {
        const paragraph = $getRoot().getFirstChild();
        if (paragraph) {
          (paragraph as ParagraphNode).append($createTextNode(suffix));
        }
      });
      setTimeout(refreshSnapshots, 50);
    },
    [refreshSnapshots],
  );

  const prependToEditor = useCallback(
    (editor: LexicalEditor | null, prefix: string) => {
      if (!editor) return;
      editor.update(() => {
        const paragraph = $getRoot().getFirstChild();
        if (paragraph) {
          const first = (paragraph as ParagraphNode).getFirstChild();
          if (first) {
            first.insertBefore($createTextNode(prefix));
          } else {
            (paragraph as ParagraphNode).append($createTextNode(prefix));
          }
        }
      });
      setTimeout(refreshSnapshots, 50);
    },
    [refreshSnapshots],
  );

  // Re-snapshot after any onChange event.
  const handleChange = useCallback(() => {
    refreshSnapshots();
  }, [refreshSnapshots]);

  const doc = docRef.current;
  const providerA = providerARef.current;
  const providerB = providerBRef.current;

  // Memo-ize so we don't recreate editors on re-renders caused by snapshots.
  const editors = useMemo(
    () => (
      <div className="crdt-spike__editors">
        <div className="crdt-spike__pane">
          <h3>Editor A</h3>
          <SpikeInlineEditor
            id="spike-a"
            doc={doc}
            provider={providerA}
            username="Alice"
            cursorColor="#5B7D5B"
            placeholder="Type here (A)…"
            onEditorReady={handleEditorAReady}
            onChange={handleChange}
          />
        </div>
        <div className="crdt-spike__pane">
          <h3>Editor B</h3>
          <SpikeInlineEditor
            id="spike-b"
            doc={doc}
            provider={providerB}
            username="Bob"
            cursorColor="#7D5B5B"
            placeholder="Type here (B)…"
            onEditorReady={handleEditorBReady}
            onChange={handleChange}
          />
        </div>
      </div>
    ),
    [doc, providerA, providerB, handleEditorAReady, handleEditorBReady, handleChange],
  );

  return (
    <div className="crdt-spike">
      <h1>M4 CRDT Text Spike</h1>
      <p className="crdt-spike__subtitle">
        Two editors share one Yjs document. Type in either pane and watch the
        merge in the other.
      </p>

      <div className="crdt-spike__toolbar">
        <button type="button" onClick={seedRichContent}>
          Seed rich content
        </button>
        <button type="button" onClick={() => appendToEditor(editorARef.current, ' [A-end]')}>
          A append
        </button>
        <button type="button" onClick={() => prependToEditor(editorARef.current, '[A-start] ')}>
          A prepend
        </button>
        <button type="button" onClick={() => appendToEditor(editorBRef.current, ' [B-end]')}>
          B append
        </button>
        <button type="button" onClick={() => prependToEditor(editorBRef.current, '[B-start] ')}>
          B prepend
        </button>
        <button type="button" onClick={refreshSnapshots}>
          Refresh snapshots
        </button>
      </div>

      {editors}

      <div className="crdt-spike__snapshots">
        <div>
          <h4>Snapshot A</h4>
          <pre>{snapshotA || '(empty)'}</pre>
        </div>
        <div>
          <h4>Snapshot B</h4>
          <pre>{snapshotB || '(empty)'}</pre>
        </div>
      </div>
    </div>
  );
}
