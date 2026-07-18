import { useState, useCallback } from 'react';
import { NodeViewSection } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Icon } from '@/components/ui/icons';
import { useSettingsStore, formatDate } from '@/stores';
import { useNotifications } from '@/stores/notificationStore';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import type { NodeVersion } from '@/types/api';

interface SidebarVersionsProps {
  nodeUuid: string;
}

export function SidebarVersions({ nodeUuid }: SidebarVersionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [versions] = useState<NodeVersion[]>([]);
  const [loading] = useState(false);
  const dateFormat = useSettingsStore(s => s.dateFormat);
  const queryClient = useQueryClient();
  const { error: notifyError } = useNotifications();

  const handleRestore = useCallback(async (_versionUuid: string) => {
    // Version restore is not implemented in the local-first operation-log core.
    // The operation log itself is the authoritative history; a future feature
    // can expose per-operation restore points here.
    queryClient.invalidateQueries({ queryKey: nodeKeys.byUuid(nodeUuid) });
    notifyError('Not implemented', 'Version restore is not yet available in the local-first core.');
  }, [nodeUuid, queryClient, notifyError]);

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
          {versions.map(({ uuid: versionUuid, created_at, name }) => (
            <div key={versionUuid} className="sidebar-version-item">
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
