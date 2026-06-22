/**
 * SyncedContentPlugin — Keeps the Lexical editor state in sync with an external
 * ContentAST prop without remounting the LexicalComposer.
 *
 * Rules:
 * - On mount, populate the editor from the prop.
 * - When the prop changes and the editor is **not active** (blurred or read-only),
 *   overwrite the editor only if the serialized prop differs from the current
 *   editor content.
 * - While the editor is active (focused and editable, or blurred while a trigger
 *   popup is open for this editor), local changes win; the prop is ignored so that
 *   typing and trigger-popup operations are never interrupted by TanStack Query
 *   refetches.
 * - When the editor becomes inactive, re-evaluate and apply any pending prop change.
 */

import { useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $createParagraphNode, type ElementNode } from 'lexical';
import { populateInlineContent, extractInlineContent } from '../inlineContentPopulation';
import { serializeContentAST } from '../editorConfig';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import type { ContentAST } from '@/runtime/types';

interface SyncedContentPluginProps {
  contentAST: ContentAST;
  readOnly?: boolean;
  /** Block ID of the editor this plugin belongs to, used to detect popup ownership. */
  blockId?: string;
}

function isEditorFocused(editor: ReturnType<typeof useLexicalComposerContext>[0]): boolean {
  const rootElement = editor.getRootElement();
  if (!rootElement) return false;
  return rootElement === document.activeElement || rootElement.contains(document.activeElement);
}

export function SyncedContentPlugin({ contentAST, readOnly = false, blockId }: SyncedContentPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const [isFocused, setIsFocused] = useState(() => isEditorFocused(editor));
  const popupOpen = useEditorFocusStore((s) => s.popupOpen);
  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
  // The editor is "active" when it is focused and editable, or when a trigger
  // popup is open for this specific editor. Local edits win while active; we
  // snapshot the prop on activation so that on deactivation we can distinguish
  // "prop changed externally" from "editor has local edits that haven't
  // propagated back to the prop yet".
  const popupBelongsToEditor = blockId != null && popupOpen && activeBlockId === blockId;
  const isActive = (isFocused || popupBelongsToEditor) && !readOnly;
  const lastAppliedPropRef = useRef<string | null>(null);
  const wasActiveRef = useRef(false);

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
    const justActivated = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;

    if (isActive) {
      // Record the prop at the moment the editor becomes active. While active,
      // local edits win and prop changes are ignored. On deactivation we compare
      // against this snapshot to detect whether the prop changed externally.
      if (justActivated) {
        lastAppliedPropRef.current = serializedProp;
      }
      return;
    }

    // If the prop hasn't changed since the editor became active, don't overwrite
    // whatever is currently in the editor. This prevents popups that steal focus
    // (trigger menus, pickers) from clobbering a freshly-typed character before
    // the debounced save has propagated to the prop. The popup-open check above
    // already blocks sync while a trigger popup is open for this editor; this
    // guard handles other focus-stealing surfaces.
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
  }, [editor, serializedProp, contentAST, isActive]);

  return null;
}
