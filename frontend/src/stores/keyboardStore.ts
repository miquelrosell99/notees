/**
 * Keyboard Shortcuts System
 *
 * Maps keyboard combinations to command IDs in the Command Registry.
 * All browser shortcuts the app claims are intercepted at the capture phase
 * so the browser never sees them.
 *
 * Architecture:
 *   KeyboardEvent → match shortcut → look up command ID → execute via CommandRegistry
 *
 * The keyboard store also supports legacy handler registration for gradual migration.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCommandRegistry, type ShortcutContext } from './commandRegistry';

/**
 * Modifier keys that can be combined with other keys
 */
export interface ModifierKeys {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
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
  /** Context where this shortcut is active */
  context: ShortcutContext;
  /** The command ID to execute when this shortcut is triggered */
  commandId: string;
  /** Whether this shortcut can be customized by users */
  configurable?: boolean;
  /** Priority for conflict resolution (higher = handled first) */
  priority?: number;
}

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
  ADD_PROPERTY: 'global.addProperty',
  UNDO: 'global.undo',
  REDO: 'global.redo',
  REDO_ALT: 'global.redoAlt',
  IMPORT_DATA: 'global.importData',
  TOGGLE_FOCUS_MODE: 'global.toggleFocusMode',

  // Editor
  BOLD: 'editor.bold',
  ITALIC: 'editor.italic',
  UNDERLINE: 'editor.underline',
  STRIKETHROUGH: 'editor.strikethrough',
  CODE: 'editor.code',
  LINK: 'editor.link',
  FIND: 'editor.find',
  FIND_TOGGLE_REPLACE: 'editor.findToggleReplace',
  INDENT: 'editor.indent',
  OUTDENT: 'editor.outdent',
  MOVE_UP: 'editor.moveUp',
  MOVE_DOWN: 'editor.moveDown',
  TOGGLE_FOLD: 'editor.toggleFold',
  TOGGLE_FOLD_ALT_LEFT: 'editor.toggleFoldAltLeft',
  TOGGLE_FOLD_ALT_RIGHT: 'editor.toggleFoldAltRight',

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

import { COMMAND_IDS } from './commandRegistry';

/**
 * Default shortcut definitions — every entry maps to a command in the registry.
 */
