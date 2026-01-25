/**
 * Keyboard Shortcuts System
 * 
 * Centralized keyboard shortcut management for the entire application.
 * Replaces scattered keyboard event handlers with a unified system.
 * 
 * Features:
 * - Global and context-specific shortcuts
 * - Configurable shortcuts (can be remapped)
 * - Conflict detection
 * - Modifier key support (Ctrl/Cmd, Shift, Alt)
 * - Prevent default behavior control
 * - Priority-based handling for overlapping shortcuts
 * 
 * Architecture:
 * - KeyboardShortcutsProvider: Context provider that sets up global listeners
 * - useKeyboardShortcut: Hook for registering shortcuts in components
 * - keyboardStore: Zustand store for shortcut configuration
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Modifier keys that can be combined with other keys
 */
export interface ModifierKeys {
  ctrl?: boolean;   // Ctrl on Windows/Linux, Cmd on Mac
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;   // Specifically the Meta/Windows key
}

/**
 * Definition of a keyboard shortcut
 */
export interface ShortcutDefinition {
  /** Unique identifier for the shortcut */
  id: string;
  /** Human-readable description */
  description: string;
  /** The key to press (e.g., 'k', 'Enter', 'Escape') */
  key: string;
  /** Required modifier keys */
  modifiers: ModifierKeys;
  /** Context where this shortcut is active (global, editor, modal, etc.) */
  context: ShortcutContext;
  /** Whether this shortcut can be customized by users */
  configurable?: boolean;
  /** Priority for conflict resolution (higher = handled first) */
  priority?: number;
}

/**
 * Contexts for shortcut activation
 */
export type ShortcutContext = 
  | 'global'        // Always active
  | 'editor'        // Active when editing a block
  | 'selection'     // Active when blocks are selected
  | 'modal'         // Active when a modal is open
  | 'sidebar'       // Active when sidebar is focused
  | 'search';       // Active when search is focused

/**
 * Built-in shortcut IDs
 */
export const SHORTCUT_IDS = {
  // Global
  QUICK_ADD: 'global.quickAdd',
  SEARCH: 'global.search',
  COMMAND_PALETTE: 'global.commandPalette',
  TOGGLE_SIDEBAR: 'global.toggleSidebar',
  GO_TODAY: 'global.goToday',
  NEW_PAGE: 'global.newPage',
  SETTINGS: 'global.settings',
  
  // Editor
  BOLD: 'editor.bold',
  ITALIC: 'editor.italic',
  STRIKETHROUGH: 'editor.strikethrough',
  LINK: 'editor.link',
  INDENT: 'editor.indent',
  OUTDENT: 'editor.outdent',
  SPLIT_BLOCK: 'editor.splitBlock',
  MERGE_UP: 'editor.mergeUp',
  MOVE_UP: 'editor.moveUp',
  MOVE_DOWN: 'editor.moveDown',
  
  // Selection
  SELECT_ALL: 'selection.selectAll',
  SELECT_UP: 'selection.selectUp',
  SELECT_DOWN: 'selection.selectDown',
  DELETE_SELECTED: 'selection.delete',
  COPY: 'selection.copy',
  CUT: 'selection.cut',
  PASTE: 'selection.paste',
  
  // Navigation
  NAV_UP: 'nav.up',
  NAV_DOWN: 'nav.down',
  ESCAPE: 'nav.escape',
} as const;

/**
 * Default shortcut definitions
 */
