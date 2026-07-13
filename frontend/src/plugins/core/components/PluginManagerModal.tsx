/**
 * Plugin Manager Modal
 *
 * Lists installed plugins, shows their status, and allows enabling/disabling,
 * runtime load/unload/reload, updating, and uninstalling.
 * User-installed plugins can be installed from a git URL.
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { BooleanToggle } from '@/components/ui/BooleanToggle';
import api from '@/api/client';
import { usePlugins } from '../hooks/usePlugins';
import { useInstallPlugin } from '../hooks/useInstallPlugin';
import { usePluginInstallJob } from '../hooks/usePluginInstallJob';
import { useLoadPlugin, useUnloadPlugin, useReloadPlugin } from '../hooks/usePluginRuntime';
import { useUninstallPlugin, useUpdatePlugin } from '../hooks/usePluginLifecycle';
import { pluginManager } from '../PluginManager';
import type { PluginStatus } from '../manifest';
import './PluginManagerModal.css';

interface PluginManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PluginManagerModal({ isOpen, onClose }: PluginManagerModalProps) {
  const { data: plugins = [], isLoading: loading, refetch } = usePlugins(isOpen);
  const installMutation = useInstallPlugin();
  const loadMutation = useLoadPlugin();
  const unloadMutation = useUnloadPlugin();
  const reloadMutation = useReloadPlugin();
  const uninstallMutation = useUninstallPlugin();
  const updateMutation = useUpdatePlugin();
  const [gitUrl, setGitUrl] = useState('');
  const [uninstallTarget, setUninstallTarget] = useState<PluginStatus | null>(null);
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedIds, setLoadedIds] = useState<Set<string>>(() => new Set());

  const { data: installJob } = usePluginInstallJob(installJobId);

  useEffect(() => {
    if (!isOpen) return;
    setLoadedIds(new Set(plugins.filter((p) => pluginManager.isLoaded(p.id)).map((p) => p.id)));
  }, [isOpen, plugins]);

  useEffect(() => {
    if (!installJob) return;

    if (installJob.status === 'completed') {
      setInstallJobId(null);
      setGitUrl('');
      setError(null);
      refetch();
    } else if (installJob.status === 'failed') {
      setInstallJobId(null);
      setError(installJob.error ?? 'Plugin installation failed');
    }
  }, [installJob, refetch]);

  useEffect(() => {
    if (isOpen) return;
    setError(null);
    setGitUrl('');
    setInstallJobId(null);
  }, [isOpen]);

  const togglePlugin = async (plugin: PluginStatus) => {
    const endpoint = plugin.enabled ? '/disable' : '/enable';
    try {
      await api.post(`/plugins/${plugin.id}${endpoint}`);
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLoad = async (pluginId: string) => {
    setError(null);
    try {
      await loadMutation.mutateAsync(pluginId);
      setLoadedIds((prev) => new Set([...prev, pluginId]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUnload = async (pluginId: string) => {
    setError(null);
    try {
      await unloadMutation.mutateAsync(pluginId);
      setLoadedIds((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReload = async (pluginId: string) => {
    setError(null);
    try {
      await reloadMutation.mutateAsync(pluginId);
      setLoadedIds((prev) => new Set([...prev, pluginId]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdate = async (pluginId: string) => {
    setError(null);
    try {
      await updateMutation.mutateAsync(pluginId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUninstall = (plugin: PluginStatus) => {
    setUninstallTarget(plugin);
  };

  const confirmUninstall = async () => {
    if (!uninstallTarget) return;
    setError(null);
    try {
      await uninstallMutation.mutateAsync(uninstallTarget.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUninstallTarget(null);
    }
  };

  const installFromGit = async () => {
    if (!gitUrl.trim()) return;
    setError(null);
    try {
      const result = await installMutation.mutateAsync({ url: gitUrl.trim() });
      setInstallJobId(result.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const installing = installMutation.isPending || installJobId !== null;
  const installProgress = installJob?.progress ?? (installMutation.isPending ? 'Starting…' : null);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Plugin Manager"
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="plugin-manager">
        {error && <div className="plugin-manager__error">{error}</div>}

        <div className="plugin-manager__install">
          <label htmlFor="plugin-git-url">Install from git URL</label>
          <div className="plugin-manager__install-row">
            <input
              id="plugin-git-url"
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/user/notees-plugin"
              disabled={installing}
            />
            <Button onClick={installFromGit} disabled={installing || !gitUrl.trim()}>
              {installMutation.isPending ? 'Installing…' : installJobId ? 'Installing…' : 'Install'}
            </Button>
          </div>
          {installProgress && (
            <p className="plugin-manager__progress">{installProgress}</p>
          )}
        </div>

        {loading ? (
          <p>Loading plugins…</p>
        ) : (
          <ul className="plugin-manager__list">
            {plugins.map((plugin) => {
              const isLoaded = loadedIds.has(plugin.id);
              const isWorking =
                loadMutation.isPending && loadMutation.variables === plugin.id ||
                unloadMutation.isPending && unloadMutation.variables === plugin.id ||
                reloadMutation.isPending && reloadMutation.variables === plugin.id ||
                updateMutation.isPending && updateMutation.variables === plugin.id ||
                uninstallMutation.isPending && uninstallMutation.variables === plugin.id;

              return (
                <li key={plugin.id} className="plugin-manager__item">
                  <div className="plugin-manager__info">
                    <strong>{plugin.name}</strong>
                    <span className="plugin-manager__meta">
                      {plugin.version} · {plugin.builtin ? 'built-in' : 'user'}
                      {isLoaded ? ' · loaded' : ''}
                    </span>
                    {plugin.backendSetupFailed && (
                      <span className="plugin-manager__error-badge">
                        backend error: {plugin.backendError}
                      </span>
                    )}
                    {plugin.frontendSetupFailed && (
                      <span className="plugin-manager__error-badge">
                        frontend error: {plugin.frontendError}
                      </span>
                    )}
                  </div>
                  <div className="plugin-manager__actions">
                    {plugin.enabled && !isLoaded && (
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="mdi mdi-play"
                        aria-label="Load"
                        onClick={() => handleLoad(plugin.id)}
                        disabled={isWorking}
                        title="Load"
                      />
                    )}
                    {isLoaded && (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          icon="mdi mdi-refresh"
                          aria-label="Reload"
                          onClick={() => handleReload(plugin.id)}
                          disabled={isWorking}
                          title="Reload"
                        />
                        <Button
                          size="xs"
                          variant="ghost"
                          icon="mdi mdi-stop"
                          aria-label="Unload"
                          onClick={() => handleUnload(plugin.id)}
                          disabled={isWorking}
                          title="Unload"
                        />
                      </>
                    )}
                    {!plugin.builtin && (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          icon="mdi mdi-update"
                          aria-label="Update"
                          onClick={() => handleUpdate(plugin.id)}
                          disabled={isWorking}
                          title="Update"
                        />
                        <Button
                          size="xs"
                          variant="ghost"
                          icon="mdi mdi-trash-can"
                          aria-label="Uninstall"
                          onClick={() => handleUninstall(plugin)}
                          disabled={isWorking}
                          title="Uninstall"
                        />
                      </>
                    )}
                    <BooleanToggle
                      checked={plugin.enabled}
                      onChange={() => togglePlugin(plugin)}
                      label={plugin.enabled ? 'Enabled' : 'Disabled'}
                      labelPosition="left"
                      disabled={isWorking}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmationModal
        isOpen={uninstallTarget !== null}
        title="Uninstall Plugin"
        message={`Uninstall ${uninstallTarget?.name ?? ''}?`}
        secondaryMessage="This cannot be undone."
        confirmLabel="Uninstall"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmUninstall}
        onCancel={() => setUninstallTarget(null)}
      />
    </Modal>
  );
}
