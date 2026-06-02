import { useEffect } from 'react';
import { processKeyboardEvent } from '@/stores/keyboardStore';

/**
 * Hook to set up global keyboard event listener.
 * Should be used once at the app root level.
 *
 * Intercepts ALL modifier shortcuts at the capture phase so the browser
 * never sees shortcuts the app claims (Ctrl+F, Ctrl+K, Ctrl+N, etc.).
 */
export function useGlobalKeyboardListener() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      const isContentEditable = target.isContentEditable;

      // Allow modifier shortcuts (Ctrl/Cmd) even in text editing contexts.
      // Non-modifier keys in inputs/contenteditable are left alone so typing works.
      const isModifierShortcut = event.ctrlKey || event.metaKey;

      if ((isInput || isContentEditable) && !isModifierShortcut) {
        return;
      }

      // Always process modifier shortcuts — processKeyboardEvent will decide
      // whether to consume them based on active contexts and registered commands.
      processKeyboardEvent(event);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);
}
