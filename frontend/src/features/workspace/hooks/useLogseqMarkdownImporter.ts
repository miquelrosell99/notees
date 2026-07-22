/**
 * useLogseqMarkdownImporter — client-side Logseq Markdown-folder import.
 *
 * Re-implements the removed Logseq importer on top of the local-first
 * WorkspaceStore. Parses a folder of Logseq Markdown files, creates pages and
 * nested blocks, resolves [[Page]] wiki-links into node_link AST nodes, and
 * uploads referenced assets from the assets/ subfolder.
 *
 * Class/property schema mapping is intentionally skipped in this pass; only
 * page/block hierarchy, text content, links, and assets are imported.
 */
import { useCallback, useState } from 'react';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import type { Asset } from '@/features/assets/api/assets';
import { importLogseqFolderToStore } from './useLogseqMarkdownImporter.store';

export { importLogseqFolderToStore } from './useLogseqMarkdownImporter.store';

export interface ImportProgress {
  phase: 'parsing' | 'uploading-assets' | 'creating-pages' | 'creating-blocks' | 'done';
  current: number;
  total: number;
  message: string;
}

export interface LogseqImportReport {
  pagesCreated: number;
  blocksCreated: number;
  assetsUploaded: number;
  linksCreated: number;
  errors: string[];
}

export interface LogseqImportOptions {
  /** Asset upload function (defaults to the real API client, lazy-loaded). */
  uploadAsset?: (file: File, parentUuid?: string) => Promise<Asset>;
  /** Called as the import progresses. */
  onProgress?: (progress: ImportProgress) => void;
}

export interface UseLogseqMarkdownImporterResult {
  importFolder: (files: FileList) => Promise<LogseqImportReport>;
  isImporting: boolean;
  progress: ImportProgress | null;
  report: LogseqImportReport | null;
  error: string | null;
}

export function useLogseqMarkdownImporter(
  workspaceId: string | undefined,
): UseLogseqMarkdownImporterResult {
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [report, setReport] = useState<LogseqImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const importFolder = useCallback(
    async (files: FileList): Promise<LogseqImportReport> => {
      if (!client || !workspaceId) {
        throw new Error('Workspace store is not ready');
      }
      setIsImporting(true);
      setError(null);
      setReport(null);
      setProgress(null);
      try {
        const result = await importLogseqFolderToStore(client, files, {
          onProgress: setProgress,
        });
        setReport(result);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setIsImporting(false);
      }
    },
    [client, workspaceId],
  );

  return { importFolder, isImporting, progress, report, error };
}