export const DEFAULT_SHORTCUTS: ShortcutDefinition[] = [
  // Global shortcuts
  { id: SHORTCUT_IDS.COMMAND_PALETTE, description: 'Open Command Palette', key: 'k', modifiers: { ctrl: true }, context: 'global', commandId: COMMAND_IDS.COMMAND_PALETTE, configurable: true },
  { id: SHORTCUT_IDS.QUICK_ADD, description: 'Open Quick Add', key: 'n', modifiers: { ctrl: true }, context: 'global', commandId: COMMAND_IDS.QUICK_ADD, configurable: true },
  { id: SHORTCUT_IDS.GO_TODAY, description: 'Go to Today', key: 't', modifiers: { ctrl: true, shift: true }, context: 'global', commandId: COMMAND_IDS.GO_TODAY, configurable: true },
  { id: SHORTCUT_IDS.TOGGLE_SIDEBAR, description: 'Toggle Sidebar', key: '\\', modifiers: { ctrl: true }, context: 'global', commandId: COMMAND_IDS.TOGGLE_SIDEBAR, configurable: true },
  { id: SHORTCUT_IDS.NEW_PAGE, description: 'New Page', key: 'n', modifiers: { ctrl: true }, context: 'global', commandId: COMMAND_IDS.NEW_PAGE, configurable: true },
  { id: SHORTCUT_IDS.SETTINGS, description: 'Open Settings', key: ',', modifiers: { ctrl: true }, context: 'global', commandId: COMMAND_IDS.SETTINGS, configurable: true },
  { id: SHORTCUT_IDS.ADD_PROPERTY, description: 'Add Property', key: 'p', modifiers: { ctrl: true, alt: true }, context: 'global', commandId: COMMAND_IDS.ADD_PROPERTY, configurable: true },
  { id: SHORTCUT_IDS.IMPORT_DATA, description: 'Import Data', key: 'I', modifiers: { ctrl: true, shift: true }, context: 'global', commandId: COMMAND_IDS.IMPORT_DATA, configurable: true },
  { id: SHORTCUT_IDS.UNDO, description: 'Undo', key: 'z', modifiers: { ctrl: true }, context: 'global', commandId: COMMAND_IDS.UNDO, priority: -1 },
  { id: SHORTCUT_IDS.REDO, description: 'Redo', key: 'y', modifiers: { ctrl: true }, context: 'global', commandId: COMMAND_IDS.REDO, priority: -1 },
  { id: SHORTCUT_IDS.REDO_ALT, description: 'Redo', key: 'z', modifiers: { ctrl: true, shift: true }, context: 'global', commandId: COMMAND_IDS.REDO_ALT, priority: -1 },
  { id: SHORTCUT_IDS.TOGGLE_FOCUS_MODE, description: 'Toggle Focus Mode', key: 'f', modifiers: { ctrl: true, shift: true }, context: 'global', commandId: COMMAND_IDS.TOGGLE_FOCUS_MODE, configurable: true },

  // Editor shortcuts
  { id: SHORTCUT_IDS.BOLD, description: 'Bold', key: 'b', modifiers: { ctrl: true }, context: 'editor', commandId: COMMAND_IDS.BOLD, priority: 10, configurable: true },
  { id: SHORTCUT_IDS.ITALIC, description: 'Italic', key: 'i', modifiers: { ctrl: true }, context: 'editor', commandId: COMMAND_IDS.ITALIC, priority: 10, configurable: true },
  { id: SHORTCUT_IDS.UNDERLINE, description: 'Underline', key: 'u', modifiers: { ctrl: true }, context: 'editor', commandId: COMMAND_IDS.UNDERLINE, priority: 10, configurable: true },
  { id: SHORTCUT_IDS.STRIKETHROUGH, description: 'Strikethrough', key: 's', modifiers: { ctrl: true, shift: true }, context: 'editor', commandId: COMMAND_IDS.STRIKETHROUGH, priority: 10, configurable: true },
  { id: SHORTCUT_IDS.CODE, description: 'Inline Code', key: 'e', modifiers: { ctrl: true }, context: 'editor', commandId: COMMAND_IDS.CODE, priority: 10, configurable: true },
  { id: SHORTCUT_IDS.LINK, description: 'Insert Link', key: 'k', modifiers: { ctrl: true }, context: 'editor', commandId: COMMAND_IDS.LINK, priority: 20, configurable: true },
  { id: SHORTCUT_IDS.FIND, description: 'Find in Page', key: 'f', modifiers: { ctrl: true }, context: 'editor', commandId: COMMAND_IDS.FIND, priority: 20, configurable: true },
  { id: SHORTCUT_IDS.FIND_TOGGLE_REPLACE, description: 'Toggle Replace', key: 'h', modifiers: { ctrl: true }, context: 'editor', commandId: COMMAND_IDS.FIND_TOGGLE_REPLACE, priority: 20 },
  { id: SHORTCUT_IDS.INDENT, description: 'Indent Block', key: 'Tab', modifiers: {}, context: 'editor', commandId: COMMAND_IDS.INDENT },
  { id: SHORTCUT_IDS.OUTDENT, description: 'Outdent Block', key: 'Tab', modifiers: { shift: true }, context: 'editor', commandId: COMMAND_IDS.OUTDENT },
  { id: SHORTCUT_IDS.MOVE_UP, description: 'Move Block Up', key: 'ArrowUp', modifiers: { alt: true, shift: true }, context: 'editor', commandId: COMMAND_IDS.MOVE_UP, configurable: true },
  { id: SHORTCUT_IDS.MOVE_DOWN, description: 'Move Block Down', key: 'ArrowDown', modifiers: { alt: true, shift: true }, context: 'editor', commandId: COMMAND_IDS.MOVE_DOWN, configurable: true },
  { id: SHORTCUT_IDS.TOGGLE_FOLD, description: 'Toggle Fold Block', key: '.', modifiers: { ctrl: true }, context: 'editor', commandId: COMMAND_IDS.TOGGLE_FOLD, configurable: true },
  { id: SHORTCUT_IDS.TOGGLE_FOLD_ALT_LEFT, description: 'Toggle Fold Block (Alt + Left)', key: 'ArrowLeft', modifiers: { alt: true }, context: 'editor', commandId: COMMAND_IDS.TOGGLE_FOLD, configurable: true },
  { id: SHORTCUT_IDS.TOGGLE_FOLD_ALT_RIGHT, description: 'Toggle Fold Block (Alt + Right)', key: 'ArrowRight', modifiers: { alt: true }, context: 'editor', commandId: COMMAND_IDS.TOGGLE_FOLD, configurable: true },

  // Selection shortcuts
  { id: SHORTCUT_IDS.SELECT_ALL, description: 'Select All Blocks', key: 'a', modifiers: { ctrl: true }, context: 'selection', commandId: COMMAND_IDS.SELECT_ALL },
  { id: SHORTCUT_IDS.SELECT_UP, description: 'Extend Selection Up', key: 'ArrowUp', modifiers: { shift: true }, context: 'selection', commandId: COMMAND_IDS.SELECT_UP },
  { id: SHORTCUT_IDS.SELECT_DOWN, description: 'Extend Selection Down', key: 'ArrowDown', modifiers: { shift: true }, context: 'selection', commandId: COMMAND_IDS.SELECT_DOWN },
  { id: SHORTCUT_IDS.DELETE_SELECTED, description: 'Delete Selected Blocks', key: 'Delete', modifiers: {}, context: 'selection', commandId: COMMAND_IDS.DELETE_SELECTED },
  { id: SHORTCUT_IDS.COPY, description: 'Copy', key: 'c', modifiers: { ctrl: true }, context: 'selection', commandId: COMMAND_IDS.COPY },
  { id: SHORTCUT_IDS.CUT, description: 'Cut', key: 'x', modifiers: { ctrl: true }, context: 'selection', commandId: COMMAND_IDS.CUT },
  { id: SHORTCUT_IDS.PASTE, description: 'Paste', key: 'v', modifiers: { ctrl: true }, context: 'selection', commandId: COMMAND_IDS.PASTE },

  // Navigation
  { id: SHORTCUT_IDS.NAV_UP, description: 'Navigate Up', key: 'ArrowUp', modifiers: {}, context: 'editor', commandId: COMMAND_IDS.NAV_UP },
  { id: SHORTCUT_IDS.NAV_DOWN, description: 'Navigate Down', key: 'ArrowDown', modifiers: {}, context: 'editor', commandId: COMMAND_IDS.NAV_DOWN },
  { id: SHORTCUT_IDS.ESCAPE, description: 'Exit/Cancel', key: 'Escape', modifiers: {}, context: 'global', commandId: COMMAND_IDS.ESCAPE },
];

