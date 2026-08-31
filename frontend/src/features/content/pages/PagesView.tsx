/**
 * Pages View - hub for all pages with view mode switching
 *
 * Uses NodeCollection directly with multiple view modes (list, document, card,
 * table, graph, timeline). Only page nodes are shown; child blocks are never
 * rendered in this view.
 */
import { useState, useCallback, useMemo } from 'react';
import { usePages } from '@/features/content';
import { useContentSave } from '@/features/editor';
import { useNavigationStore, useModalStore } from '@/stores';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '@/features/content/components/nodes/NodeCollectionToolbar';
import { NodeSearchBox } from '@/features/content/components/nodes/NodeSearchBox';
import { PageViewHeader } from '@/features/content/components/nodes/PageViewHeader';
import { Button } from '@/components/ui/Button';
import { DataStateView } from '@/components/ui/DataStateView';
import { useSystemClasses } from '@/features/content/hooks/usePageClass';
import { filterOutCollectionPages } from '@/features/content/utils/collectionContents';
import type { NodeCollectionViewMode, NodeCollectionGroupBy, SortEntry } from '@/types/nodeCollection';
import type { Node } from '@/types';
import './PagesView.css';

const AVAILABLE_VIEW_MODES: NodeCollectionViewMode[] = [
  'list',
  'kanban',
  'table',
  'graph',
  'timeline',
];

interface PagesViewProps {
  initialViewMode?: NodeCollectionViewMode;
}

export function PagesView({ initialViewMode }: PagesViewProps) {
  const openNode = useNavigationStore((state) => state.openNode);
  const setCommandPaletteOpen = useModalStore((state) => state.setCommandPaletteOpen);
  const { handleContentChange: saveContent } = useContentSave();

  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>(initialViewMode ?? 'list');

  // Transient filter state for All Pages — resets on page reload
  const [groupBy, setGroupBy] = useState<NodeCollectionGroupBy>('page');
  const [sortColumns, setSortColumns] = useState<SortEntry[]>([{ key: 'name', direction: 'asc' }]);
  const [selectedPropertyUuids, setSelectedPropertyUuids] = useState<string[]>([]);
  const [cardLayout, setCardLayout] = useState<'no-cover' | 'cover-top' | 'cover-left' | 'cover-right'>('no-cover');

  const handleViewModeChange = useCallback((mode: NodeCollectionViewMode) => {
    setViewMode(mode);
  }, []);

  const { data: pages, isLoading, isPlaceholderData, error, refetch } = usePages();
  const { systemClassUuids } = useSystemClasses();

  // All pages view modes operate on a flat list of page nodes only.
  // Strip children so block contents are never rendered here.
  // Collection-classed pages are managed through their own view (Decision 22)
  // and do not appear in the regular page list.
  const displayNodes = useMemo<Node[]>(() => {
    if (!pages) return [];
    const seen = new Set<string>();
    const result: Node[] = [];
    for (const n of filterOutCollectionPages(pages, systemClassUuids?.collection)) {
      if (!n.is_page || seen.has(n.uuid)) continue;
      seen.add(n.uuid);
      // Prevent any view from recursing into page contents.
      result.push({ ...n, children: undefined, has_children: false });
    }
    return result;
  }, [pages, systemClassUuids?.collection]);

  const handleSearchSelect = useCallback((node: Node) => {
    openNode(node.uuid);
  }, [openNode]);

  return (
    <article className={`node-view node-view--page pages-view pages-view--${viewMode}`}>
      <PageViewHeader
        className="pages-view__header"
        title={<h1>Pages</h1>}
        middle={
          viewMode !== 'graph' && viewMode !== 'timeline' ? (
            <NodeSearchBox
              placeholder="Search pages..."
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
              onClick={() => setCommandPaletteOpen(true)}
              title="New page (Ctrl+K)"
            >
              New page
            </Button>
          </>
        }
      />

      {/* Content */}
      <div className="pages-view__content">
        <DataStateView
          isLoading={isLoading || isPlaceholderData}
          error={error}
          isEmpty={displayNodes.length === 0}
          onRetry={refetch}
          emptyTitle="No pages yet"
          emptyDescription="Create your first page to start building your workspace."
          emptyAction={{ label: 'Create page', onClick: () => setCommandPaletteOpen(true) }}
          skeletonRows={4}
        >
          <NodeCollection
            nodes={displayNodes}
            viewMode={viewMode}
            availableViewModes={AVAILABLE_VIEW_MODES}
            onViewModeChange={handleViewModeChange}
            pagesOnly={true}
            hideProperties={true}
            showBreadcrumbs={false}
            hideToolbar={true}
            editable={true}
            onContentChange={saveContent}
            onNodeClick={(node) => openNode(node.uuid)}
            showClasses={true}
            showEmpty={true}
            emptyMessage="Create a page to get started"
            expandAll={true}
            className="pages-view__node-collection"
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

export default PagesView;

