import { useState } from 'react';
import { NodeViewSection, NodeActivityLogSection } from '@/features/content';
import { ClockIcon } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/Spinner';

interface SidebarActivityProps {
  nodeId: number;
  count: number;
  loading: boolean;
}

export function SidebarActivity({ nodeId, count, loading }: SidebarActivityProps) {
  const [expanded, setExpanded] = useState(false);

  if (count === 0 && !loading) return null;

  return (
    <NodeViewSection
      title="Activity"
      icon={<ClockIcon size="xs" />}
      count={count}
      expanded={expanded}
      onExpandedChange={setExpanded}
      className="sidebar-context-section sidebar-context-section--activity"
      variant="sidebar"
      hideWhenEmpty={false}
    >
      {loading ? (
        <div className="sidebar-section-loading"><Spinner size="sm" centered /></div>
      ) : (
        <NodeActivityLogSection nodeId={nodeId} variant="sidebar" />
      )}
    </NodeViewSection>
  );
}
