/**
 * ClassView — dedicated detail view for a class schema.
 *
 * Separated from NodeView because classes are not pages or blocks: they live in
 * the dedicated `class` table, define property schemas, and are best represented
 * by a header, property definitions, and their member nodes rather than page-like
 * content sections.
 */
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useNode } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { MainContentTopbar } from '@/features/layout';
import { NodeBreadcrumbs } from '@/features/content/components/nodes/NodeBreadcrumbs';
import { ClassHeader } from '@/features/content/components/nodes/ClassHeader';
import { ClassPropertiesEditor } from '@/features/properties';
import { QuerySection } from '@/features/content/components/nodes';
import { LoadingSkeleton } from '@/components/ui/LoadingSkeleton';
import { DataStateView } from '@/components/ui/DataStateView';
import { TableIcon } from '@/components/ui/icons';
import { useIsMobile } from '@/hooks/useIsMobile';
import './NodeView.css';

interface ClassViewProps {
  /** Class node UUID to display */
  nodeUuid: string;
  /** View mode (default, focus, zen) */
  viewMode: 'default' | 'focus' | 'zen';
  /** Additional CSS class applied to the root <article>. */
  className?: string;
}

export interface ClassViewResult {
  header: React.ReactNode;
  content: React.ReactNode;
}

/**
 * Build the class view. Mirrors NodeView's return shape so MainContentPane can
 * render the header in the fixed top bar and the content in the scrollable area.
 */
export function ClassView({ nodeUuid, viewMode, className = '' }: ClassViewProps): ClassViewResult {
  const isMobile = useIsMobile();
  const isFocusMode = viewMode === 'focus';

  const { data: node, isLoading, error, refetch } = useNode(nodeUuid);

  const { openNode, openPropertyView } = useNavigationStore(
    useShallow((state) => ({
      openNode: state.openNode,
      openPropertyView: state.openPropertyView,
    }))
  );
  const addSidebarCard = useNavigationStore((s) => s.addSidebarCard);

  const handleNavigateToNode = useCallback(
    (targetUuid: string) => {
      openNode(targetUuid);
    },
    [openNode]
  );

  const sectionVariant = 'default' as const;

  // Loading state
  if (isLoading) {
    return {
      header: <MainContentTopbar focusMode={isFocusMode} />,
      content: (
        <article className={`node-view node-view--page ${viewMode} ${className}`}>
          <LoadingSkeleton rows={8} showHeading />
        </article>
      ),
    };
  }

  // Error state
  if (error) {
    return {
      header: <MainContentTopbar focusMode={isFocusMode} />,
      content: (
        <article className={`node-view node-view--error ${viewMode} ${className}`}>
          <DataStateView error={error} errorTitle="Failed to load class" onRetry={refetch}>
            {null}
          </DataStateView>
        </article>
      ),
    };
  }

  // Not-found state
  if (!node) {
    return {
      header: <MainContentTopbar focusMode={isFocusMode} />,
      content: (
        <article className={`node-view node-view--error ${viewMode} ${className}`}>
          <div className="error-state">Class not found</div>
        </article>
      ),
    };
  }

  const headerContent = (
    <MainContentTopbar
      focusMode={isFocusMode}
      left={
        <NodeBreadcrumbs
          nodeUuid={nodeUuid}
          nodeType="page"
          onNavigate={handleNavigateToNode}
          onNavigateToProperty={(id) => openPropertyView(id)}
          inHeader
          className="node-view-breadcrumbs"
        />
      }
    />
  );

  const content = (
    <article
      className={`node-view node-view--page ${viewMode} ${className}`}
      data-focus-mode={isFocusMode || undefined}
    >
      <div className="page-header-section">
        <div className="page-header-section__header">
          <ClassHeader node={node} focusMode={isFocusMode} />
        </div>
      </div>

      {/* Property schema definitions for this class */}
      <ClassPropertiesEditor classNodeUuid={node.uuid} defaultExpanded={!isMobile} />

      {/* Subclasses that extend this class */}
      <QuerySection
        nodeUuid={node.uuid}
        nodeName={node.name}
        viewType="extended_by"
        title="Extended By"
        icon={<TableIcon size="sm" />}
        hideWhenEmpty={true}
        defaultExpanded={true}
        onNodeClick={handleNavigateToNode}
        onBlockCreated={(targetUuid) => addSidebarCard(targetUuid, 'block')}
        hideViewManagement={true}
        can_create={false}
        showClasses={false}
        variant={sectionVariant}
        focusMode={isFocusMode}
      />

      {/* Nodes that are instances of this class */}
      <QuerySection
        nodeUuid={node.uuid}
        nodeName={node.name}
        viewType="classed_nodes"
        title="Nodes"
        icon={<TableIcon size="sm" />}
        hideWhenEmpty={false}
        defaultExpanded={true}
        onNodeClick={handleNavigateToNode}
        onBlockCreated={(targetUuid) => addSidebarCard(targetUuid, 'block')}
        can_create={true}
        variant={sectionVariant}
        focusMode={isFocusMode}
      />
    </article>
  );

  return { header: headerContent, content };
}

/**
 * ClassViewWrapper - React component wrapper for ClassView function
 * Renders header as fixed bar.
 */
export function ClassViewWrapper(props: ClassViewProps) {
  const { header } = ClassView(props);
  return header;
}

/**
 * ClassViewContent - Renders just the content portion.
 */
export function ClassViewContent(props: ClassViewProps) {
  const { content } = ClassView(props);
  return content;
}

export default ClassView;
