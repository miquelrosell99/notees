import { useState, useEffect, useCallback } from 'react';
import { NodeViewSection } from '@/features/content/components/nodes/NodeViewSection';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Icon } from '@/components/ui/icons';
import { getNodeVersions, restoreNodeVersion, type NodeVersion } from '@/api/nodes';
import { useSettingsStore, formatDate } from '@/stores';
import { useNotifications } from '@/stores/notificationStore';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';

interface SidebarVersionsProps {
  nodeId: number;
}

export function SidebarVersions({ nodeId }: SidebarVersionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<NodeVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const dateFormat = useSettingsStore(s => s.dateFormat);
  const queryClient = useQueryClient();
  const { success: notifySuccess, error: notifyError } = useNotifications();

  useEffect(() => {
    if (expanded && nodeId) {
      setLoading(true);
      getNodeVersions(nodeId, 30)
        .then(v => setVersions(v))
        .catch(() => setVersions([]))
        .finally(() => setLoading(false));
    }
  }, [expanded, nodeId]);

  const handleRestore = useCallback(async (versionId: number) => {
    try {
      await restoreNodeVersion(nodeId, versionId);
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      notifySuccess('Version restored', 'The node content has been restored.');
      getNodeVersions(nodeId, 30).then(setVersions).catch(() => {});
    } catch {
      notifyError('Failed to restore', 'Could not restore this version.');
    }
  }, [nodeId, queryClient, notifySuccess, notifyError]);

  return (
    <NodeViewSection
      title="Version History"
      icon={<Icon path={"mdi mdi-history"} size={0.6} />}
      count={expanded ? versions.length : undefined}
      expanded={expanded}
      onExpandedChange={setExpanded}
      className="sidebar-context-section sidebar-context-section--versions"
      hideWhenEmpty={false}
    >
      {loading ? (
        <div className="sidebar-section-loading"><Spinner size="sm" centered /></div>
      ) : versions.length === 0 ? (
        <div className="sidebar-section-empty">No version history yet</div>
      ) : (
        <div className="sidebar-versions-list">
          {versions.map((v) => (
            <div key={v.id} className="sidebar-version-item">
              <div className="sidebar-version-item__info">
                <span className="sidebar-version-item__date">
                  {v.created_at ? formatDate(new Date(v.created_at), dateFormat) : ''}
                </span>
              </div>
              <div className="sidebar-version-item__preview">
                {v.name ? v.name.substring(0, 80) || 'Empty' : 'Empty'}
              </div>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => handleRestore(v.id)}
                title="Restore this version"
                className="sidebar-version-item__restore"
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </NodeViewSection>
  );
}
