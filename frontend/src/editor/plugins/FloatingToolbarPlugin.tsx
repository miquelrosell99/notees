/**
 * FloatingToolbarPlugin — Shows a floating toolbar on text selection
 * for formatting operations.
 */

import { useEffect, useState, useCallback, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type TextFormatType,
} from 'lexical';
import { createPortal } from 'react-dom';

export interface FloatingToolbarPluginProps {
  anchorElement?: HTMLElement;
}

export function FloatingToolbarPlugin({
  anchorElement,
}: FloatingToolbarPluginProps): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [activeFormats, setActiveFormats] = useState<Set<TextFormatType>>(new Set());

  useEffect(() => {
    const updateToolbar = () => {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          setIsVisible(false);
          return;
        }

        // Get format state
        const formats = new Set<TextFormatType>();
        if (selection.hasFormat('bold')) formats.add('bold');
        if (selection.hasFormat('italic')) formats.add('italic');
        if (selection.hasFormat('underline')) formats.add('underline');
        if (selection.hasFormat('strikethrough')) formats.add('strikethrough');
        if (selection.hasFormat('code')) formats.add('code');
        setActiveFormats(formats);

        // Position
        const nativeSel = window.getSelection();
        if (nativeSel && nativeSel.rangeCount > 0) {
          const range = nativeSel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          setPosition({
            top: rect.top - 40 + window.scrollY,
            left: rect.left + rect.width / 2 + window.scrollX,
          });
          setIsVisible(true);
        }
      });
    };

    document.addEventListener('selectionchange', updateToolbar);
    return () => document.removeEventListener('selectionchange', updateToolbar);
  }, [editor]);

  const handleFormat = useCallback((format: TextFormatType) => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  }, [editor]);

  if (!isVisible) return null;

  const toolbar = (
    <div
      className="floating-toolbar"
      style={{
        position: 'absolute',
        top: position.top,
        left: position.left,
        transform: 'translateX(-50%)',
        zIndex: 1000,
      }}
    >
      <div className="floating-toolbar-inner">
        <button
          className={`floating-toolbar-btn ${activeFormats.has('bold') ? 'active' : ''}`}
          onClick={() => handleFormat('bold')}
          title="Bold (Ctrl+B)"
          type="button"
        >
          <strong>B</strong>
        </button>
        <button
          className={`floating-toolbar-btn ${activeFormats.has('italic') ? 'active' : ''}`}
          onClick={() => handleFormat('italic')}
          title="Italic (Ctrl+I)"
          type="button"
        >
          <em>I</em>
        </button>
        <button
          className={`floating-toolbar-btn ${activeFormats.has('underline') ? 'active' : ''}`}
          onClick={() => handleFormat('underline')}
          title="Underline (Ctrl+U)"
          type="button"
        >
          <u>U</u>
        </button>
        <button
          className={`floating-toolbar-btn ${activeFormats.has('strikethrough') ? 'active' : ''}`}
          onClick={() => handleFormat('strikethrough')}
          title="Strikethrough (Ctrl+Shift+D)"
          type="button"
        >
          <s>S</s>
        </button>
        <button
          className={`floating-toolbar-btn ${activeFormats.has('code') ? 'active' : ''}`}
          onClick={() => handleFormat('code')}
          title="Code (Ctrl+E)"
          type="button"
        >
          {'</>'}
        </button>
      </div>
    </div>
  );

  return createPortal(toolbar, anchorElement || document.body);
}
