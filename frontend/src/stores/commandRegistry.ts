/**
 * Command Registry — Centralized action/command system.
 *
 * Every user-facing action is a command with a stable ID.
 * Keyboard shortcuts, toolbar buttons, context menus, and the command palette
 * all route through this registry.
 *
 * Architecture:
 *   CommandRegistry: Map<commandId, Command>
 *   KeyboardStore:   Map<shortcutId, commandId>
 *   CommandPalette:  reads commands from registry
 *
 * Commands are self-registering — components call registerCommand() in a
 * useEffect and unregister on unmount.  This keeps command logic co-located
 * with the components that own the state/effects, while keeping the
 * *dispatch* path centralized.
 */

import { create } from 'zustand';

/**
 * Contexts for shortcut activation.
 * Defined here (not in keyboardStore) to break a circular dependency:
 * commandRegistry → keyboardStore (for ShortcutContext)
 * keyboardStore → commandRegistry (for COMMAND_IDS)
 */
export type ShortcutContext =
  | 'global'        // Always active
  | 'editor'        // Active when editing a block
  | 'selection'     // Active when blocks are selected
  | 'modal'         // Active when a modal is open
  | 'sidebar'       // Active when sidebar is focused
  | 'search';       // Active when search is focused

export type PaletteCommandCategory =
  | 'navigation'
  | 'view'
  | 'page'
  | 'tools'
  | 'import-export'
  | 'developer';

export interface PaletteCommandMeta {
  /** Display category used for sorting/grouping in the command palette */
  category?: PaletteCommandCategory;
  /** Whether the command appears in the command palette (default true if palette is provided) */
  visible?: boolean;
  /** Optional extra search keywords */
  keywords?: string[];
}

export interface Command {
  /** Unique identifier (e.g. 'commandPalette.open', 'page.find') */
  id: string;
  /** Human-readable label shown in Command Palette */
  label: string;
  /** Optional icon name for Command Palette */
  icon?: string;
  /** Whether this command appears only when dev mode is on */
  devOnly?: boolean;
  /** Whether this command requires an active page node */
  requiresPage?: boolean;
  /** Context where this command is active */
  context: ShortcutContext;
  /** The function to run when the command is invoked */
  execute: () => void | boolean | Promise<void> | Promise<boolean>;
  /** Palette-specific metadata; presence indicates the command should appear in the palette */
  palette?: PaletteCommandMeta;
}

interface CommandRegistryState {
  /** All registered commands */
  commands: Map<string, Command>;

  /** Register a command. Overwrites existing command with same id. */
  registerCommand: (command: Command) => void;

  /** Unregister a command by id */
  unregisterCommand: (id: string) => void;

  /** Execute a command by id. Returns true if consumed. */
  executeCommand: (id: string) => boolean;

  /** Get a command by id */
  getCommand: (id: string) => Command | undefined;

  /** Get all registered commands */
  getAllCommands: () => Command[];

  /** Get commands filtered by context */
  getCommandsByContext: (context: ShortcutContext) => Command[];

  /** Get commands that should appear in the command palette */
  getPaletteCommands: () => Command[];
}

export const useCommandRegistry = create<CommandRegistryState>((set, get) => ({
  commands: new Map(),

  registerCommand: (command) => {
    set((state) => {
      const next = new Map(state.commands);
      next.set(command.id, command);
      return { commands: next };
    });
  },

  unregisterCommand: (id) => {
    set((state) => {
      const next = new Map(state.commands);
      next.delete(id);
      return { commands: next };
    });
  },

  executeCommand: (id) => {
    const command = get().commands.get(id);
    if (!command) return false;
    const result = command.execute();
    return result !== false;
  },

  getCommand: (id) => get().commands.get(id),

  getAllCommands: () => Array.from(get().commands.values()),

  getCommandsByContext: (context) =>
    Array.from(get().commands.values()).filter((c) => c.context === context),

  getPaletteCommands: () =>
    Array.from(get().commands.values()).filter((c) => c.palette && c.palette.visible !== false),
}));

/**
 * Stable command IDs used across the app.
 * Keep this in sync with the commands you register.
 */
export const COMMAND_IDS = {
  // Global
  COMMAND_PALETTE: 'commandPalette.open',
  QUICK_ADD: 'quickAdd.toggle',
  GO_TODAY: 'nav.goToday',
  NEW_PAGE: 'page.new',
  SETTINGS: 'settings.open',
  PLUGIN_MANAGER: 'plugins.openManager',
  ADD_PROPERTY: 'property.add',
  UNDO: 'edit.undo',
  REDO: 'edit.redo',
  REDO_ALT: 'edit.redoAlt',
  TOGGLE_SIDEBAR: 'sidebar.toggle',
  IMPORT_DATA: 'data.import',

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
  TASK_CYCLE: 'editor.taskCycle',

  // Page / Node
  SHARE_PAGE: 'page.share',
  EXPORT_PAGE: 'page.export',
  TOGGLE_PRIVATE: 'page.togglePrivate',
  START_PRESENTATION: 'page.present',
  TOGGLE_FOCUS_MODE: 'ui.focusMode',
  TOGGLE_FOLD: 'ui.toggleFold',
  TOGGLE_WIDE_MODE: 'ui.wideMode',
  TOGGLE_MINIMAP: 'ui.minimap',
  TOGGLE_LOCAL_GRAPH: 'ui.localGraph',

  // Navigation / Selection
  NAV_UP: 'nav.up',
  NAV_DOWN: 'nav.down',
  ESCAPE: 'nav.escape',
  SELECT_ALL: 'selection.selectAll',
  SELECT_UP: 'selection.selectUp',
  SELECT_DOWN: 'selection.selectDown',
  DELETE_SELECTED: 'selection.delete',
  COPY: 'selection.copy',
  CUT: 'selection.cut',
  PASTE: 'selection.paste',

  // Commands (command palette actions)
  IMPORT_LOGSEQ: 'data.importLogseq',
  IMPORT_LOGSEQ_FOLDER: 'data.importLogseqFolder',
  IMPORT_MARKDOWN: 'data.importMarkdown',
  REBUILD_LINKS: 'data.rebuildLinks',
  FIX_RAW_LINKS: 'data.fixRawLinks',
  MERGE_PAGES: 'page.merge',
  CREATE_PAGE_WITH_UUID: 'page.createWithUuid',
  RESET_VIEWS: 'page.resetViews',
  OPEN_RANDOM_PAGE: 'nav.randomPage',
  OPEN_BROKEN_LINKS: 'nav.brokenLinks',
  OPEN_TASKS: 'nav.tasks',
  OPEN_TODAY: 'nav.today',
  CAPTURE_TASK: 'task.capture',
  FORCE_REEXPORT: 'data.forceReexport',

  // View navigation (command palette)
  OPEN_JOURNALS: 'view.journals',
  OPEN_TASKS_VIEW: 'view.tasks',
  OPEN_ALL_PAGES: 'view.allPages',
  OPEN_PAGES: 'view.pages',
} as const;

/** Module-level command registration (useful for static/feature registrations). */
export function registerCommand(command: Command): () => void {
  useCommandRegistry.getState().registerCommand(command);
  return () => useCommandRegistry.getState().unregisterCommand(command.id);
}

/** Module-level command unregistration. */
export function unregisterCommand(id: string): void {
  useCommandRegistry.getState().unregisterCommand(id);
}
