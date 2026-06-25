import { useState, useEffect, useCallback } from 'react';
import { NodeViewSection } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Icon } from '@/components/ui/icons';
import { getNodeVersions, restoreNodeVersion, type NodeVersion } from '@/api/nodes';
import { useSettingsStore, formatDate } from '@/stores';
import { useNotifications } from '@/stores/notificationStore';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';

interface SidebarVersionsProps {
  nodeUuid: string;
}

export function SidebarVersions({ nodeUuid }: SidebarVersionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<NodeVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const dateFormat = useSettingsStore(s => s.dateFormat);
  const queryClient = useQueryClient();
  const { success: notifySuccess, error: notifyError } = useNotifications();

  useEffect(() => {
    if (expanded && nodeUuid) {
      setLoading(true);
      getNodeVersions(nodeUuid, 30)
        .then(v => setVersions(v))
        .catch(() => setVersions([]))
        .finally(() => setLoading(false));
    }
  }, [expanded, nodeUuid]);

  const handleRestore = useCallback(async (versionUuid: string) => {
    try {
      await restoreNodeVersion(nodeUuid, versionUuid);
      queryClient.invalidateQueries({ queryKey: nodeKeys.byUuid(nodeUuid) });
      notifySuccess('Version restored', 'The node content has been restored.');
      getNodeVersions(nodeUuid, 30).then(setVersions).catch(() => {});
    } catch {
      notifyError('Failed to restore', 'Could not restore this version.');
    }
  }, [nodeUuid, queryClient, notifySuccess, notifyError]);

  return (
    <NodeViewSection
      title="Version History"
      icon={<Icon path={"mdi mdi-history"} size={0.6} />}
      count={expanded ? versions.length : undefined}
      expanded={expanded}
      onExpandedChange={setExpanded}
      className="sidebar-context-section sidebar-context-section--versions"
      variant="sidebar"
      hideWhenEmpty={false}
    >
      {loading ? (
        <div className="sidebar-section-loading"><Spinner size="sm" centered /></div>
      ) : versions.length === 0 ? (
        <div className="sidebar-section-empty">No version history yet</div>
      ) : (
        <div className="sidebar-versions-list">
          {versions.map(({ id, uuid: versionUuid, created_at, name }) => (
            <div key={id} className="sidebar-version-item">
              <div className="sidebar-version-item__info">
                <span className="sidebar-version-item__date">
                  {created_at ? formatDate(new Date(created_at), dateFormat) : ''}
                </span>
              </div>
              <div className="sidebar-version-item__preview">
                {name ? name.substring(0, 80) || 'Empty' : 'Empty'}
              </div>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => handleRestore(versionUuid)}
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
