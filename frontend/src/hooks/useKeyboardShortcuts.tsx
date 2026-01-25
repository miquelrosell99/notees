/**
 * useKeyboardShortcuts - Hook for registering keyboard shortcuts
 * 
 * Provides a clean API for components to register keyboard shortcuts.
 * Shortcuts are automatically unregistered when the component unmounts.
 * 
 * Usage:
 * ```tsx
 * function MyComponent() {
 *   // Register a shortcut handler
 *   useKeyboardShortcut(SHORTCUT_IDS.QUICK_ADD, () => {
 *     openQuickAdd();
 *   });
 *   
 *   // Or with dynamic shortcuts
 *   useKeyboardShortcut('my.custom.shortcut', handleCustomShortcut, {
 *     enabled: isEditing,
 *     priority: 10,
 *   });
 * }
 * ```
 */
import { useEffect } from 'react';
import { 
  useKeyboardStore, 
  processKeyboardEvent,
  type ShortcutContext,
  SHORTCUT_IDS,
  formatShortcutKey,
} from '@/stores/keyboardStore';

export { SHORTCUT_IDS, formatShortcutKey };

interface UseKeyboardShortcutOptions {
  /** Whether the shortcut is currently enabled (default: true) */
  enabled?: boolean;
  /** Priority for conflict resolution (higher = handled first) */
  priority?: number;
}

/**
 * Register a keyboard shortcut handler
 */
export function useKeyboardShortcut(
  shortcutId: string,
  handler: () => void | boolean,
  options: UseKeyboardShortcutOptions = {}
) {
  const { enabled = true, priority = 0 } = options;
  const registerHandler = useKeyboardStore(state => state.registerHandler);
  
  useEffect(() => {
    if (!enabled) return;
    
    return registerHandler(shortcutId, handler, priority);
  }, [shortcutId, handler, enabled, priority, registerHandler]);
}

/**
 * Activate/deactivate a shortcut context
 */
export function useShortcutContext(context: ShortcutContext, active: boolean = true) {
  const activateContext = useKeyboardStore(state => state.activateContext);
  const deactivateContext = useKeyboardStore(state => state.deactivateContext);
  
  useEffect(() => {
    if (active) {
      activateContext(context);
      return () => deactivateContext(context);
    }
  }, [context, active, activateContext, deactivateContext]);
}

/**
 * Get the display string for a shortcut
 */
export function useShortcutDisplay(shortcutId: string): string {
  return useKeyboardStore(state => state.formatShortcut(shortcutId));
}

/**
 * Get all shortcuts for a context (useful for help dialogs)
 */
export function useShortcutsForContext(context: ShortcutContext) {
  return useKeyboardStore(state => 
    state.getAllShortcuts().filter(s => s.context === context)
  );
}

/**
 * Hook to set up global keyboard event listener
 * Should be used once at the app root level
 */
export function useGlobalKeyboardListener() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip if target is an input/textarea (unless it's our block editor)
      const target = event.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      
      // Allow some global shortcuts even in inputs (contentEditable handled by store)
      const isGlobalShortcut = event.ctrlKey || event.metaKey;
      
      if (isInput && !isGlobalShortcut) {
        return;
      }
      
      processKeyboardEvent(event);
    };
    
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);
}

/**
 * Provider component that sets up global keyboard handling
 */
export function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
  useGlobalKeyboardListener();
  return <>{children}</>;
}

export default useKeyboardShortcut;
