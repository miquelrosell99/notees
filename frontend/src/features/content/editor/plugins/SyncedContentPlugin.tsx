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

import { useEffect, useState } from 'react';
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

    const currentSerialized = editor.getEditorState().read(() => {
      const root = $getRoot();
      const paragraph = root.getFirstChild();
      if (!paragraph) return '';
      return serializeContentAST(extractInlineContent(paragraph as ElementNode));
    });

    if (serializedProp === currentSerialized) return;

    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      populateInlineContent(paragraph, contentAST);
      root.append(paragraph);
    });
  }, [editor, serializedProp, contentAST, isFocused]);

  return null;
}
