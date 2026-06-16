/**
 * SyncedContentPlugin — Keeps the Lexical editor state in sync with an external
 * ContentAST prop without remounting the LexicalComposer.
 *
 * Rules:
 * - On mount, populate the editor from the prop.
 * - When the prop changes and the editor is **not** focused, overwrite the editor
 *   only if the serialized prop differs from the current editor content.
 * - While the editor is focused, local changes win; the prop is ignored so that
 *   typing is never interrupted by TanStack Query refetches.
 * - When the editor loses focus, re-evaluate and apply any pending prop change.
 */

import { useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $createParagraphNode, type ElementNode } from 'lexical';
import { populateInlineContent, extractInlineContent } from '../inlineContentPopulation';
import { serializeContentAST } from '../editorConfig';
import type { ContentAST } from '@/runtime/types';

interface SyncedContentPluginProps {
  contentAST: ContentAST;
}

function isEditorFocused(editor: ReturnType<typeof useLexicalComposerContext>[0]): boolean {
  const rootElement = editor.getRootElement();
  if (!rootElement) return false;
  return rootElement === document.activeElement || rootElement.contains(document.activeElement);
}

export function SyncedContentPlugin({ contentAST }: SyncedContentPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const [isFocused, setIsFocused] = useState(() => isEditorFocused(editor));
  // Track the last prop value we actually wrote into the editor. This lets us
  // distinguish "the prop changed externally" from "the editor has local edits
  // that haven't propagated back to the prop yet" (e.g. a trigger char typed
  // right before a popup blurs the editor).
  const lastAppliedPropRef = useRef<string | null>(null);

  // Subscribe to focus changes on the editor root so that losing focus can
  // trigger a re-sync with the latest prop.
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleFocusIn = () => setIsFocused(true);
    const handleFocusOut = () => setIsFocused(false);

    rootElement.addEventListener('focusin', handleFocusIn);
    rootElement.addEventListener('focusout', handleFocusOut);
    setIsFocused(isEditorFocused(editor));

    return () => {
      rootElement.removeEventListener('focusin', handleFocusIn);
      rootElement.removeEventListener('focusout', handleFocusOut);
    };
  }, [editor]);

  const serializedProp = serializeContentAST(contentAST);

  useEffect(() => {
    if (isFocused) return;

    // If the prop hasn't changed since the last time we applied it, don't
    // overwrite whatever is currently in the editor. This prevents popups that
    // steal focus (trigger menus, pickers) from clobbering a freshly-typed
    // character before the debounced save has propagated to the prop.
    if (lastAppliedPropRef.current !== null && serializedProp === lastAppliedPropRef.current) {
      return;
    }

    const currentSerialized = editor.getEditorState().read(() => {
      const root = $getRoot();
      const paragraph = root.getFirstChild();
      if (!paragraph) return '';
      return serializeContentAST(extractInlineContent(paragraph as ElementNode));
    });

    if (serializedProp === currentSerialized) {
      // Already in sync; record the prop so future changes are detected.
      lastAppliedPropRef.current = serializedProp;
      return;
    }

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        populateInlineContent(paragraph, contentAST);
        root.append(paragraph);
      },
      { tag: 'synced-content' },
    );

    lastAppliedPropRef.current = serializedProp;
  }, [editor, serializedProp, contentAST, isFocused]);

  return null;
}
