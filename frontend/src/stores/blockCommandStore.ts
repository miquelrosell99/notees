/**
 * Block Command Store - Command Pattern for Block Operations
 * 
 * Centralizes all block operations into discrete, undoable commands.
 * Each command encapsulates both the execution and reversal logic,
 * enabling comprehensive undo/redo support.
 * 
 * Command Pattern Benefits:
 * - Single source of truth for block operations
 * - Automatic undo/redo integration
 * - Consistent API across different trigger sources (keyboard, menu, toolbar)
 * - Easy to add new operations without modifying existing code
 * - Clear separation between UI and business logic
 */
import { create } from 'zustand';

// ============================================================================
// TYPES
// ============================================================================

/** Supported block command types */
export type BlockCommandType =
  | 'indent'
  | 'outdent'
  | 'moveUp'
  | 'moveDown'
  | 'delete'
  | 'split'
  | 'merge'
  | 'duplicate'
  | 'toggleCollapse'
  | 'toggleCheckbox'
  | 'convertToPage'
  | 'insertBlock'
  | 'updateContent'
  | 'batch';

/** Context passed to commands */
export interface CommandContext {
  /** The block ID to operate on */
  blockId: string;
  /** Optional additional block IDs for multi-selection */
  blockIds?: string[];
  /** Parent page/node ID */
  pageId?: string;
  /** Current content (for split/merge) */
  content?: string;
  /** Cursor position (for split) */
  cursorPosition?: number;
  /** New content (for update) */
  newContent?: string;
  /** Insert position (for insertBlock) */
  insertAfter?: string;
  /** Additional command-specific data */
  data?: Record<string, unknown>;
}

/** Result of command execution */
export interface CommandResult {
  /** Whether the command succeeded */
  success: boolean;
  /** New block ID if created */
  newBlockId?: string;
  /** IDs of affected blocks */
  affectedBlockIds?: string[];
  /** Error message if failed */
  error?: string;
  /** Undo data for reversal */
  undoData?: Record<string, unknown>;
}

/** A single command instance */
export interface BlockCommand {
  /** Unique command ID */
  id: string;
  /** Command type */
  type: BlockCommandType;
  /** Context for execution */
  context: CommandContext;
  /** Timestamp of creation */
  timestamp: number;
  /** Result after execution */
  result?: CommandResult;
  /** Undo data captured during execution */
  undoData?: Record<string, unknown>;
}

/** Command handler function type */
export type CommandHandler = (context: CommandContext) => Promise<CommandResult>;

/** Undo handler function type */
export type UndoHandler = (
  context: CommandContext,
  undoData: Record<string, unknown>
) => Promise<CommandResult>;

/** Command definition */
export interface CommandDefinition {
  type: BlockCommandType;
  execute: CommandHandler;
  undo: UndoHandler;
  /** Human-readable description */
  description: string;
  /** Keyboard shortcut display */
  shortcutKey?: string;
}

// ============================================================================
// STORE
// ============================================================================

interface BlockCommandState {
  /** Registry of command handlers */
  commandRegistry: Map<BlockCommandType, CommandDefinition>;
  
  /** Command history for undo */
  history: BlockCommand[];
  /** Redo stack */
  redoStack: BlockCommand[];
  /** Maximum history size */
  maxHistorySize: number;
  
  /** Currently executing command */
  executingCommand: BlockCommand | null;
  
  /** Register a command handler */
  registerCommand: (definition: CommandDefinition) => void;
  
  /** Execute a command */
  execute: (type: BlockCommandType, context: CommandContext) => Promise<CommandResult>;
  
  /** Execute a batch of commands as a single undoable unit */
  executeBatch: (commands: Array<{ type: BlockCommandType; context: CommandContext }>) => Promise<CommandResult>;
  
  /** Undo the last command */
  undo: () => Promise<boolean>;
  
  /** Redo the last undone command */
  redo: () => Promise<boolean>;
  
  /** Check if undo is available */
  canUndo: () => boolean;
  
  /** Check if redo is available */
  canRedo: () => boolean;
  
  /** Clear history */
  clearHistory: () => void;
  
  /** Get command by type */
  getCommand: (type: BlockCommandType) => CommandDefinition | undefined;
}

