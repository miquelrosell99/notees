/**
 * EditablePlugin — Keeps the Lexical editor's editable state in sync with the
 * readOnly prop so that changes after mount are reflected.
 *
 * LexicalComposer only reads `initialConfig.editable` on mount; this plugin
 * calls `editor.setEditable()` whenever the prop changes.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

export interface EditablePluginProps {
  readOnly?: boolean;
}

export function EditablePlugin({ readOnly = false }: EditablePluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  return null;
}
