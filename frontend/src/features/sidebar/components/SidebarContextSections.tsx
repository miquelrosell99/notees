/**
 * SidebarContextSections Component
 *
 * Bottom-anchored sections in the right sidebar that show context-specific
 * information for the currently active node:
 * - TOC: heading extraction and navigation
 * - Comments: comment list with quick-add
 * - Activity: activity log
 * - Versions: version history with restore
 */
import { useMemo, useCallback } from 'react';
import { useNavigationStore } from '@/stores';
import { useComments, useNodeActivity, useNode } from '@/features/content';
import { nodeNameToDisplayText } from '@/features/queries';
import { parseAST } from '@/lib/astBuilder';
import { isHeadingBlock } from '@/types/ast';
import type { Node } from '@/types/api';
import { SidebarToc } from './SidebarToc';
import { SidebarComments } from './SidebarComments';
import { SidebarActivity } from './SidebarActivity';
import { SidebarVersions } from './SidebarVersions';
import './SidebarContextSections.css';

interface TocEntry {
  nodeUuid: string;
  uuid: string;
  text: string;
  level: number;
}

function extractHeadings(nodes: Node[], depth: number = 0): TocEntry[] {
  const result: TocEntry[] = [];
  for (const node of nodes) {
    const ast = parseAST(node.name);
    if (ast.length > 0 && isHeadingBlock(ast[0])) {
      result.push({
        nodeUuid: node.uuid,
        uuid: node.uuid,
        text: nodeNameToDisplayText(node, { maxLength: 100 }) || 'Untitled',
        level: Math.min(depth + 1, 6),
      });
    }
    if (node.children?.length) {
      result.push(...extractHeadings(node.children, depth + 1));
    }
  }
  return result;
}

export function SidebarContextSections() {
  const currentNodeUuid = useNavigationStore(state => state.currentNodeUuid);
  const mainViewType = useNavigationStore(state => state.mainViewType);

  const { data: commentsData, isLoading: commentsLoading } = useComments(
    mainViewType === 'node' ? currentNodeUuid : null
  );
  const { data: activityData, isLoading: activityLoading } = useNodeActivity(
    mainViewType === 'node' ? currentNodeUuid : null
  );

  const { data: nodeData } = useNode(
    mainViewType === 'node' ? currentNodeUuid : null,
    { include_children: true }
  );

  const tocEntries = useMemo(() => {
    if (!nodeData?.children) return [];
    return extractHeadings(nodeData.children);
  }, [nodeData]);

  const handleTocClick = useCallback((blockId: string) => {
    const el = document.querySelector(`[data-block-id="${blockId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('node-block--toc-highlight');
      setTimeout(() => el.classList.remove('node-block--toc-highlight'), 1500);
    }
  }, []);

  const commentCount = commentsData?.comments?.length ?? 0;
  const activityCount = activityData?.length ?? 0;

  if (mainViewType !== 'node' || !currentNodeUuid) return null;

  return (
    <div className="sidebar-context-sections">
      <SidebarToc entries={tocEntries} onTocClick={handleTocClick} />
      <SidebarComments
        nodeUuid={currentNodeUuid}
        comments={commentsData?.comments ?? []}
        count={commentCount}
        loading={commentsLoading}
      />
      <SidebarActivity
        nodeUuid={currentNodeUuid}
        count={activityCount}
        loading={activityLoading}
      />
      {nodeData?.uuid && <SidebarVersions nodeUuid={nodeData.uuid} />}
    </div>
  );
}
