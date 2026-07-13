/**
 * useDisableNativeContextMenu — suppresses the browser's native context menu
 * app-wide, except inside text-entry surfaces (inputs, textareas, selects and
 * contenteditable elements) where cut/copy/paste, spellcheck, and autofill
 * actions live.
 *
 * The listener runs in the capture phase and only calls preventDefault — it
 * never stops propagation, so the app's own contextmenu handlers (custom
 * menus) still fire.
 */
import { useEffect } from 'react';

export function useDisableNativeContextMenu(): void {
  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // Text-entry surfaces keep the native menu.
      if (target.isContentEditable) return;
      if (target.closest('input, textarea, select')) return;
      event.preventDefault();
    };

    document.addEventListener('contextmenu', handleContextMenu, true);
    return () => document.removeEventListener('contextmenu', handleContextMenu, true);
  }, []);
}