export const DEFAULT_SHORTCUTS: ShortcutDefinition[] = [
  // Global shortcuts
  { id: SHORTCUT_IDS.QUICK_ADD, description: 'Open Quick Add', key: 'q', modifiers: { ctrl: true }, context: 'global', configurable: true },
  { id: SHORTCUT_IDS.SEARCH, description: 'Focus Search', key: 'k', modifiers: { ctrl: true }, context: 'global', configurable: true },
  { id: SHORTCUT_IDS.COMMAND_PALETTE, description: 'Open Command Palette', key: 'p', modifiers: { ctrl: true, shift: true }, context: 'global', configurable: true },
  { id: SHORTCUT_IDS.TOGGLE_SIDEBAR, description: 'Toggle Sidebar', key: '\\', modifiers: { ctrl: true }, context: 'global', configurable: true },
  { id: SHORTCUT_IDS.GO_TODAY, description: 'Go to Today', key: 't', modifiers: { ctrl: true, shift: true }, context: 'global', configurable: true },
  { id: SHORTCUT_IDS.NEW_PAGE, description: 'New Page', key: 'n', modifiers: { ctrl: true }, context: 'global', configurable: true },
  { id: SHORTCUT_IDS.SETTINGS, description: 'Open Settings', key: ',', modifiers: { ctrl: true }, context: 'global', configurable: true },
  
  // Editor shortcuts
  { id: SHORTCUT_IDS.BOLD, description: 'Bold', key: 'b', modifiers: { ctrl: true }, context: 'editor', priority: 10 },
  { id: SHORTCUT_IDS.ITALIC, description: 'Italic', key: 'i', modifiers: { ctrl: true }, context: 'editor', priority: 10 },
  { id: SHORTCUT_IDS.STRIKETHROUGH, description: 'Strikethrough', key: 's', modifiers: { ctrl: true, shift: true }, context: 'editor', priority: 10 },
  { id: SHORTCUT_IDS.LINK, description: 'Insert Link', key: 'k', modifiers: { ctrl: true }, context: 'editor', priority: 20 },
  { id: SHORTCUT_IDS.INDENT, description: 'Indent Block', key: 'Tab', modifiers: {}, context: 'editor' },
  { id: SHORTCUT_IDS.OUTDENT, description: 'Outdent Block', key: 'Tab', modifiers: { shift: true }, context: 'editor' },
  { id: SHORTCUT_IDS.SPLIT_BLOCK, description: 'Split Block (New Line)', key: 'Enter', modifiers: {}, context: 'editor' },
  { id: SHORTCUT_IDS.MERGE_UP, description: 'Merge with Block Above', key: 'Backspace', modifiers: {}, context: 'editor' },
  { id: SHORTCUT_IDS.MOVE_UP, description: 'Move Block Up', key: 'ArrowUp', modifiers: { ctrl: true, shift: true }, context: 'editor', configurable: true },
  { id: SHORTCUT_IDS.MOVE_DOWN, description: 'Move Block Down', key: 'ArrowDown', modifiers: { ctrl: true, shift: true }, context: 'editor', configurable: true },
  
  // Selection shortcuts
  { id: SHORTCUT_IDS.SELECT_ALL, description: 'Select All Blocks', key: 'a', modifiers: { ctrl: true }, context: 'selection' },
  { id: SHORTCUT_IDS.SELECT_UP, description: 'Extend Selection Up', key: 'ArrowUp', modifiers: { shift: true }, context: 'selection' },
  { id: SHORTCUT_IDS.SELECT_DOWN, description: 'Extend Selection Down', key: 'ArrowDown', modifiers: { shift: true }, context: 'selection' },
  { id: SHORTCUT_IDS.DELETE_SELECTED, description: 'Delete Selected Blocks', key: 'Delete', modifiers: {}, context: 'selection' },
  { id: SHORTCUT_IDS.COPY, description: 'Copy', key: 'c', modifiers: { ctrl: true }, context: 'selection' },
  { id: SHORTCUT_IDS.CUT, description: 'Cut', key: 'x', modifiers: { ctrl: true }, context: 'selection' },
  { id: SHORTCUT_IDS.PASTE, description: 'Paste', key: 'v', modifiers: { ctrl: true }, context: 'selection' },
  
  // Navigation
  { id: SHORTCUT_IDS.NAV_UP, description: 'Navigate Up', key: 'ArrowUp', modifiers: {}, context: 'editor' },
  { id: SHORTCUT_IDS.NAV_DOWN, description: 'Navigate Down', key: 'ArrowDown', modifiers: {}, context: 'editor' },
  { id: SHORTCUT_IDS.ESCAPE, description: 'Exit/Cancel', key: 'Escape', modifiers: {}, context: 'global' },
];

/**
 * Registered shortcut handler
 */
interface RegisteredHandler {
  shortcutId: string;
  handler: () => void | boolean; // Return false to allow propagation
  priority: number;
}

interface KeyboardState {
  /** User-customized shortcuts (merged with defaults) */
  customShortcuts: Record<string, Partial<ShortcutDefinition>>;
  
  /** Currently active contexts */
  activeContexts: Set<ShortcutContext>;
  
  /** Registered handlers (runtime, not persisted) */
  handlers: Map<string, RegisteredHandler[]>;
  
  /** Whether shortcuts are globally disabled (e.g., during text input) */
  disabled: boolean;
  
  // Actions
  setCustomShortcut: (id: string, shortcut: Partial<ShortcutDefinition>) => void;
  resetShortcut: (id: string) => void;
  resetAllShortcuts: () => void;
  
  activateContext: (context: ShortcutContext) => void;
  deactivateContext: (context: ShortcutContext) => void;
  
  registerHandler: (shortcutId: string, handler: () => void | boolean, priority?: number) => () => void;
  
  setDisabled: (disabled: boolean) => void;
  
  // Getters
  getShortcut: (id: string) => ShortcutDefinition | undefined;
  getAllShortcuts: () => ShortcutDefinition[];
  formatShortcut: (id: string) => string;
  isContextActive: (context: ShortcutContext) => boolean;
}

/**
 * Format a shortcut for display
 */
