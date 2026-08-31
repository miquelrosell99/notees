/**
 * CollectionView — class-driven chrome for pages classed `collection`
 * (Decision 22, same principle as the whiteboard view).
 *
 * Renders a member list instead of the document flow: sources nested under
 * the collection recursively (subcollections included) unioned with sources
 * linking to it — deduped, intersected with class:source.
 */
import { useMemo, useState, useCallback } from 'react';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { PageViewHeader } from '@/features/content/components/nodes/PageViewHeader';
import { useNode } from '@/features/content/hooks/useNodes';
import { useSystemClasses } from '@/features/content/hooks/usePageClass';
import { useQuery_ } from '@/features/content/hooks/useNodeViews.queries';
import { NodeCollectionToolbar } from '@/features/content/components/nodes/NodeCollectionToolbar';
import { NodeSearchBox } from '@/features/content/components/nodes/NodeSearchBox';
import { DataStateView } from '@/components/ui/DataStateView';
import { useNavigationStore } from '@/stores';
import { nodeNameToText } from '@/features/queries';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import {
  buildCollectionLinkedQueryAst,
  buildCollectionNestedQueryAst,
  computeCollectionContents,
} from '../utils/collectionContents';
import './CollectionView.css';

const AVAILABLE_VIEW_MODES: NodeCollectionViewMode[] = ['list', 'table'];

interface CollectionViewProps {
  nodeUuid: string;
}

export function CollectionView({ nodeUuid }: CollectionViewProps) {
  const openNode = useNavigationStore((state) => state.openNode);
  const { data: collectionNode } = useNode(nodeUuid);
  const { systemClassUuids } = useSystemClasses();
  const sourceClassUuid = systemClassUuids?.source ?? null;

  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');

  const nestedAst = useMemo(
    () => (sourceClassUuid ? buildCollectionNestedQueryAst(nodeUuid, sourceClassUuid) : undefined),
    [nodeUuid, sourceClassUuid],
  );
  const linkedAst = useMemo(
    () => (sourceClassUuid ? buildCollectionLinkedQueryAst(nodeUuid, sourceClassUuid) : undefined),
    [nodeUuid, sourceClassUuid],
  );

  const { data: nestedSources, isLoading: nestedLoading } = useQuery_(
    { query_ast: nestedAst, include_properties: true },
    { enabled: !!nestedAst },
  );
  const { data: linkedSources, isLoading: linkedLoading } = useQuery_(
    { query_ast: linkedAst, include_properties: true },
    { enabled: !!linkedAst },
  );

  const members = useMemo(
    () => computeCollectionContents(nestedSources ?? [], linkedSources ?? []),
    [nestedSources, linkedSources],
  );

  const handleNodeClick = useCallback(
    (node: Node) => {
      openNode(node.uuid);
    },
    [openNode],
  );

  const handleSearchSelect = useCallback(
    (node: Node) => {
      openNode(node.uuid);
    },
    [openNode],
  );

  const isLoading = nestedLoading || linkedLoading;
  const title = nodeNameToText(collectionNode?.name) || 'Collection';

  return (
    <article className="node-view node-view--page collection-view">
      <PageViewHeader
        className="collection-view__header"
        title={<h1>{title}</h1>}
        middle={
          <NodeSearchBox placeholder="Search sources..." onSelect={handleSearchSelect} />
        }
        actions={
          <NodeCollectionToolbar
            viewMode={viewMode}
            availableViewModes={AVAILABLE_VIEW_MODES}
            onViewModeChange={setViewMode}
            hideToolbarControls={false}
            isTransient={true}
          />
        }
      />

      <div className="collection-view__content">
        <DataStateView
          isLoading={isLoading}
          isEmpty={members.length === 0}
          emptyTitle="No sources yet"
          emptyDescription="Nest sources under this collection or link them to it."
          skeletonRows={4}
        >
          <NodeCollection
            nodes={members}
            viewMode={viewMode}
            availableViewModes={AVAILABLE_VIEW_MODES}
            onViewModeChange={setViewMode}
            pagesOnly={false}
            hideProperties={false}
            showBreadcrumbs={true}
            hideToolbar={true}
            editable={false}
            onNodeClick={handleNodeClick}
            showClasses={true}
            showEmpty={true}
            emptyMessage="Nest sources under this collection or link them to it"
            className="collection-view__node-collection"
            isTransient={true}
            groupBy="none"
            showNewBlock={false}
            maxDepth={0}
          />
        </DataStateView>
      </div>
    </article>
  );
}

export default CollectionView;
