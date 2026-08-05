import { useRef, useEffect } from 'react';
import type { Node } from '@/types';
import type { SearchResult } from './CommandPalette.types';
import { HighlightText } from './CommandPalette.utils';
import { NodeIcon, BulletIcon, PropertiesIcon } from '@/components/ui/icons';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { nodeNameToText, useNodeDisplayName } from '@/features/queries';
import './CommandPalette.css';

interface ResultItemProps {
  result: SearchResult;
  isSelected: boolean;
  onClick: () => void;
  allNodes?: Node[];
  allClasses?: Node[];
  pageClassUuid?: string | null;
  searchTerm?: string;
  id?: string;
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
  pageClassUuid,
  searchTerm = '',
  id,
}: ResultItemProps) {
  const ref = useRef<HTMLButtonElement>(null);

  // Resolve aliased node name if this node is an alias
  const aliasedNode = result.node?.aliased_uuid && allNodes
    ? allNodes.find(n => n.uuid === result.node?.aliased_uuid)
    : null;
  const resultDisplayName = useNodeDisplayName(result.node);
  const aliasedNodeDisplayName = useNodeDisplayName(aliasedNode, '');
  const aliasedNodeName = aliasedNodeDisplayName || null;

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
        id={id}
        role="option"
        aria-selected={isSelected}
        className={`command-palette__result ${isSelected ? 'command-palette__result--selected' : ''}`}
        onClick={onClick}
      >
        <div className="command-palette__result-row">
          <span className="command-palette__result-icon">
            {result.property.icon ? (
              <span style={{ fontSize: 'var(--font-size-md)' }}>{result.property.icon}</span>
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

  const displayClasses = (result.node.classes_uuid ?? [])
    .filter(uuid => uuid !== pageClassUuid)
    .map(uuid => allClasses?.find(c => c.uuid === uuid))
    .filter((c): c is Node => c !== undefined)
    .map(c => ({ id: c.uuid, name: nodeNameToText(c.name) }))
    .filter(cls => cls.name);

  return (
    <button
      ref={ref}
      id={id}
      role="option"
      aria-selected={isSelected}
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
            <HighlightText text={resultDisplayName} highlight={searchTerm} />
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
