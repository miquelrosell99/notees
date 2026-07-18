import type { LogseqExport } from '@/utils/ednParser';
import type { Node } from '@/types/api';
import type { TaskReportData, TaskPhaseResult } from '@/components/ui/TaskReport';
import type { QueryClient } from '@tanstack/react-query';
import type { WorkspaceStore } from '@/core/store';

export type ImportMode = 'additive' | 'override';

export type { TaskReportData as LogseqImportReport };

/** Info stored per created Notees node, keyed by Logseq UUID */
export interface NodeInfo {
  nodeUuid: string;
  uuid: string;
}

export type PhaseResult = TaskPhaseResult;

export interface ImportContext {
  parsed: LogseqExport;
  options: { importMode: ImportMode; uuidOverrides?: Record<string, string> };
  override: boolean;

  uuidMap: Map<string, NodeInfo>;
  propIdMap: Map<string, string>;
  classIdMap: Map<string, string>;
  titleToNodeInfo: Map<string, NodeInfo>;
  contentQueue: Array<{ nodeUuid: string; title: string }>;
  existingNodeIds: Set<string>;
  phases: PhaseResult[];

  pageClassUuid: string;
  classClassUuid: string | null;

  mutations: {
    createNode: { mutateAsync: (...args: any[]) => Promise<Node> };
    updateNode: { mutateAsync: (...args: any[]) => Promise<Node | null> };
    createProperty: { mutateAsync: (...args: any[]) => Promise<unknown> };
  };

  queryClient: QueryClient;
  store: WorkspaceStore;

  setImportStatus: (s: string) => void;
  setImportProgress: (n: number) => void;

  tick: () => void;
  tickN: (n: number) => void;

  // Phase-local state
  textPropIds: Set<string>;
  existingPageMap: Map<string, Node>;
  journalStartSeqs: Map<string, number>;
  tempIdxToNodeInfo: Map<number, NodeInfo>;
  nodeIdToProperties: Map<string, Record<string, unknown>>;
  regularPageClasses: string[][];
  flatBlocks: Array<{
    block: { title?: string; uuid?: string; children?: unknown[]; tags?: string[] };
    classes: string[];
    parent: { kind: 'page'; title: string } | { kind: 'block'; tempIdx: number };
    sequence: number;
    tempIdx: number;
  }>;
}
