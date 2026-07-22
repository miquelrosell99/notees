/**
 * NodeCollectionView — Temporary full-page view for query results.
 *
 * Used by the Command Palette to open ad-hoc node collections
 * (e.g. "Broken links", "Open Today", "New temporary query", or full
 * search results via Ctrl+Enter).
 *
 * Temporary means in-memory only: the query lives in the navigation store,
 * is not deep-linkable, and is gone on reload. The header shows the query
 * intent as prose and offers "Save as view…" to promote it to a stored
 * page + query block.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { QueryNodeCollection } from '@/features/content/components/nodes/QueryNodeCollection';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { useClasses } from '@/features/content';
import { useCollectionNavigation } from '@/features/layout';
import { useSaveQueryAsView } from '@/features/queries';
import { getQueryIntent } from '@/lib/astProseRenderer';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { TextField } from '@/components/ui/TextField';
import type { QueryAST } from '@/types/queryAST';
import type { Node } from '@/types/api';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import './NodeCollectionView.css';

const AVAILABLE_VIEW_MODES: NodeCollectionViewMode[] = [
  'list',
  'table',
  'kanban',
  'gantt',
  'calendar',
  'chart',
  'graph',
  'timeline',
];

interface NodeCollectionViewProps {
  title: string;
  queryAST?: QueryAST | null;
  nodeUuids?: string[] | null;
}

export function NodeCollectionView({ title, queryAST, nodeUuids }: NodeCollectionViewProps) {
  const { openNode, closeNodeCollection, addSidebarCard } = useCollectionNavigation();
  const { saveAsView, isSaving } = useSaveQueryAsView();
  const { data: allClasses } = useClasses();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading: isClientLoading } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [isSavePromptOpen, setIsSavePromptOpen] = useState(false);
  const [viewName, setViewName] = useState(title);

  // nodesMap lets the prose renderer resolve class/reference UUIDs to names.
  const nodesMap = useMemo(() => {
    const map = new Map<string, Node>();
    (allClasses ?? []).forEach((cls) => map.set(cls.uuid, cls));
    return map;
  }, [allClasses]);

  const intentProse = useMemo(
    () => (queryAST ? getQueryIntent(queryAST, nodesMap) : null),
    [queryAST, nodesMap],
  );

  // nodeUuids mode (e.g. Ctrl+Enter search results): resolve UUIDs to nodes.
  const nodeResults = useQueries({
    queries: (nodeUuids ?? []).map((uuid) => ({
      queryKey: nodeKeys.detail(uuid),
      queryFn: async () => {
        if (!client) throw new Error('Workspace store is not ready');
        const node = await client.query<Node | undefined>('getNodeByUuid', [uuid]);
        if (!node) throw new Error(`Node ${uuid} not found`);
        return node;
      },
      enabled: !!client && !isClientLoading,
    })),
  });
  const resolvedNodes = useMemo(
    () => nodeResults.map((r) => r.data).filter((n): n is Node => !!n),
    [nodeResults],
  );

  useEffect(() => {
    if (nodeUuids) {
      setResultCount(nodeUuids.length);
    }
  }, [nodeUuids]);

  const handleNodeClick = useCallback(
    (nodeUuid: string) => {
      openNode(nodeUuid);
    },
    [openNode],
  );

  const handleBlockCreated = useCallback(
    (nodeUuid: string) => {
      addSidebarCard(nodeUuid, 'block');
    },
    [addSidebarCard],
  );

  const handleSaveAsView = useCallback(() => {
    if (!queryAST || !viewName.trim()) return;
    saveAsView(viewName, queryAST)
      .then(() => setIsSavePromptOpen(false))
      .catch(() => { /* error already notified in the hook; keep the prompt open */ });
  }, [queryAST, viewName, saveAsView]);

  return (
    <article className="node-view node-view--page node-collection-view">
      {/* Header — title + close button */}
      <header className="node-collection-view__header">
        <div className="node-collection-view__heading">
          <h1 className="node-collection-view__title">
            {title}
            {resultCount !== null && resultCount > 0 && (
              <span className="node-collection-view__count"> ({resultCount})</span>
            )}
            <span className="node-collection-view__temp-chip">Temporary</span>
          </h1>
          {intentProse && (
            <p className="node-collection-view__intent">{intentProse}</p>
          )}
        </div>
        <div className="node-collection-view__actions">
          {queryAST && (
            <Button
              variant="ghost"
              size="sm"
              icon="mdi mdi-content-save-outline"
              onClick={() => { setViewName(title); setIsSavePromptOpen(true); }}
              title="Save as view"
            >
              Save as view…
            </Button>
          )}
          <Button aria-label="Close"
            variant="ghost"
            size="sm"
            icon="mdi mdi-close"
            onClick={closeNodeCollection}
            title="Close"
          />
        </div>
      </header>

      {/* Query results */}
      <div className="node-collection-view__results">
        {queryAST ? (
          <QueryNodeCollection
            nodeUuid="00000000-0000-0000-0000-000000000000"
            viewType="all_pages"
            queryAST={queryAST}
            onNodeClick={handleNodeClick}
            onBlockCreated={handleBlockCreated}
            onCountChange={setResultCount}
            hideViewManagement
            can_create={false}
            showClasses={true}
            showAddButton={false}
            showNewBlock={false}
          >
            {({ results }) => results}
          </QueryNodeCollection>
        ) : nodeUuids ? (
          <NodeCollection
            nodes={resolvedNodes}
            viewMode={viewMode}
            availableViewModes={AVAILABLE_VIEW_MODES}
            onViewModeChange={setViewMode}
            onNodeClick={(node) => openNode(node.uuid)}
            onNodeShiftClick={(node) => addSidebarCard(node.uuid, node.is_page ? 'page' : 'block')}
            showAddButton={false}
            showNewBlock={false}
          />
        ) : (
          <div className="empty-state">No results to display</div>
        )}
      </div>

      <Modal
        isOpen={isSavePromptOpen}
        onClose={() => setIsSavePromptOpen(false)}
        title="Save as view"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setIsSavePromptOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveAsView}
              disabled={isSaving || !viewName.trim()}
            >
              Save
            </Button>
          </>
        }
      >
        <TextField
          value={viewName}
          onChange={(e) => setViewName(e.target.value)}
          placeholder="View name"
          aria-label="View name"
          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAsView(); }}
        />
        <p className="node-collection-view__save-hint">
          Creates a page with this query, so it stays available after reload.
        </p>
      </Modal>
    </article>
  );
}
