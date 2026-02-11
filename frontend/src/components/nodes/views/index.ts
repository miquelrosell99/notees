/**
 * NodeCollection Views Index
 *
 * Exports all view mode components for NodeCollection.
 * All views now use Lexical NoteesEditor internally.
 */

// Lexical-based views (primary)
export { NodeBlockListView } from './NodeBlockListView';
export { NodeBlockDocumentView } from './NodeBlockDocumentView';
export { NodeBlockCardView } from './NodeBlockCardView';
export { NodeBlockTableView } from './NodeBlockTableView';

// Gantt view (not yet migrated to Lexical)
export { NodeBlockGanttView } from './NodeBlockGanttView';
