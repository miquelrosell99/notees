/**
 * Lexical editor theme configuration for Notees.
 */

import type { EditorThemeClasses } from 'lexical';

export const notesEditorTheme: EditorThemeClasses = {
  root: 'notees-editor-root',
  paragraph: 'notees-editor-paragraph',
  text: {
    bold: 'notees-text-bold',
    italic: 'notees-text-italic',
    underline: 'notees-text-underline',
    strikethrough: 'notees-text-strikethrough',
    code: 'notees-text-code',
    underlineStrikethrough: 'notees-text-underline-strikethrough',
  },
  link: 'notees-editor-link',
  code: 'notees-editor-code-block',
  heading: {
    h1: 'notees-heading-h1',
    h2: 'notees-heading-h2',
    h3: 'notees-heading-h3',
  },
};