export function formatShortcutKey(shortcut: ShortcutDefinition): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const parts: string[] = [];
  
  if (shortcut.modifiers.ctrl) {
    parts.push(isMac ? '⌘' : 'Ctrl');
  }
  if (shortcut.modifiers.alt) {
    parts.push(isMac ? '⌥' : 'Alt');
  }
  if (shortcut.modifiers.shift) {
    parts.push(isMac ? '⇧' : 'Shift');
  }
  if (shortcut.modifiers.meta) {
    parts.push(isMac ? '⌃' : 'Win');
  }
  
  // Format special keys
  const keyDisplay = {
    'ArrowUp': '↑',
    'ArrowDown': '↓',
    'ArrowLeft': '←',
    'ArrowRight': '→',
    'Enter': '↵',
    'Escape': 'Esc',
    'Backspace': '⌫',
    'Delete': 'Del',
    'Tab': '⇥',
    ' ': 'Space',
  }[shortcut.key] || shortcut.key.toUpperCase();
  
  parts.push(keyDisplay);
  
  return parts.join(isMac ? '' : '+');
}

/**
 * Check if a keyboard event matches a shortcut
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  
  // Check modifiers
  const ctrlMatch = shortcut.modifiers.ctrl 
    ? (isMac ? event.metaKey : event.ctrlKey)
    : !(isMac ? event.metaKey : event.ctrlKey);
  const shiftMatch = shortcut.modifiers.shift ? event.shiftKey : !event.shiftKey;
  const altMatch = shortcut.modifiers.alt ? event.altKey : !event.altKey;
  const metaMatch = shortcut.modifiers.meta ? event.metaKey : true; // Meta is optional unless specified
  
  // Check key
  const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase() ||
                   event.code.toLowerCase() === `key${shortcut.key.toLowerCase()}`;
  
  return ctrlMatch && shiftMatch && altMatch && metaMatch && keyMatch;
}

export const useKeyboardStore = create<KeyboardState>()(
  persist(
    (set, get) => ({
      customShortcuts: {},
      activeContexts: new Set(['global']),
      handlers: new Map(),
      disabled: false,
      
      setCustomShortcut: (id, shortcut) => {
        set((state) => ({
          customShortcuts: {
            ...state.customShortcuts,
            [id]: shortcut,
          },
        }));
      },
      
      resetShortcut: (id) => {
        set((state) => {
          const { [id]: _, ...rest } = state.customShortcuts;
          return { customShortcuts: rest };
        });
      },
      
      resetAllShortcuts: () => {
        set({ customShortcuts: {} });
      },
      
      activateContext: (context) => {
        set((state) => {
          const newContexts = new Set(state.activeContexts);
          newContexts.add(context);
          return { activeContexts: newContexts };
        });
      },
      
      deactivateContext: (context) => {
        set((state) => {
          const newContexts = new Set(state.activeContexts);
          newContexts.delete(context);
          return { activeContexts: newContexts };
        });
      },
      
      registerHandler: (shortcutId, handler, priority = 0) => {
        const handlers = get().handlers;
        const existing = handlers.get(shortcutId) || [];
        const newHandler: RegisteredHandler = { shortcutId, handler, priority };
        
        // Insert sorted by priority (descending)
        const newHandlers = [...existing, newHandler].sort((a, b) => b.priority - a.priority);
        handlers.set(shortcutId, newHandlers);
        
        set({ handlers: new Map(handlers) });
        
        // Return unregister function
        return () => {
          const currentHandlers = get().handlers;
          const filtered = (currentHandlers.get(shortcutId) || []).filter(h => h !== newHandler);
          if (filtered.length === 0) {
            currentHandlers.delete(shortcutId);
          } else {
            currentHandlers.set(shortcutId, filtered);
          }
          set({ handlers: new Map(currentHandlers) });
        };
      },
      
      setDisabled: (disabled) => {
        set({ disabled });
      },
      
      getShortcut: (id) => {
        const custom = get().customShortcuts[id];
        const defaultShortcut = DEFAULT_SHORTCUTS.find(s => s.id === id);
        
        if (!defaultShortcut) return undefined;
        
        return custom ? { ...defaultShortcut, ...custom } : defaultShortcut;
      },
      
      getAllShortcuts: () => {
        const custom = get().customShortcuts;
        return DEFAULT_SHORTCUTS.map(s => ({
          ...s,
          ...custom[s.id],
        }));
      },
      
      formatShortcut: (id) => {
        const shortcut = get().getShortcut(id);
        return shortcut ? formatShortcutKey(shortcut) : '';
      },
      
      isContextActive: (context) => {
        return get().activeContexts.has(context);
      },
    }),
    {
      name: 'notees-keyboard-shortcuts',
      partialize: (state) => ({
        customShortcuts: state.customShortcuts,
      }),
    }
  )
);

/**
 * Process a keyboard event against registered shortcuts
 */
export function processKeyboardEvent(event: KeyboardEvent): boolean {
  const state = useKeyboardStore.getState();
  
  if (state.disabled) return false;
  
  const shortcuts = state.getAllShortcuts();
  const activeContexts = state.activeContexts;
  
  // Find matching shortcuts in active contexts
  const matches = shortcuts
    .filter(s => activeContexts.has(s.context) && matchesShortcut(event, s))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  
  for (const shortcut of matches) {
    const handlers = state.handlers.get(shortcut.id) || [];
    
    for (const { handler } of handlers) {
      const result = handler();
      if (result !== false) {
        // Handler consumed the event
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
    }
  }
  
  return false;
}
