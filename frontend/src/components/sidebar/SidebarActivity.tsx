import { useState } from 'react';
import { NodeViewSection } from '@/components/nodes/NodeViewSection';
import { ClockIcon } from '@/components/core/icons';
import { Spinner } from '@/components/core/Spinner';
import { NodeActivityLogSection } from '@/components/nodes/NodeActivityLogSection';

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
      hideWhenEmpty={false}
    >
      {loading ? (
        <div className="sidebar-section-loading"><Spinner size="sm" centered /></div>
      ) : (
        <NodeActivityLogSection nodeId={nodeId} />
      )}
    </NodeViewSection>
  );
}
