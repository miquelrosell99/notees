/**
 * NodeMetadataSection - Collapsible section for node metadata
 *
 * Wraps Classes, Tags, Aliases, and Extends in a NodeViewSection
 * for consistent collapsible behavior across the node view.
 */
import { NodeViewSection } from '@/features/content/components/nodes/NodeViewSection';
import { NodeSelector } from '@/features/content/components/nodes/NodeSelector';
import { MetadataIcon } from '@/components/ui/icons';
import type { Node } from '@/types/api';
import { nodeNameToText } from '@/features/queries';
import './NodeMetadataSection.css';

interface NodeMetadataSectionProps {
  node: Node;
  pageClassDetails: Node[];
  pageTagDetails: Node[];
  extendsDetails: Node[];
  pageAliasDetails: Node[];
  aliasedNode: Node | null;
  isAlias: boolean;
  onNavigateToNode: (id: number) => void;
  onNavigateToAlias: (node: Node) => void;
  onRemoveClass?: (node: Node) => void;
  onAddClass?: (node: Node) => void;
  onCreateClass?: (name: string) => void;
  onConvertToClass?: (node: Node) => void;
  onNodeColorChange?: (node: Node, color: string | null) => void;
  canRemoveClass?: (node: Node) => boolean;
  canAddClass?: (node: Node) => boolean;
  onRemoveTag?: (node: Node) => void;
  onAddTag?: (node: Node) => void;
  onCreateTag?: (name: string) => void;
  onRemoveAlias?: (node: Node) => void;
  onAddAlias?: (node: Node) => void;
  onRemoveExtends?: (node: Node) => void;
  onAddExtends?: (node: Node) => void;
  onCreateExtends?: (name: string) => void;
  defaultExpanded?: boolean;
  /** When true, hides the entire section (used by focus mode). */
  focusMode?: boolean;
  /** Visual variant passed to the underlying section chrome. */
  variant?: 'default' | 'sidebar-node';
}

export function NodeMetadataSection({
  node,
  pageClassDetails,
  pageTagDetails,
  extendsDetails,
  pageAliasDetails,
  aliasedNode,
  isAlias,
  onNavigateToNode,
  onNavigateToAlias,
  onRemoveClass,
  onAddClass,
  onCreateClass,
  onConvertToClass,
  onNodeColorChange,
  canRemoveClass,
  canAddClass,
  onRemoveTag,
  onAddTag,
  onCreateTag,
  onRemoveAlias,
  onAddAlias,
  onRemoveExtends,
  onAddExtends,
  onCreateExtends,
  defaultExpanded = true,
  focusMode = false,
  variant = 'default',
}: NodeMetadataSectionProps) {
  const count =
    pageClassDetails.length +
    pageTagDetails.length +
    extendsDetails.length +
    pageAliasDetails.length +
    (aliasedNode ? 1 : 0);

  return (
    <NodeViewSection
      title="Metadata"
      icon={<MetadataIcon size="sm" />}
      count={count}
      className="node-metadata-section"
      defaultExpanded={defaultExpanded}
      focusMode={focusMode}
      variant={variant}
    >
      <div className="node-metadata-content">
        {/* Classes */}
        <div className="node-metadata-row">
          <div className="section-label">Classes{isAlias ? ' (inherited)' : ''}:</div>
          <NodeSelector
            nodes={pageClassDetails}
            searchMode="classes"
            emptyText={isAlias ? '' : 'Add class'}
            searchPlaceholder="Search classes..."
            onNodeClick={(n) => onNavigateToNode(n.id)}
            onRemove={isAlias ? undefined : onRemoveClass}
            onColorChange={isAlias ? undefined : onNodeColorChange}
            onAdd={isAlias ? undefined : onAddClass}
            onCreateNew={isAlias ? undefined : onCreateClass}
            onConvertToClass={isAlias ? undefined : onConvertToClass}
            canRemove={canRemoveClass}
            canAdd={canAddClass}
          />
        </div>

        {/* Tags */}
        <div className="node-metadata-row">
          <div className="section-label">Tags:</div>
          <NodeSelector
            nodes={pageTagDetails}
            searchMode="tags"
            emptyText="Add tag"
            searchPlaceholder="Search tags..."
            excludeNodeId={node.id}
            onNodeClick={(n) => onNavigateToNode(n.id)}
            onRemove={onRemoveTag}
            onColorChange={onNodeColorChange}
            onAdd={onAddTag}
            onCreateNew={onCreateTag}
          />
        </div>

        {/* Aliases */}
        {node.is_page && !isAlias && (
          <div className="node-metadata-row">
            <div className="section-label">Aliases:</div>
            <NodeSelector
              nodes={pageAliasDetails}
              searchMode="aliases"
              emptyText="Add alias"
              searchPlaceholder="Search pages..."
              excludeNodeId={node.id}
              onNodeClick={onNavigateToAlias}
              onRemove={onRemoveAlias}
              onAdd={onAddAlias}
            />
          </div>
        )}
        {node.is_page && isAlias && aliasedNode && (
          <div className="node-metadata-row">
            <div className="section-label">Alias of:</div>
            <button
              type="button"
              className="alias-of-link"
              onClick={() => onNavigateToNode(aliasedNode.id)}
              title={nodeNameToText(aliasedNode.name) || 'Untitled'}
            >
              {nodeNameToText(aliasedNode.name) || 'Untitled'}
            </button>
          </div>
        )}

        {/* Extends */}
        {node.is_class && (
          <div className="node-metadata-row">
            <div className="section-label">Extends:</div>
            <NodeSelector
              nodes={extendsDetails}
              searchMode="classes"
              emptyText="Add extend"
              searchPlaceholder="Search classes to extend..."
              excludeNodeId={node.id}
              onNodeClick={(n) => onNavigateToNode(n.id)}
              onRemove={onRemoveExtends}
              onColorChange={onNodeColorChange}
              onAdd={onAddExtends}
              onCreateNew={onCreateExtends}
            />
          </div>
        )}
      </div>
    </NodeViewSection>
  );
}
