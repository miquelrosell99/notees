/**
 * useLogseqImporter — shared hook that contains the full 7-phase Logseq import logic.
 *
 * Extract from ImportLogseqModal so both ImportLogseqModal (standalone use via command
 * palette) and ImportOptionsModal (workspace-creation flow) can run the same pipeline
 * without the circular dependency of one modal opening the other.
 *
 * Import flow (7 phases):
 * 1. Create classes (type nodes)
 * 2. Create properties (with correct backend field names)
 * 3. Create all nodes (pages + blocks) with UUID-only skeletons
 * 4. Bind properties to classes
 * 5. Resolve property values per node (collected into a map, merged into phase 6)
 * 6. Combined update pass: name (with [[uuid]] links resolved) + parent + sequence + classes + properties
 * 7. Assign aliases between pages
 *
 * Usage:
 *   const { importing, importStatus, importProgress, report, error, reset, runImport, pageClassId } = useLogseqImporter();
 *   await runImport(parsedExport, { importMode: 'additive' });
 */
import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateNode, useUpdateNode } from '@/features/content';
import { usePageClass, useClassClass } from '@/features/content';
import { useCreateProperty } from '@/features/properties';
import type { LogseqExport } from '@/utils/ednParser';
import type { TaskReportData } from '@/components/ui/TaskReport';
import { runImport } from './useLogseqImporter.runner';
import type { ImportMode } from './useLogseqImporter.types';

export type { ImportMode, LogseqImportReport } from './useLogseqImporter.types';
export { countBlocks } from './useLogseqImporter.utils';
export { buildAstFromLogseqText } from './useLogseqImporter.ast';

export function useLogseqImporter() {
  const queryClient = useQueryClient();
  const createNodeMutation = useCreateNode();
  const updateNodeMutation = useUpdateNode();
  const createPropertyMutation = useCreateProperty();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();

  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const [importProgress, setImportProgress] = useState(0);
  const [report, setReport] = useState<TaskReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setImporting(false);
    setImportStatus('');
    setImportProgress(0);
    setReport(null);
    setError(null);
  }, []);

  const runImportCallback = useCallback(async (
    parsed: LogseqExport,
    options: { importMode: ImportMode; uuidOverrides?: Record<string, string> },
  ) => {
    if (!parsed || !pageClassId) return;

    await runImport(parsed, options, {
      pageClassId,
      classClassId,
      mutations: {
        createNode: createNodeMutation,
        updateNode: updateNodeMutation,
        createProperty: createPropertyMutation,
      },
      queryClient,
      callbacks: {
        setImporting,
        setImportStatus,
        setImportProgress,
        setReport,
        setError,
      },
    });
  }, [createNodeMutation, updateNodeMutation, createPropertyMutation, pageClassId, classClassId, queryClient]);

  return {
    importing,
    importStatus,
    importProgress,
    report,
    error,
    reset,
    runImport: runImportCallback,
    /** null until system classes are loaded — callers should wait before calling runImport */
    pageClassId,
    classClassId,
  };
}
