/**
 * Pages View - hub for all pages with view mode switching
 *
 * Uses NodeCollection directly with multiple view modes (list, document, card,
 * table, graph, timeline). List view shows the full pages tree hierarchy.
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePages, useContentSave } from '@/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { useNavigationStore, useModalStore } from '@/stores';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '@/features/content/components/nodes/NodeCollectionToolbar';
import { SearchBox } from '@/components/ui/SearchBox';
import { Button } from '@/components/ui/Button';
import { DataStateView } from '@/components/ui/DataStateView';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
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
  const { openNode } = useNavigationStore();
  const { setCommandPaletteOpen } = useModalStore();
  const { handleContentChange: saveContent } = useContentSave();
  const queryClient = useQueryClient();

  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>(initialViewMode ?? 'list');

  const handleViewModeChange = useCallback((mode: NodeCollectionViewMode) => {
    setViewMode(mode);
  }, []);

  // Force fresh fetch of the pages tree when this view mounts.
  // The backend now returns has_children and nested children correctly,
  // but old TanStack Query cache may hold stale flat data.
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: nodeKeys.pages({ includeChildren: true, rootOnly: true }) });
  }, [queryClient]);

  const { data: pages, isLoading, isPlaceholderData, error, refetch } = usePages({
    includeChildren: true,
    rootOnly: true,
  });

  // Flatten the tree for non-list views (graph, timeline, card, table)
  // so they receive all pages including child pages, not just root pages.
  const flatAllPages = useMemo(() => {
    if (!pages) return [];
    const seen = new Set<number>();
    const result: Node[] = [];
    const collect = (n: Node) => {
      if (n.is_page && !seen.has(n.id)) {
        seen.add(n.id);
        result.push(n);
      }
      if (n.children) {
        for (const child of n.children) {
          collect(child);
        }
      }
    };
    for (const n of pages) collect(n);
    return result;
  }, [pages]);

  // List view needs the tree structure; other views need a flat list of all pages.
  const displayNodes = useMemo(() => {
    return viewMode === 'list' ? (pages || []) : flatAllPages;
  }, [viewMode, pages, flatAllPages]);

  const handleSearchSelect = useCallback((node: Node) => {
    openNode(node.id);
  }, [openNode]);

  return (
    <article className={`node-view node-view--page pages-view pages-view--${viewMode}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header pages-view__header">
            <h1 className="page-header__title">
              Pages
            </h1>
            {/* Search — hidden in immersive view modes (graph/timeline) */}
            {viewMode !== 'graph' && viewMode !== 'timeline' && (
              <div className="pages-view__search">
                <SearchBox
                  placeholder="Search pages..."
                  onSelect={handleSearchSelect}
                />
              </div>
            )}
            <div className="pages-view__header-actions">
              <NodeCollectionToolbar
                viewMode={viewMode}
                availableViewModes={AVAILABLE_VIEW_MODES}
                onViewModeChange={handleViewModeChange}
                hideToolbarControls={false}
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
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="pages-view__content">
        <DataStateView
          isLoading={isLoading || isPlaceholderData}
          error={error}
          isEmpty={displayNodes.length === 0}
          onRetry={refetch}
          emptyTitle="No pages found"
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
            onNodeClick={(node) => openNode(node.id)}
            showClasses={true}
            showEmpty={true}
            emptyMessage="No pages found"
            expandAll={true}
            className="pages-view__node-collection"
            defaultSort={[{ key: 'name', direction: 'asc' }]}
          />
        </DataStateView>
      </div>
    </article>
  );
}

export default PagesView;

