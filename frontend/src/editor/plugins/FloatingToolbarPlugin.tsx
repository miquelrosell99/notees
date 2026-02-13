/**
 * FloatingToolbarPlugin — Shows a floating toolbar on text selection
 * for formatting operations.
 */

import { useEffect, useState, useCallback, useRef, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type TextFormatType,
} from 'lexical';
import { createPortal } from 'react-dom';
import { mdiFormatBold, mdiFormatItalic, mdiFormatUnderline, mdiFormatStrikethrough, mdiCodeTags } from '@mdi/js';
import { Card } from '../../components/core/Card';
import { Button } from '../../components/core/Button';
import './FloatingToolbarPlugin.css';

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
  const showTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const updateToolbar = () => {
      // Clear any pending show timeout
      if (showTimeoutRef.current !== null) {
        window.clearTimeout(showTimeoutRef.current);
        showTimeoutRef.current = null;
      }

      editor.getEditorState().read(() => {
        // Only process if the editor root is focused
        const rootElement = editor.getRootElement();
        if (!rootElement || !rootElement.contains(document.activeElement)) {
          setIsVisible(false);
          return;
        }

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

        // Position the toolbar above the selection
        const nativeSel = window.getSelection();
        if (!nativeSel || nativeSel.rangeCount === 0) {
          setIsVisible(false);
          return;
        }

        // Delay showing the toolbar to avoid flash during drag-to-select
        // Position is computed inside the timeout to avoid stale coordinates
        showTimeoutRef.current = window.setTimeout(() => {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
            setIsVisible(false);
            showTimeoutRef.current = null;
            return;
          }
          const r = sel.getRangeAt(0);
          const rect = r.getBoundingClientRect();
          setPosition({
            top: rect.top - 40 + window.scrollY,
            left: rect.left + rect.width / 2 + window.scrollX,
          });
          setIsVisible(true);
          showTimeoutRef.current = null;
        }, 150);
      });
    };

    document.addEventListener('selectionchange', updateToolbar);
    return () => {
      document.removeEventListener('selectionchange', updateToolbar);
      if (showTimeoutRef.current !== null) {
        window.clearTimeout(showTimeoutRef.current);
      }
    };
  }, [editor]);

  const handleFormat = useCallback((format: TextFormatType) => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  }, [editor]);

  // Prevent toolbar clicks from blurring the editor
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  if (!isVisible) return null;

  const toolbar = (
    <div
      className="floating-toolbar"
      data-editor-companion="true"
      style={{
        position: 'absolute',
        top: position.top,
        left: position.left,
        transform: 'translateX(-50%)',
        zIndex: 1000,
        pointerEvents: 'auto',
      }}
      onMouseDown={handleMouseDown}
    >
      <Card
        elevation="high"
        variant="default"
        padding={true}
        paddingSize="sm"
        radius="md"
        className="floating-toolbar__card"
      >
        <div className="floating-toolbar__actions">
          <Button
            icon={mdiFormatBold}
            variant="ghost"
            size="sm"
            title="Bold (Ctrl+B)"
            active={activeFormats.has('bold')}
            onClick={() => handleFormat('bold')}
            className="floating-toolbar__button"
          />
          <Button
            icon={mdiFormatItalic}
            variant="ghost"
            size="sm"
            title="Italic (Ctrl+I)"
            active={activeFormats.has('italic')}
            onClick={() => handleFormat('italic')}
            className="floating-toolbar__button"
          />
          <Button
            icon={mdiFormatUnderline}
            variant="ghost"
            size="sm"
            title="Underline (Ctrl+U)"
            active={activeFormats.has('underline')}
            onClick={() => handleFormat('underline')}
            className="floating-toolbar__button"
          />
          <Button
            icon={mdiFormatStrikethrough}
            variant="ghost"
            size="sm"
            title="Strikethrough (Ctrl+Shift+D)"
            active={activeFormats.has('strikethrough')}
            onClick={() => handleFormat('strikethrough')}
            className="floating-toolbar__button"
          />
          <Button
            icon={mdiCodeTags}
            variant="ghost"
            size="sm"
            title="Code (Ctrl+E)"
            active={activeFormats.has('code')}
            onClick={() => handleFormat('code')}
            className="floating-toolbar__button"
          />
        </div>
      </Card>
    </div>
  );

  return createPortal(toolbar, anchorElement || document.body);
}