export const useBlockCommandStore = create<BlockCommandState>((set, get) => ({
  commandRegistry: new Map(),
  history: [],
  redoStack: [],
  maxHistorySize: 100,
  executingCommand: null,
  
  registerCommand: (definition) => {
    set((state) => {
      const newRegistry = new Map(state.commandRegistry);
      newRegistry.set(definition.type, definition);
      return { commandRegistry: newRegistry };
    });
  },
  
  execute: async (type, context) => {
    const { commandRegistry, history, maxHistorySize } = get();
    const definition = commandRegistry.get(type);
    
    if (!definition) {
      console.warn(`[BlockCommand] Unknown command type: ${type}`);
      return { success: false, error: `Unknown command: ${type}` };
    }
    
    // Create command instance
    const command: BlockCommand = {
      id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      context,
      timestamp: Date.now(),
    };
    
    set({ executingCommand: command });
    
    try {
      // Execute the command
      const result = await definition.execute(context);
      
      // Update command with result
      command.result = result;
      command.undoData = result.undoData;
      
      if (result.success) {
        // Add to history (trim if needed)
        const newHistory = [...history, command];
        if (newHistory.length > maxHistorySize) {
          newHistory.shift();
        }
        
        set({
          history: newHistory,
          redoStack: [], // Clear redo on new command
          executingCommand: null,
        });
      } else {
        set({ executingCommand: null });
      }
      
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[BlockCommand] Error executing ${type}:`, error);
      set({ executingCommand: null });
      return { success: false, error: errorMessage };
    }
  },
  
  executeBatch: async (commands) => {
    if (commands.length === 0) {
      return { success: true };
    }
    
    const results: CommandResult[] = [];
    const undoData: Record<string, unknown>[] = [];
    
    for (const { type, context } of commands) {
      const result = await get().execute(type, context);
      results.push(result);
      
      if (!result.success) {
        // If any command fails, attempt to undo previous commands
        for (let i = undoData.length - 1; i >= 0; i--) {
          await get().undo();
        }
        return { success: false, error: result.error };
      }
      
      if (result.undoData) {
        undoData.push(result.undoData);
      }
    }
    
    return {
      success: true,
      affectedBlockIds: results.flatMap(r => r.affectedBlockIds || []),
      undoData: { batchData: undoData },
    };
  },
  
  undo: async () => {
    const { history, redoStack, commandRegistry } = get();
    
    if (history.length === 0) {
      return false;
    }
    
    const command = history[history.length - 1];
    const definition = commandRegistry.get(command.type);
    
    if (!definition || !command.undoData) {
      console.warn(`[BlockCommand] Cannot undo command: ${command.type}`);
      return false;
    }
    
    try {
      const result = await definition.undo(command.context, command.undoData);
      
      if (result.success) {
        set({
          history: history.slice(0, -1),
          redoStack: [...redoStack, command],
        });
        return true;
      }
      
      return false;
    } catch (error) {
      console.error(`[BlockCommand] Error undoing ${command.type}:`, error);
      return false;
    }
  },
  
  redo: async () => {
    const { redoStack, commandRegistry, history, maxHistorySize } = get();
    
    if (redoStack.length === 0) {
      return false;
    }
    
    const command = redoStack[redoStack.length - 1];
    const definition = commandRegistry.get(command.type);
    
    if (!definition) {
      return false;
    }
    
    try {
      const result = await definition.execute(command.context);
      
      if (result.success) {
        // Update command with new result
        const updatedCommand: BlockCommand = {
          ...command,
          result,
          undoData: result.undoData,
        };
        
        const newHistory = [...history, updatedCommand];
        if (newHistory.length > maxHistorySize) {
          newHistory.shift();
        }
        
        set({
          history: newHistory,
          redoStack: redoStack.slice(0, -1),
        });
        return true;
      }
      
      return false;
    } catch (error) {
      console.error(`[BlockCommand] Error redoing ${command.type}:`, error);
      return false;
    }
  },
  
  canUndo: () => get().history.length > 0,
  
  canRedo: () => get().redoStack.length > 0,
  
  clearHistory: () => set({ history: [], redoStack: [] }),
  
  getCommand: (type) => get().commandRegistry.get(type),
}));

// ============================================================================
// CONVENIENCE HOOKS
// ============================================================================

/**
 * Hook for executing block commands
 */
export function useBlockCommands() {
  const execute = useBlockCommandStore((state) => state.execute);
  const executeBatch = useBlockCommandStore((state) => state.executeBatch);
  const undo = useBlockCommandStore((state) => state.undo);
  const redo = useBlockCommandStore((state) => state.redo);
  const canUndo = useBlockCommandStore((state) => state.canUndo);
  const canRedo = useBlockCommandStore((state) => state.canRedo);
  
  return {
    execute,
    executeBatch,
    undo,
    redo,
    canUndo: canUndo(),
    canRedo: canRedo(),
    
    // Convenience methods for common operations
    indent: (blockId: string) => execute('indent', { blockId }),
    outdent: (blockId: string) => execute('outdent', { blockId }),
    moveUp: (blockId: string) => execute('moveUp', { blockId }),
    moveDown: (blockId: string) => execute('moveDown', { blockId }),
    deleteBlock: (blockId: string) => execute('delete', { blockId }),
    duplicate: (blockId: string) => execute('duplicate', { blockId }),
    toggleCollapse: (blockId: string) => execute('toggleCollapse', { blockId }),
    
    split: (blockId: string, content: string, cursorPosition: number) =>
      execute('split', { blockId, content, cursorPosition }),
    
    merge: (blockId: string) => execute('merge', { blockId }),
    
    updateContent: (blockId: string, newContent: string) =>
      execute('updateContent', { blockId, newContent }),
    
    insertBlock: (afterBlockId: string, pageId: string, content?: string) =>
      execute('insertBlock', {
        blockId: '', // Will be generated
        insertAfter: afterBlockId,
        pageId,
        content,
      }),
  };
}

/**
 * Hook for registering command handlers
 * 
 * Usage:
 * ```tsx
 * useRegisterBlockCommands({
 *   indent: {
 *     execute: async (ctx) => { ... },
 *     undo: async (ctx, undoData) => { ... },
 *     description: 'Indent block',
 *   },
 * });
 * ```
 */
export function useRegisterBlockCommands(
  commands: Partial<Record<BlockCommandType, Omit<CommandDefinition, 'type'>>>
) {
  const registerCommand = useBlockCommandStore((state) => state.registerCommand);
  
  // Register on mount
  Object.entries(commands).forEach(([type, definition]) => {
    if (definition) {
      registerCommand({
        type: type as BlockCommandType,
        ...definition,
      });
    }
  });
}

export default useBlockCommandStore;
