/**
 * Plugin Manager Modal
 *
 * Plugin catalog: lists installed plugins with name/version/description,
 * builtin vs external badges, restartless enable/disable toggles, per-plugin
 * settings, runtime load/unload/reload, update, and uninstall.
 * Plugins can be installed from a git URL or an uploaded ZIP archive, and
 * folders dropped manually into the plugins folder are picked up via rescan.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { BooleanToggle } from '@/components/ui/BooleanToggle';
import { getPluginsInfo } from '../api';
import { usePlugins } from '../hooks/usePlugins';
import { useInstallPlugin, useInstallPluginZip } from '../hooks/useInstallPlugin';
import { usePluginInstallJob } from '../hooks/usePluginInstallJob';
import { useLoadPlugin, useUnloadPlugin, useReloadPlugin } from '../hooks/usePluginRuntime';
import {
  useUninstallPlugin,
  useUpdatePlugin,
  useSetPluginEnabled,
  useRescanPlugins,
} from '../hooks/usePluginLifecycle';
import { pluginManager } from '../PluginManager';
import { PluginSettingsTab } from './PluginSettingsTab';
import type { PluginStatus } from '../manifest';
import './PluginManagerModal.css';

interface PluginManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PluginManagerModal({ isOpen, onClose }: PluginManagerModalProps) {
  const { data: plugins = [], isLoading: loading, refetch } = usePlugins(isOpen);
  const installMutation = useInstallPlugin();
  const zipInstallMutation = useInstallPluginZip();
  const rescanMutation = useRescanPlugins();
  const setEnabledMutation = useSetPluginEnabled();
  const loadMutation = useLoadPlugin();
  const unloadMutation = useUnloadPlugin();
  const reloadMutation = useReloadPlugin();
  const uninstallMutation = useUninstallPlugin();
  const updateMutation = useUpdatePlugin();
  const [gitUrl, setGitUrl] = useState('');
  const [uninstallTarget, setUninstallTarget] = useState<PluginStatus | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadedIds, setLoadedIds] = useState<Set<string>>(() => new Set());
  const zipInputRef = useRef<HTMLInputElement>(null);

  // Admin-only: exposes the server-side plugins folder path.
  const { data: pluginsInfo } = useQuery({
    queryKey: ['plugins', 'info'],
    queryFn: getPluginsInfo,
    enabled: isOpen,
    retry: false,
  });

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
    setNotice(null);
    setGitUrl('');
    setInstallJobId(null);
    setSettingsFor(null);
  }, [isOpen]);

  const togglePlugin = async (plugin: PluginStatus) => {
    setError(null);
    try {
      await setEnabledMutation.mutateAsync({ pluginId: plugin.id, enabled: !plugin.enabled });
      setLoadedIds((prev) => {
        const next = new Set(prev);
        if (plugin.enabled) {
          next.delete(plugin.id);
        } else if (pluginManager.isLoaded(plugin.id)) {
          next.add(plugin.id);
        }
        return next;
      });
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
      await pluginManager.refreshPlugins();
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

  const installFromZip = async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const result = await zipInstallMutation.mutateAsync(file);
      setNotice(`Installed ${result.name} ${result.version}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRescan = async () => {
    setError(null);
    setNotice(null);
    try {
      const result = await rescanMutation.mutateAsync();
      setNotice(
        result.added.length > 0
          ? `Found ${result.added.length} new plugin(s): ${result.added.join(', ')}`
          : 'No new plugins found in the plugins folder',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyPluginsPath = async () => {
    if (!pluginsInfo?.external_dir) return;
    try {
      await navigator.clipboard.writeText(pluginsInfo.external_dir);
      setNotice('Plugins folder path copied to clipboard');
    } catch {
      setError('Could not copy to clipboard');
    }
  };

  const installing =
    installMutation.isPending || installJobId !== null || zipInstallMutation.isPending;
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
        {notice && <div className="plugin-manager__notice">{notice}</div>}

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
              {installMutation.isPending || installJobId ? 'Installing…' : 'Install'}
            </Button>
          </div>
          {installProgress && (
            <p className="plugin-manager__progress">{installProgress}</p>
          )}

          <label htmlFor="plugin-zip-file">Install from ZIP archive</label>
          <div className="plugin-manager__install-row">
            <input
              id="plugin-zip-file"
              ref={zipInputRef}
              type="file"
              accept=".zip,application/zip"
              className="plugin-manager__file-input"
              aria-label="Plugin ZIP archive"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void installFromZip(file);
                e.target.value = '';
              }}
            />
            <Button
              icon="mdi mdi-folder-zip"
              onClick={() => zipInputRef.current?.click()}
              disabled={installing}
            >
              {zipInstallMutation.isPending ? 'Installing…' : 'Choose ZIP'}
            </Button>
          </div>
        </div>

        <div className="plugin-manager__folder">
          <span className="plugin-manager__meta">
            Plugins folder: {pluginsInfo?.external_dir ?? 'unknown'} — drop a plugin folder
            there, then rescan.
          </span>
          <div className="plugin-manager__folder-actions">
            {pluginsInfo?.external_dir && (
              <Button
                size="xs"
                variant="ghost"
                icon="mdi mdi-content-copy"
                aria-label="Copy plugins folder path"
                title="Copy path"
                onClick={copyPluginsPath}
              />
            )}
            <Button
              size="xs"
              variant="ghost"
              icon="mdi mdi-refresh"
              onClick={handleRescan}
              disabled={rescanMutation.isPending}
            >
              {rescanMutation.isPending ? 'Rescanning…' : 'Rescan folder'}
            </Button>
          </div>
        </div>

        {loading ? (
          <p>Loading plugins…</p>
        ) : (
          <ul className="plugin-manager__list">
            {plugins.map((plugin) => {
              const isLoaded = loadedIds.has(plugin.id);
              const hasSettings = (plugin.contributes?.settings?.length ?? 0) > 0;
              const isWorking =
                loadMutation.isPending && loadMutation.variables === plugin.id ||
                unloadMutation.isPending && unloadMutation.variables === plugin.id ||
                reloadMutation.isPending && reloadMutation.variables === plugin.id ||
                updateMutation.isPending && updateMutation.variables === plugin.id ||
                uninstallMutation.isPending && uninstallMutation.variables === plugin.id ||
                setEnabledMutation.isPending &&
                  setEnabledMutation.variables?.pluginId === plugin.id;

              return (
                <li key={plugin.id} className="plugin-manager__item">
                  <div className="plugin-manager__item-main">
                    <div className="plugin-manager__info">
                      <div className="plugin-manager__title-row">
                        <strong>{plugin.name}</strong>
                        <span
                          className={`plugin-manager__badge ${
                            plugin.builtin
                              ? 'plugin-manager__badge--builtin'
                              : 'plugin-manager__badge--external'
                          }`}
                        >
                          {plugin.builtin ? 'Built-in' : 'External'}
                        </span>
                        {isLoaded && (
                          <span className="plugin-manager__badge plugin-manager__badge--loaded">
                            Loaded
                          </span>
                        )}
                      </div>
                      <span className="plugin-manager__meta">
                        v{plugin.version}
                        {plugin.author ? ` · ${plugin.author}` : ''}
                      </span>
                      {plugin.description && (
                        <span className="plugin-manager__description">{plugin.description}</span>
                      )}
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
                      {hasSettings && (
                        <Button
                          size="xs"
                          variant="ghost"
                          icon="mdi mdi-cog"
                          aria-label="Plugin settings"
                          onClick={() =>
                            setSettingsFor(settingsFor === plugin.id ? null : plugin.id)
                          }
                          disabled={isWorking}
                          title="Settings"
                        />
                      )}
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
                  </div>
                  {settingsFor === plugin.id && hasSettings && (
                    <div className="plugin-manager__settings">
                      <PluginSettingsTab pluginId={plugin.id} />
                    </div>
                  )}
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
