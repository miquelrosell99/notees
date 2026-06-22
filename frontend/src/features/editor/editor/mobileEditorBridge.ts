/**
 * Mobile editor bridge — exposes a minimal imperative API for the native
 * Flutter shell to drive the focused Lexical editor.
 *
 * Methods are called from Flutter via WebView.runJavaScript():
 *   window.noteesMobileEditor.applyFormat('bold')
 *
 * Focus changes are reported back to Flutter as CustomEvents:
 *   window.dispatchEvent(new CustomEvent('notees:editor-focus-changed', { detail: { focused: true } }))
 */

import {
  $getSelection,
  $isRangeSelection,
  type TextFormatType,
} from 'lexical';
import {
  applyFormatToActiveEditor,
  getActiveEditor,
} from './activeEditorRegistry';

const VALID_FORMATS: TextFormatType[] = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'code',
];

interface MobileEditorBridge {
  applyFormat(format: string): boolean;
  insertDate(): boolean;
  insertLink(): boolean;
  insertLinkWithText(linkText: string): boolean;
}

declare global {
  interface Window {
    noteesMobileEditor?: MobileEditorBridge;
  }
}

function dispatchFocusChanged(focused: boolean): void {
  window.dispatchEvent(
    new CustomEvent('notees:editor-focus-changed', { detail: { focused } }),
  );
}

export function initMobileEditorBridge(): void {
  window.noteesMobileEditor = {
    applyFormat(format) {
      if (!VALID_FORMATS.includes(format as TextFormatType)) {
        return false;
      }
      applyFormatToActiveEditor(format as TextFormatType);
      return true;
    },

    insertDate() {
      const editor = getActiveEditor();
      if (!editor) return false;
      const today = new Date().toISOString().split('T')[0];
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        selection.insertText(`[[${today}]]`);
      });
      return true;
    },

    insertLink() {
      const editor = getActiveEditor();
      if (!editor) return false;
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const text = selection.getTextContent();
        const linkText = text || 'link';
        selection.insertText(`[[${linkText}]]`);
      });
      return true;
    },

    insertLinkWithText(linkText) {
      const editor = getActiveEditor();
      if (!editor) return false;
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        selection.insertText(`[[${linkText}]]`);
      });
      return true;
    },
  };
}

export function reportEditorFocus(focused: boolean): void {
  dispatchFocusChanged(focused);
}
