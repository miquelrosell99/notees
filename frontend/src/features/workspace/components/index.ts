/**
 * Workspace Components Index
 *
 * Workspace management components.
 */

// Heavy modals are lazy-loaded via tiny Suspense wrappers
export {
  ExportPageModal,
  ImportDataModal,
  ImportMarkdownModal,
  ImportLogseqFolderModal,
  ImportOptionsModal,
  AutoExportProgressModal,
  WorkspaceExportModal,
} from './lazyModals';

// Lightweight components remain eager
export { WorkspaceModal } from './WorkspaceModal';
export { WorkspaceNameModal } from './WorkspaceNameModal';
export { WorkspaceSwitcher } from './WorkspaceSwitcher';
export { ClassConsolidationSection } from './ClassConsolidationSection';
