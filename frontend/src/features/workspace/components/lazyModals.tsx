/**
 * Lazy modal wrappers for heavy workspace modals.
 *
 * These components are tiny Suspense shells. The actual modal code is only
 * fetched when the modal is first rendered, keeping the initial bundle small.
 */
/* eslint-disable react-refresh/only-export-components */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Spinner } from '@/components/ui/Spinner';

function withSuspense<T extends object>(
  Component: LazyExoticComponent<ComponentType<T>>
): ComponentType<T> {
  return function LazyModalWrapper(props: T) {
    return (
      <Suspense fallback={<Spinner size="md" centered />}>
        <Component {...props} />
      </Suspense>
    );
  };
}

const ExportPageModalLazy = lazy(() =>
  import('./ExportPageModal').then((m) => ({ default: m.ExportPageModal }))
);
const ImportDataModalLazy = lazy(() =>
  import('./ImportDataModal').then((m) => ({ default: m.ImportDataModal }))
);
const ImportMarkdownModalLazy = lazy(() =>
  import('./ImportMarkdownModal').then((m) => ({ default: m.ImportMarkdownModal }))
);
const ImportLogseqFolderModalLazy = lazy(() =>
  import('./ImportLogseqFolderModal').then((m) => ({ default: m.ImportLogseqFolderModal }))
);
const ImportOptionsModalLazy = lazy(() =>
  import('./ImportOptionsModal').then((m) => ({ default: m.ImportOptionsModal }))
);
const AutoExportProgressModalLazy = lazy(() =>
  import('./AutoExportProgressModal').then((m) => ({ default: m.AutoExportProgressModal }))
);
const WorkspaceExportModalLazy = lazy(() =>
  import('./WorkspaceExportModal').then((m) => ({ default: m.WorkspaceExportModal }))
);

export const ExportPageModal = withSuspense(ExportPageModalLazy);
export const ImportDataModal = withSuspense(ImportDataModalLazy);
export const ImportMarkdownModal = withSuspense(ImportMarkdownModalLazy);
export const ImportLogseqFolderModal = withSuspense(ImportLogseqFolderModalLazy);
export const ImportOptionsModal = withSuspense(ImportOptionsModalLazy);
export const AutoExportProgressModal = withSuspense(AutoExportProgressModalLazy);
export const WorkspaceExportModal = withSuspense(WorkspaceExportModalLazy);
