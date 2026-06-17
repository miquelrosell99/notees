/**
 * Unlinked Mentions Section
 *
 * Displays page-name occurrences in other nodes' content that have not yet
 * been turned into explicit links. Each mention can be promoted (converted
 * into a [[link]]) or ignored (dismissed).
 */
import { useState, useCallback, useMemo } from 'react';
import { useUnlinkedMentions, usePromoteMention, useIgnoreMention } from '@/hooks';
import { Button } from '@/components/ui/Button';
import { ChevronRightIcon, ChevronDownIcon, SearchIcon } from '@/components/ui/icons';
import { nodeNameToText } from '@/hooks';
import type { Mention } from '@/types/api';
import './NodeViewSection.css';
import './UnlinkedMentionsSection.css';

interface UnlinkedMentionsSectionProps {
  nodeId: number;
  defaultExpanded?: boolean;
  onNodeClick?: (nodeId: number) => void;
}

export function UnlinkedMentionsSection({
  nodeId,
  defaultExpanded = false,
  onNodeClick,
}: UnlinkedMentionsSectionProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const { data: mentions = [], isLoading } = useUnlinkedMentions(nodeId);
  const promote = usePromoteMention();
  const ignore = useIgnoreMention();

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const sortedMentions = useMemo(
    () => [...mentions].sort((a, b) => a.position - b.position),
    [mentions]
  );

  if (!isLoading && sortedMentions.length === 0) {
    return null;
  }

  return (
    <section className={`node-view-section ${isExpanded ? '' : 'collapsed'}`}>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- Pointer-only header toggle; keyboard users can use the visible expand/collapse button inside it. */}
      <div
        className="node-view-section__header"
        onClick={handleToggle}
        aria-expanded={isExpanded}
      >
        <div className="node-view-section__header-content">
          <Button
            variant="ghost"
            size="xs"
            className="node-view-section__toggle"
            aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
            onClick={(e) => {
              e.stopPropagation();
              handleToggle();
            }}
          >
            {isExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
          </Button>
          <div className="node-view-section__title-area">
            <span className="node-view-section__icon">
              <SearchIcon size="sm" />
            </span>
            <h3 className="node-view-section__title">Unlinked Mentions</h3>
            <span className="node-view-section__count">({sortedMentions.length})</span>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="node-view-section__content">
          <ul className="unlinked-mentions-list">
            {sortedMentions.map((mention) => (
              <MentionItem
                key={mention.id}
                mention={mention}
                onNodeClick={onNodeClick}
                onPromote={() => promote.mutate({ nodeId, mentionId: mention.id })}
                onIgnore={() => ignore.mutate({ nodeId, mentionId: mention.id })}
                isPromoting={promote.isPending}
                isIgnoring={ignore.isPending}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface MentionItemProps {
  mention: Mention;
  onNodeClick?: (nodeId: number) => void;
  onPromote: () => void;
  onIgnore: () => void;
  isPromoting: boolean;
  isIgnoring: boolean;
}

function MentionItem({
  mention,
  onNodeClick,
  onPromote,
  onIgnore,
  isPromoting,
  isIgnoring,
}: MentionItemProps): React.JSX.Element {
  const sourceName = nodeNameToText({ name: mention.source_node_name } as { name: string });

  return (
    <li className="unlinked-mention-item">
      <button
        type="button"
        className="unlinked-mention-source"
        onClick={() => onNodeClick?.(mention.source_node_id)}
        title="Open source node"
      >
        {sourceName}
      </button>
      <span className="unlinked-mention-context">
        {' — '}
        <span className="unlinked-mention-match">{mention.match_text}</span>
      </span>
      <div className="unlinked-mention-actions">
        <Button
          size="xs"
          variant="ghost"
          onClick={onPromote}
          disabled={isPromoting || isIgnoring}
          title="Convert to link"
        >
          Link
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={onIgnore}
          disabled={isPromoting || isIgnoring}
          title="Ignore this mention"
        >
          Ignore
        </Button>
      </div>
    </li>
  );
}