/**
 * Registered shortcut handler (legacy — prefer command registry)
 */
interface RegisteredHandler {
  shortcutId: string;
  handler: () => void | boolean;
  priority: number;
}

interface KeyboardState {
  /** User-customized shortcuts (merged with defaults) */
  customShortcuts: Record<string, Partial<ShortcutDefinition>>;

  /** Currently active contexts */
  activeContexts: Set<ShortcutContext>;

  /** Registered legacy handlers */
  handlers: Map<string, RegisteredHandler[]>;

  /** Whether shortcuts are globally disabled */
  disabled: boolean;

  // Actions
  setCustomShortcut: (id: string, shortcut: Partial<ShortcutDefinition>) => void;
  resetShortcut: (id: string) => void;
  resetAllShortcuts: () => void;

  activateContext: (context: ShortcutContext) => void;
  deactivateContext: (context: ShortcutContext) => void;

  /** Legacy handler registration — prefer command registry for new code */
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

  const ctrlMatch = shortcut.modifiers.ctrl
    ? (isMac ? event.metaKey : event.ctrlKey)
    : !(isMac ? event.metaKey : event.ctrlKey);
  const shiftMatch = shortcut.modifiers.shift ? event.shiftKey : !event.shiftKey;
  const altMatch = shortcut.modifiers.alt ? event.altKey : !event.altKey;
  const metaMatch = shortcut.modifiers.meta ? event.metaKey : true;

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
        const newHandlers = [...existing, newHandler].sort((a, b) => b.priority - a.priority);
        handlers.set(shortcutId, newHandlers);
        set({ handlers: new Map(handlers) });
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
        return custom ? { ...defaultShortcut, ...custom } as ShortcutDefinition : defaultShortcut;
      },

      getAllShortcuts: () => {
        const custom = get().customShortcuts;
        return DEFAULT_SHORTCUTS.map(s => ({
          ...s,
          ...custom[s.id],
        })) as ShortcutDefinition[];
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
 * Process a keyboard event against registered shortcuts.
 *
 * Priority:
 * 1. Try command registry first (new architecture)
 * 2. Fall back to legacy handlers
 *
 * Always calls preventDefault() + stopPropagation() when a shortcut matches,
 * so the browser never sees claimed shortcuts like Ctrl+F, Ctrl+K, etc.
 */
export function processKeyboardEvent(event: KeyboardEvent): boolean {
  const state = useKeyboardStore.getState();

  if (state.disabled) return false;

  const shortcuts = state.getAllShortcuts();
  const activeContexts = state.activeContexts;

  const matches = shortcuts
    .filter(s => activeContexts.has(s.context) && matchesShortcut(event, s))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const shortcut of matches) {
    // 1. Try command registry first
    const commandResult = useCommandRegistry.getState().executeCommand(shortcut.commandId);
    if (commandResult) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    // 2. Fall back to legacy handlers
    const handlers = state.handlers.get(shortcut.id) || [];
    for (const { handler } of handlers) {
      const result = handler();
      if (result !== false) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
    }
  }

  return false;
}
