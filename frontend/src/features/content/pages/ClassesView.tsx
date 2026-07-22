/**
 * Classes View - hub for all class definitions with view mode switching
 *
 * Uses NodeCollection directly with multiple view modes (list, document, card,
 * table, graph, timeline). Only class nodes are shown; their members are never
 * rendered in this view.
 */
import { useState, useCallback, useMemo, useContext } from 'react';
import { useParams } from 'react-router-dom';
import { useClasses } from '@/features/content';
import { useClassClass } from '@/features/content/hooks/usePageClass';
import { useContentSave } from '@/features/editor';
import { useNavigationStore } from '@/stores';
import { WorkspaceStoreContext } from '@/core/hooks/WorkspaceStoreContext';
import { getOrCreateWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { projectNode } from '@/core/adapters/nodeProjection';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '@/features/content/components/nodes/NodeCollectionToolbar';
import { NodeSearchBox } from '@/features/content/components/nodes/NodeSearchBox';
import { PageViewHeader } from '@/features/content/components/nodes/PageViewHeader';
import { Button } from '@/components/ui/Button';
import { DataStateView } from '@/components/ui/DataStateView';
import { uuidv7 } from '@/core/uuid';
import type { NodeCollectionViewMode, NodeCollectionGroupBy, SortEntry } from '@/types/nodeCollection';
import type { Node } from '@/types';
import './ClassesView.css';

const AVAILABLE_VIEW_MODES: NodeCollectionViewMode[] = [
  'list',
  'kanban',
  'table',
  'graph',
  'timeline',
];

interface ClassesViewProps {
  initialViewMode?: NodeCollectionViewMode;
}

export function ClassesView({ initialViewMode }: ClassesViewProps) {
  const openNode = useNavigationStore((state) => state.openNode);
  const { handleContentChange: saveContent } = useContentSave();
  const { data: classes, isLoading, error } = useClasses();
  const { classClassUuid } = useClassClass();
  const ctx = useContext(WorkspaceStoreContext);
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>(initialViewMode ?? 'list');

  // Transient filter state for Classes — resets on page reload
  const [groupBy, setGroupBy] = useState<NodeCollectionGroupBy>('none');
  const [sortColumns, setSortColumns] = useState<SortEntry[]>([{ key: 'name', direction: 'asc' }]);
  const [selectedPropertyUuids, setSelectedPropertyUuids] = useState<string[]>([]);
  const [cardLayout, setCardLayout] = useState<'no-cover' | 'cover-top' | 'cover-left' | 'cover-right'>('no-cover');

  const handleViewModeChange = useCallback((mode: NodeCollectionViewMode) => {
    setViewMode(mode);
  }, []);

  // All classes view modes operate on a flat list of class nodes only.
  // Strip children so member nodes are never rendered here.
  const displayNodes = useMemo<Node[]>(() => {
    if (!classes) return [];
    const seen = new Set<string>();
    const result: Node[] = [];
    for (const n of classes) {
      if (!n.is_class || seen.has(n.uuid)) continue;
      seen.add(n.uuid);
      result.push({ ...n, children: undefined, has_children: false });
    }
    return result;
  }, [classes]);

  const handleCreateClass = useCallback(async () => {
    if (!ctx || !workspaceId) return;
    const store = await getOrCreateWorkspaceStore(workspaceId, ctx.actorId, ctx.transport);
    const classId = uuidv7();
    store.createNode({
      nodeId: classId,
      kind: 'class',
      parentId: null,
      classIds: classClassUuid ? [classClassUuid] : [],
    });
    store.updateText(classId, (text) => {
      const current = text.toPlaintext();
      text.delete(0, current.length);
      text.insert(0, 'New class');
    });
    const projected = projectNode(store, classId);
    if (projected) {
      openNode(projected.uuid);
    }
  }, [ctx, workspaceId, classClassUuid, openNode]);

  const handleSearchSelect = useCallback((node: Node) => {
    openNode(node.uuid);
  }, [openNode]);

  return (
    <article className={`node-view node-view--page classes-view classes-view--${viewMode}`}>
      <PageViewHeader
        className="classes-view__header"
        title={<h1>Classes</h1>}
        middle={
          viewMode !== 'graph' && viewMode !== 'timeline' ? (
            <NodeSearchBox
              placeholder="Search classes..."
              onSelect={handleSearchSelect}
            />
          ) : undefined
        }
        actions={
          <>
            <NodeCollectionToolbar
              viewMode={viewMode}
              availableViewModes={AVAILABLE_VIEW_MODES}
              onViewModeChange={handleViewModeChange}
              hideToolbarControls={false}
              isTransient={true}
              showGroupBy={true}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              sortColumns={sortColumns}
              onSortChange={setSortColumns}
              selectedPropertyUuids={selectedPropertyUuids}
              onPropertyColumnsChange={setSelectedPropertyUuids}
              cardLayout={cardLayout}
              onCardLayoutChange={setCardLayout}
            />
            <Button
              variant="primary"
              size="sm"
              icon={"mdi mdi-plus"}
              iconSize={0.9}
              onClick={handleCreateClass}
              title="New class"
            >
              New class
            </Button>
          </>
        }
      />

      {/* Content */}
      <div className="classes-view__content">
        <DataStateView
          isLoading={isLoading}
          error={error}
          isEmpty={displayNodes.length === 0}
          onRetry={() => { /* useClasses is store-backed; no refetch needed */ }}
          emptyTitle="No classes yet"
          emptyDescription="Create your first class to define reusable types and properties."
          emptyAction={{ label: 'Create class', onClick: handleCreateClass }}
          skeletonRows={4}
        >
          <NodeCollection
            nodes={displayNodes}
            viewMode={viewMode}
            availableViewModes={AVAILABLE_VIEW_MODES}
            onViewModeChange={handleViewModeChange}
            pagesOnly={false}
            hideProperties={true}
            showBreadcrumbs={false}
            hideToolbar={true}
            editable={true}
            onContentChange={saveContent}
            onNodeClick={(node) => openNode(node.uuid)}
            showClasses={true}
            showEmpty={true}
            emptyMessage="Create a class to get started"
            expandAll={true}
            className="classes-view__node-collection"
            isTransient={true}
            showGroupBy={true}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            sort={sortColumns}
            onSortChange={setSortColumns}
            selectedPropertyUuids={selectedPropertyUuids}
            onPropertyColumnsChange={setSelectedPropertyUuids}
            cardLayout={cardLayout}
            onCardLayoutChange={setCardLayout}
            showNewBlock={false}
            maxDepth={0}
          />
        </DataStateView>
      </div>
    </article>
  );
}

export default ClassesView;
