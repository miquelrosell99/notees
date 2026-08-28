/**
 * CollectionTreePane — left pane of the Library three-pane layout (Task 11).
 *
 * Renders the "All sources" pseudo-root followed by the nested collection
 * tree (expandable per node). Selection is controller-free: the parent owns
 * the state and passes `flattenCollectionTree` rows plus callbacks.
 */
import { Icon } from '@/components/ui/icons';
import type {
  CollectionTreeRow,
} from '../collectionTree';
import { libraryNodeName } from '../libraryUtils';

interface CollectionTreePaneProps {
  rows: CollectionTreeRow[];
  /** null = the "All sources" pseudo-root is selected. */
  selectedCollectionUuid: string | null;
  onSelectCollection: (collectionUuid: string | null) => void;
  onToggleExpand: (collectionUuid: string) => void;
}

export function CollectionTreePane({
  rows,
  selectedCollectionUuid,
  onSelectCollection,
  onToggleExpand,
}: CollectionTreePaneProps) {
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
            className={`library-tree__row${isActive ? ' library-tree__row--active' : ''}`}
            style={{ paddingLeft: `calc(var(--spacing-2) + ${row.depth} * var(--spacing-4))` }}
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
