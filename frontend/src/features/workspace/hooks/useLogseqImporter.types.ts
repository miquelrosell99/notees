import type { LogseqExport } from '@/utils/ednParser';
import type { Node } from '@/types/api';
import type { TaskReportData, TaskPhaseResult } from '@/components/ui/TaskReport';
import type { QueryClient } from '@tanstack/react-query';

export type ImportMode = 'additive' | 'override';

export type { TaskReportData as LogseqImportReport };

/** Info stored per created Notees node, keyed by Logseq UUID */
export interface NodeInfo {
  id: number;
  uuid: string;
}

export type PhaseResult = TaskPhaseResult;

export interface ImportContext {
  parsed: LogseqExport;
  options: { importMode: ImportMode; uuidOverrides?: Record<string, string> };
  override: boolean;

  uuidMap: Map<string, NodeInfo>;
  propIdMap: Map<string, number>;
  classIdMap: Map<string, number>;
  titleToNodeInfo: Map<string, NodeInfo>;
  contentQueue: Array<{ id: number; title: string }>;
  existingNodeIds: Set<number>;
  phases: PhaseResult[];

  pageClassId: number;
  classClassId: number | null;

  mutations: {
    createNode: { mutateAsync: (...args: any[]) => Promise<{ id: number; uuid: string }> };
    updateNode: { mutateAsync: (...args: any[]) => Promise<Node | null> };
    createProperty: { mutateAsync: (...args: any[]) => Promise<unknown> };
  };

  queryClient: QueryClient;

  setImportStatus: (s: string) => void;
  setImportProgress: (n: number) => void;

  tick: () => void;
  tickN: (n: number) => void;

  // Phase-local state
  textPropIds: Set<number>;
  existingPageMap: Map<string, Node>;
  journalStartSeqs: Map<string, number>;
  tempIdxToNodeInfo: Map<number, NodeInfo>;
  nodeIdToProperties: Map<number, Record<number, unknown>>;
  regularPageClasses: number[][];
  flatBlocks: Array<{
    block: { title?: string; uuid?: string; children?: unknown[]; tags?: string[] };
    classes: number[];
    parent: { kind: 'page'; title: string } | { kind: 'block'; tempIdx: number };
    sequence: number;
    tempIdx: number;
  }>;
}
