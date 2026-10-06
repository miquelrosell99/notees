/**
 * PluginsSettingsTab — the Workspace Settings → Plugins tab.
 *
 * Management surface over the server's inert plugin registry: lists
 * installed manifests (name, version, capability summary, enable toggle),
 * and offers an "Install manifest…" paste-JSON affordance with client-side
 * validation errors from the protocol's strict manifest schema (fail loud
 * before the network round trip).
 *
 * Honest about the parked runtime: the toggle flips a bit
 * nothing reads yet, and installing stores a manifest nothing executes.
 */

import { useCallback, useEffect, useState } from "react";

import {
  safeParsePluginManifest,
  summarizeCapabilities,
} from "@notees/protocol";

import { Button } from "../ui/Button.js";
import { CodeTextarea } from "../ui/CodeTextarea.js";
import { EmptyState } from "../ui/EmptyState.js";
import { InlineConfirmButton } from "../ui/InlineConfirmButton.js";
import { ToggleSwitch } from "../ui/ToggleSwitch.js";
import {
  installPlugin,
  listPlugins,
  setPluginEnabled,
  uninstallPlugin,
  type PluginListEntry,
} from "./pluginsApi.js";

export interface PluginsSettingsTabProps {
  serverUrl: string;
  credential: string;
}

const MAX_ISSUES_SHOWN = 4;

export function PluginsSettingsTab({ serverUrl, credential }: PluginsSettingsTabProps) {
  const [plugins, setPlugins] = useState<PluginListEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [installIssues, setInstallIssues] = useState<string[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listPlugins(serverUrl, credential);
      setPlugins(result.plugins);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  }, [serverUrl, credential]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = async () => {
    setInstallIssues([]);
    setInstallError(null);
    setInstallNote(null);

    // Client-side fail-loud validation, same grammar the server enforces.
    let json: unknown;
    try {
      json = JSON.parse(paste);
    } catch {
      setInstallIssues(["The pasted text is not valid JSON."]);
      return;
    }
    const parsed = safeParsePluginManifest(json);
    if (!parsed.success) {
      setInstallIssues(
        parsed.error.issues
          .slice(0, MAX_ISSUES_SHOWN)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      );
      return;
    }

    setInstalling(true);
    try {
      const result = await installPlugin(serverUrl, credential, parsed.data);
      setInstallNote(
        result.alreadyInstalled
          ? `"${result.plugin.name}" ${result.plugin.version} was already installed.`
          : `Installed "${result.plugin.name}" ${result.plugin.version}.`,
      );
      setPaste("");
      await refresh();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
    }
  };

  const handleToggle = async (entry: PluginListEntry, enabled: boolean) => {
    setBusyId(entry.id);
    try {
      await setPluginEnabled(serverUrl, credential, entry.id, enabled);
      await refresh();
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const handleUninstall = async (entry: PluginListEntry) => {
    setBusyId(entry.id);
    try {
      await uninstallPlugin(serverUrl, credential, entry.id);
      await refresh();
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section__title">Plugins</h3>
      <p className="settings-item__description">
        Installed plugin manifests live on the sync server. The plugin runtime
        that would execute them is not built yet — installing stores a
        validated manifest and an enable flag, nothing more.
      </p>

      {listError !== null && <div className="settings-error">{listError}</div>}

      {plugins === null ? (
        <p className="settings-item__description">Loading…</p>
      ) : plugins.length === 0 ? (
        <EmptyState
          title="No plugins installed"
          description="Paste a plugin manifest below to install one."
        />
      ) : (
        plugins.map((entry) => {
          const summary = summarizeCapabilities(entry.manifest);
          return (
            <div className="settings-item settings-feature-row" key={`${entry.id}@${entry.version}`}>
              <span className="settings-feature-row__text">
                <span className="settings-feature-row__title">
                  {entry.name} <span className="settings-feature-row__powers">{entry.version}</span>
                </span>
                <span className="settings-feature-row__powers">
                  {entry.id}
                  {summary !== null ? ` — ${summary}` : " — no capabilities declared"}
                </span>
              </span>
              <ToggleSwitch
                id={`plugin-enabled-${entry.id}`}
                leftLabel="Off"
                rightLabel="On"
                checked={entry.enabled}
                onChange={(next) => void handleToggle(entry, next)}
                disabled={busyId !== null}
                size="sm"
                aria-label={`${entry.name} enabled`}
              />
              <InlineConfirmButton
                onConfirm={() => handleUninstall(entry)}
                variant="ghost"
                size="sm"
                title={`Uninstall ${entry.name}`}
                disabled={busyId !== null}
              >
                Uninstall
              </InlineConfirmButton>
            </div>
          );
        })
      )}

      <h3 className="settings-section__title settings-section__title--spaced">Install manifest</h3>
      <p className="settings-item__description">
        Paste a plugin manifest JSON (manifestVersion 1). It is validated
        against the protocol grammar before anything is stored.
      </p>
      <CodeTextarea
        id="plugin-manifest-paste"
        label="Plugin manifest JSON"
        value={paste}
        onChange={setPaste}
        placeholder='{"manifestVersion": 1, "id": "com.example.plugin", …}'
        minHeight={140}
        error={installIssues.length > 0 || installError !== null}
      />
      {installIssues.map((issue) => (
        <div className="settings-error" key={issue} role="alert">
          {issue}
        </div>
      ))}
      {installError !== null && (
        <div className="settings-error" role="alert">
          {installError}
        </div>
      )}
      {installNote !== null && <div className="settings-success">{installNote}</div>}
      <div className="settings-item">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleInstall()}
          disabled={installing || paste.trim() === ""}
        >
          {installing ? "Installing…" : "Install manifest"}
        </Button>
      </div>
    </div>
  );
}
