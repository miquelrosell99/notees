/**
 * LibraryCardGrid — card rendering of Library sources.
 *
 * Covers resolve from the node's `cover` property with fallback to
 * `parent.cover` (Work → Edition); a neutral placeholder is shown otherwise.
 * Grouped mode renders Works as cards with their Editions expandable beneath.
 */
import { useState, useCallback } from 'react';
import { AssetImage } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/icons';
import type { Node } from '@/types';
import {
  libraryNodeName,
  resolveAuthorNames,
  resolveCoverAssetUuid,
  type WorkGroup,
} from '../libraryUtils';

interface LibraryCardGridProps {
  /** Flat mode: every source its own card. */
  rows: Node[];
  /** Grouped mode: works with editions collapsed beneath them. */
  groups: WorkGroup[];
  grouped: boolean;
  /** All sources (unfiltered) so edition covers can fall back to parent.cover. */
  allSourcesByUuid: ReadonlyMap<string, Node>;
  agentsByUuid: ReadonlyMap<string, Node>;
  onOpenNode: (nodeUuid: string) => void;
}

export function LibraryCardGrid({
  rows,
  groups,
  grouped,
  allSourcesByUuid,
  agentsByUuid,
  onOpenNode,
}: LibraryCardGridProps) {
  const [expandedWorks, setExpandedWorks] = useState<ReadonlySet<string>>(new Set());

  const toggleWork = useCallback((workUuid: string) => {
    setExpandedWorks((prev) => {
      const next = new Set(prev);
      if (next.has(workUuid)) {
        next.delete(workUuid);
      } else {
        next.add(workUuid);
      }
      return next;
    });
  }, []);

  const renderCard = (node: Node, opts: { isEdition?: boolean; editions?: Node[] } = {}) => {
    const { isEdition = false, editions = [] } = opts;
    const coverUuid = resolveCoverAssetUuid(node, allSourcesByUuid);
    const authors = resolveAuthorNames(node, agentsByUuid);
    const isExpanded = expandedWorks.has(node.uuid);

    return (
      <div key={node.uuid} className="library-card-wrapper">
        <div
          className={`library-card${isEdition ? ' library-card--edition' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => onOpenNode(node.uuid)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenNode(node.uuid);
            }
          }}
        >
          <div className="library-card__cover">
            {coverUuid ? (
              <AssetImage
                assetNodeId={coverUuid}
                alt={`Cover of ${libraryNodeName(node)}`}
                className="library-card__cover-image"
                imageClassName="library-card__cover-img"
                showCard={false}
                clickable={false}
                assetVariant="card-cover"
              />
            ) : (
              <div className="library-card__cover-placeholder" aria-hidden="true">
                <Icon path="mdi mdi-book-open-variant" size={1.6} />
              </div>
            )}
          </div>
          <div className="library-card__body">
            <span className="library-card__title">{libraryNodeName(node)}</span>
            {authors.length > 0 && (
              <span className="library-card__authors">{authors.join(', ')}</span>
            )}
            {grouped && !isEdition && editions.length > 0 && (
              <Button
                variant="ghost"
                size="xs"
                icon={isExpanded ? 'mdi mdi-chevron-down' : 'mdi mdi-chevron-right'}
                className="library-card__editions-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleWork(node.uuid);
                }}
                aria-expanded={isExpanded}
              >
                {editions.length} edition{editions.length === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        </div>
        {isExpanded &&
          editions.map((edition) => renderCard(edition, { isEdition: true }))}
      </div>
    );
  };

  return (
    <div className="library-card-grid">
      {grouped
        ? groups.map((group) => renderCard(group.work, { editions: group.editions }))
        : rows.map((node) => renderCard(node))}
    </div>
  );
}
