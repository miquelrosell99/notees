/**
 * BlockFindReplacePlugin — Page-level find/replace for the per-block editor.
 *
 * Renders the shared FindReplaceWidget as a portal when the store is open.
 * Does NOT depend on a single LexicalComposer context; instead it searches
 * across all editors registered in the InlineEditorRegistry.
 */

import { useEffect, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useFindReplaceStore } from '../../stores/findReplaceStore';
import { FindReplaceWidget } from './FindReplaceWidget';

export function BlockFindReplacePlugin(): JSX.Element | null {
  const isOpen = useFindReplaceStore((s) => s.isOpen);

  // Global Escape handler — closes the widget from anywhere
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        useFindReplaceStore.getState().close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(<FindReplaceWidget />, document.body);
}
