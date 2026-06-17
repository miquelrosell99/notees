import { listClasses } from '@/api/nodes';
import { nodeNameToText } from '@/features/queries/hooks/useStringifyAST';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import type { QueryClient } from '@tanstack/react-query';
import type { LogseqExport } from '@/utils/ednParser';
import type { TaskReportData } from '@/components/ui/TaskReport';
import type { ImportMode, NodeInfo, PhaseResult, ImportContext } from './useLogseqImporter.types';
import { countBlocks } from './useLogseqImporter.utils';
import { runPhase1 } from './useLogseqImporter.phase1';
import { runPhase2 } from './useLogseqImporter.phase2';
import { runPhase3a } from './useLogseqImporter.phase3a';
import { runPhase3b } from './useLogseqImporter.phase3b';
import { runPhase3c } from './useLogseqImporter.phase3c';
import { runPhase4 } from './useLogseqImporter.phase4';
import { runPhase6 } from './useLogseqImporter.phase6';
import { runPhase7 } from './useLogseqImporter.phase7';

interface RunImportDeps {
  pageClassId: number;
  classClassId: number | null;
  mutations: {
    createNode: { mutateAsync: (...args: any[]) => Promise<{ id: number; uuid: string }> };
    updateNode: { mutateAsync: (...args: any[]) => Promise<{ id: number; uuid: string }> };
    createProperty: { mutateAsync: (...args: any[]) => Promise<unknown> };
  };
  queryClient: QueryClient;
  callbacks: {
    setImporting: (b: boolean) => void;
    setImportStatus: (s: string) => void;
    setImportProgress: (n: number) => void;
    setReport: (r: TaskReportData | null) => void;
    setError: (e: string | null) => void;
  };
}

export async function runImport(
  parsed: LogseqExport,
  options: { importMode: ImportMode; uuidOverrides?: Record<string, string> },
  deps: RunImportDeps,
): Promise<void> {
  const { setImporting, setImportStatus, setImportProgress, setReport, setError } = deps.callbacks;

  setImporting(true);
  setReport(null);
  setImportProgress(0);
  setError(null);

  const override = options.importMode === 'override';
  const phases: PhaseResult[] = [];

  // Progress tracking
  const classExtends = parsed.classes.filter(c => c.extends).length;
  const propBindings = parsed.classes.reduce((s, c) => s + (c.properties?.length ?? 0), 0);
  const pagesWithProps = parsed.pages.filter(p => p.properties && Object.keys(p.properties).length > 0).length;
  const pagesWithAliases = parsed.pages.filter(p => (p.aliases && p.aliases.length > 0) || (p.aliasOfUuids && p.aliasOfUuids.length > 0)).length;
  const totalBlocks = parsed.pages.reduce((s, p) => s + countBlocks(p.blocks), 0)
    + (parsed.standaloneBlocks ? countBlocks(parsed.standaloneBlocks) : 0);
  const regularPagesCount = parsed.pages.filter(p => !p.journal).length;
  const estimatedTotal = Math.max(1,
    parsed.classes.length + classExtends + parsed.properties.length
    + parsed.pages.length + propBindings + pagesWithProps
    + totalBlocks + pagesWithAliases
    + totalBlocks + regularPagesCount
  );
  let completedItems = 0;
  const tick = () => {
    completedItems++;
    setImportProgress(Math.min(99, Math.round((completedItems / estimatedTotal) * 100)));
  };
  const tickN = (n: number) => {
    completedItems += n;
    setImportProgress(Math.min(99, Math.round((completedItems / estimatedTotal) * 100)));
  };

  try {
    const ctx = {
      parsed,
      options,
      override,
      uuidMap: new Map<string, NodeInfo>(),
      propIdMap: new Map<string, number>(),
      classIdMap: new Map<string, number>(),
      titleToNodeInfo: new Map<string, NodeInfo>(),
      contentQueue: [] as Array<{ id: number; title: string }>,
      existingNodeIds: new Set<number>(),
      phases,
      pageClassId: deps.pageClassId,
      classClassId: deps.classClassId,
      mutations: deps.mutations,
      queryClient: deps.queryClient,
      setImportStatus,
      setImportProgress,
      tick,
      tickN,
      textPropIds: new Set<number>(),
      existingPageMap: new Map(),
      journalStartSeqs: new Map<string, number>(),
      tempIdxToNodeInfo: new Map<number, NodeInfo>(),
      nodeIdToProperties: new Map<number, Record<number, unknown>>(),
      regularPageClasses: [] as number[][],
      flatBlocks: [] as ImportContext['flatBlocks'],
    };

    // Pre-populate classIdMap with system class mappings
    const LOGSEQ_BUILTIN_CLASS_MAP: Record<string, string> = {
      'logseq.class/Quote-block': SYSTEM_CLASS_UUIDS.quote,
      'logseq.class/Query': SYSTEM_CLASS_UUIDS.query,
      'logseq.class/Code': SYSTEM_CLASS_UUIDS.code,
      'logseq.class/Task': SYSTEM_CLASS_UUIDS.task,
      'logseq.class/Whiteboard': SYSTEM_CLASS_UUIDS.whiteboard,
      'logseq.class/Card': SYSTEM_CLASS_UUIDS.card,
      'logseq.class/Template': SYSTEM_CLASS_UUIDS.template,
      'logseq.class/Table': SYSTEM_CLASS_UUIDS.table,
      'logseq.class/Asset': SYSTEM_CLASS_UUIDS.asset,
    };
    const existingClasses = await listClasses();
    for (const [logseqKey, noteesUuid] of Object.entries(LOGSEQ_BUILTIN_CLASS_MAP)) {
      const systemClass = existingClasses.find(c => c.uuid === noteesUuid);
      if (systemClass) {
        ctx.classIdMap.set(logseqKey, systemClass.id);
        const info = { id: systemClass.id, uuid: systemClass.uuid };
        const displayName = nodeNameToText(systemClass.name);
        if (displayName) {
          ctx.titleToNodeInfo.set(displayName, info);
          ctx.titleToNodeInfo.set(displayName.toLowerCase(), info);
        }
        const lsClass = parsed.classes.find(c => c.id === logseqKey);
        if (lsClass?.uuid) ctx.uuidMap.set(lsClass.uuid, info);
      }
    }

    await runPhase1(ctx, existingClasses);
    await runPhase2(ctx);

    const p3: PhaseResult = { label: 'Create nodes', succeeded: 0, failed: 0, errors: [] };
    phases.push(p3);
    await runPhase3a(ctx, p3);
    await runPhase3b(ctx, p3);
    await runPhase3c(ctx, p3);

    await runPhase4(ctx);
    await runPhase6(ctx);
    await runPhase7(ctx);

    // Build final report
    const totalSucceeded = phases.reduce((s, p) => s + p.succeeded, 0);
    const totalFailed = phases.reduce((s, p) => s + p.failed, 0);

    deps.queryClient.invalidateQueries({ queryKey: nodeKeys.all });
    deps.queryClient.invalidateQueries({ queryKey: propertyKeys.all });
    deps.queryClient.invalidateQueries({ queryKey: propertyKeys.allNodes() });

    setReport({ phases, totalSucceeded, totalFailed });
    setImportProgress(100);
    setImportStatus('');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Import failed';
    setError(msg);
  } finally {
    setImporting(false);
  }
}
