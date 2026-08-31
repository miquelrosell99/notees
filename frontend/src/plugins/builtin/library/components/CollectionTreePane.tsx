/**
 * CollectionTreePane — left pane of the Library three-pane layout (Task 11).
 *
 * Renders the "All sources" pseudo-root followed by the nested collection
 * tree (expandable per node). Selection is controller-free: the parent owns
 * the state and passes `flattenCollectionTree` rows plus callbacks.
 */
import { useState } from 'react';
import { Icon } from '@/components/ui/icons';
import type {
  CollectionTreeRow,
} from '../collectionTree';
import { libraryNodeName } from '../libraryUtils';
import { isNodeDrag, parseNodeDragPayload, NOTEES_NODE_MIME } from '../libraryDnd';

interface CollectionTreePaneProps {
  rows: CollectionTreeRow[];
  /** null = the "All sources" pseudo-root is selected. */
  selectedCollectionUuid: string | null;
  onSelectCollection: (collectionUuid: string | null) => void;
  onToggleExpand: (collectionUuid: string) => void;
  /** Drag-to-collect (Task 12): a source node dropped onto a collection row. */
  onDropSource?: (sourceUuid: string, collectionUuid: string) => void;
}

export function CollectionTreePane({
  rows,
  selectedCollectionUuid,
  onSelectCollection,
  onToggleExpand,
  onDropSource,
}: CollectionTreePaneProps) {
  // uuid of the collection row currently highlighted as a drop target.
  const [dropTargetUuid, setDropTargetUuid] = useState<string | null>(null);

  const rowDropProps = (collectionUuid: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!onDropSource || !isNodeDrag(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'link';
      setDropTargetUuid(collectionUuid);
    },
    onDragLeave: () => {
      setDropTargetUuid((current) => (current === collectionUuid ? null : current));
    },
    onDrop: (e: React.DragEvent) => {
      setDropTargetUuid(null);
      if (!onDropSource) return;
      const payload = parseNodeDragPayload(e.dataTransfer.getData(NOTEES_NODE_MIME));
      if (!payload) return;
      e.preventDefault();
      onDropSource(payload.nodeUuid, collectionUuid);
    },
  });

  return (
    <nav className="library-tree" aria-label="Collections">
      <button
        type="button"
        className={`library-tree__row${selectedCollectionUuid === null ? ' library-tree__row--active' : ''}`}
        onClick={() => onSelectCollection(null)}
      >
        <span className="library-tree__expand-spacer" aria-hidden="true" />
        <Icon path="mdi mdi-bookshelf" size={0.9} className="library-tree__icon" />
        <span className="library-tree__label">All sources</span>
      </button>

      {rows.map((row) => {
        const uuid = row.collection.uuid;
        const isActive = selectedCollectionUuid === uuid;
        return (
          <div
            key={uuid}
            className={`library-tree__row${isActive ? ' library-tree__row--active' : ''}${dropTargetUuid === uuid ? ' library-tree__row--drop-target' : ''}`}
            style={{ paddingLeft: `calc(var(--spacing-2) + ${row.depth} * var(--spacing-4))` }}
            {...rowDropProps(uuid)}
          >
            {row.hasChildren ? (
              <button
                type="button"
                className="library-tree__expand-btn"
                onClick={() => onToggleExpand(uuid)}
                aria-label={row.expanded ? 'Collapse subcollections' : 'Expand subcollections'}
                aria-expanded={row.expanded}
              >
                <Icon
                  path={row.expanded ? 'mdi mdi-chevron-down' : 'mdi mdi-chevron-right'}
                  size={0.8}
                />
              </button>
            ) : (
              <span className="library-tree__expand-spacer" aria-hidden="true" />
            )}
            <button
              type="button"
              className="library-tree__collection"
              onClick={() => onSelectCollection(uuid)}
              aria-current={isActive ? 'true' : undefined}
            >
              <Icon path="mdi mdi-folder-multiple-outline" size={0.9} className="library-tree__icon" />
              <span className="library-tree__label">{libraryNodeName(row.collection)}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}

export default CollectionTreePane;
