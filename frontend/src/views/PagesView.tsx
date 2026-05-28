/**
 * Pages View - hub for all pages with view mode switching
 *
 * Uses NodeCollection directly with multiple view modes (list, document, card,
 * table, graph, timeline). List view shows the full pages tree hierarchy.
 */
import { useState, useCallback } from 'react';
import { usePages, useContentSave } from '@/hooks';
import { useNavigationStore, useModalStore, useAppStore } from '@/stores';
import { NodeCollection } from '@/components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '@/components/nodes/NodeCollectionToolbar';
import { SearchBox } from '@/components/core/SearchBox';
import { Button } from '@/components/core/Button';
import { Spinner } from '@/components/core/Spinner';
import { PageIcon } from '@/components/core/icons';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { Node } from '@/types';
import './PagesView.css';

const PSEUDO_NODE_ID = 0;
const PSEUDO_VIEW_TYPE = 'all_pages';

const AVAILABLE_VIEW_MODES: NodeCollectionViewMode[] = [
  'list',
  'document',
  'card',
  'table',
  'graph',
  'timeline',
];

export function PagesView() {
  const { openNode } = useNavigationStore();
  const { setCommandPaletteOpen } = useModalStore();
  const getNodeViewMode = useAppStore((state) => state.getNodeViewMode);
  const setNodeViewMode = useAppStore((state) => state.setNodeViewMode);
  const { handleContentChange: saveContent } = useContentSave();

  const persistedViewMode = getNodeViewMode(PSEUDO_NODE_ID, PSEUDO_VIEW_TYPE);
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>(
    persistedViewMode ?? 'list'
  );

  const handleViewModeChange = useCallback((mode: NodeCollectionViewMode) => {
    setViewMode(mode);
    setNodeViewMode(PSEUDO_NODE_ID, PSEUDO_VIEW_TYPE, mode);
  }, [setNodeViewMode]);

  const { data: pages, isLoading } = usePages({
    includeChildren: true,
    rootOnly: true,
  });

  const handleSearchSelect = useCallback((node: Node) => {
    openNode(node.id);
  }, [openNode]);

  return (
    <article className="node-view node-view--page pages-view">
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header pages-view__header">
            <h1 className="page-header__title">
              <PageIcon size="sm" className="pages-view__title-icon" />
              Pages
            </h1>
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
                onClick={() => setCommandPaletteOpen(true)}
                title="New page (Ctrl+K)"
              >
                New page
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="pages-view__search">
        <SearchBox
          placeholder="Search pages..."
          onSelect={handleSearchSelect}
        />
      </div>

      {/* Content */}
      <div className="pages-view__content">
        {isLoading ? (
          <div className="pages-view__loading">
            <Spinner size="lg" centered />
          </div>
        ) : (
          <NodeCollection
            nodes={pages || []}
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
            showEmpty={true}
            emptyMessage="No pages found"
            className="pages-view__node-collection"
          />
        )}
      </div>
    </article>
  );
}

export default PagesView;
