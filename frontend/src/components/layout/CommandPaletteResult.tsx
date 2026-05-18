import { useRef, useEffect } from 'react';
import type { Node } from '@/types';
import type { SearchResult } from './CommandPalette.types';
import { HighlightText } from './CommandPalette.utils';
import { NodeIcon, BulletIcon, PropertiesIcon } from '@/components/core/icons';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import './CommandPalette.css';

interface ResultItemProps {
  result: SearchResult;
  isSelected: boolean;
  onClick: () => void;
  allNodes?: Node[];
  allClasses?: Node[];
  pageClassId?: number | null;
  searchTerm?: string;
}

/**
 * Result item component
 */
export function ResultItem({
  result,
  isSelected,
  onClick,
  allNodes,
  allClasses,
  pageClassId,
  searchTerm = '',
}: ResultItemProps) {
  const ref = useRef<HTMLButtonElement>(null);

  // Resolve aliased node name if this node is an alias
  const aliasedNodeName = result.node?.aliased_id && allNodes
    ? nodeNameToText(allNodes.find(n => n.id === result.node?.aliased_id)?.name) || 'Unknown'
    : null;

  // Scroll into view when selected
  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  // Handle property results
  if (result.type === 'property' && result.property) {
    return (
      <button
        ref={ref}
        className={`command-palette__result ${isSelected ? 'command-palette__result--selected' : ''}`}
        onClick={onClick}
      >
        <div className="command-palette__result-row">
          <span className="command-palette__result-icon">
            {result.property.icon ? (
              <span style={{ fontSize: '1.2em' }}>{result.property.icon}</span>
            ) : (
              <PropertiesIcon size="sm" />
            )}
          </span>
          <span className="command-palette__result-content">
            <span className="command-palette__result-name">
              <HighlightText text={result.property.name} highlight={searchTerm} />
            </span>
          </span>
          <span className="command-palette__result-type">
            property
          </span>
        </div>
      </button>
    );
  }

  // Handle node results
  if (!result.node) return null;

  const displayClasses = (result.node.classes ?? [])
    .filter(cid => cid !== pageClassId)
    .map(cid => allClasses?.find(c => c.id === cid))
    .filter((c): c is Node => c !== undefined)
    .map(c => ({ id: c.id, name: nodeNameToText(c.name) }))
    .filter(cls => cls.name);

  return (
    <button
      ref={ref}
      className={`command-palette__result ${isSelected ? 'command-palette__result--selected' : ''}`}
      onClick={onClick}
    >
      {result.breadcrumb && (
        <div className="command-palette__result-crumbs" title={result.breadcrumb}>
          {result.breadcrumb}
        </div>
      )}
      <div className="command-palette__result-row">
        <span className="command-palette__result-icon">
          {result.type === 'page' ? (
            <NodeIcon icon={getEffectiveIcon(result.node, allClasses)} isPage={true} size="sm" />
          ) : (() => {
            const effectiveIcon = getEffectiveIcon(result.node, allClasses);
            return effectiveIcon
              ? <NodeIcon icon={effectiveIcon} isPage={false} size="sm" />
              : <BulletIcon size="xs" />;
          })()}
        </span>
        <span className="command-palette__result-content">
          <span className="command-palette__result-name">
            <HighlightText text={nodeNameToText(result.node.name) || 'Untitled'} highlight={searchTerm} />
          </span>
        </span>
        {aliasedNodeName && (
          <span className="command-palette__result-alias">
            alias of: {aliasedNodeName}
          </span>
        )}
        {displayClasses.length > 0 && (
          <span className="node-result-item__class-pills">
            {displayClasses.map(cls => (
              <span key={cls.id} className="node-result-item__class-pill">{cls.name}</span>
            ))}
          </span>
        )}
      </div>
    </button>
  );
}
