/**
 * Export Profiles settings tab: profile list, editor, and run actions.
 *
 * Lives inside the plugin's settings tab (plugin enablement is the on/off
 * toggle). All state changes go through the plugin's backend API; the
 * backend owns continuous reconciliation.
 */

import { useCallback, useEffect, useState } from 'react';

import apiClient from '@/api/client';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { useNotificationStore } from '@/stores/notificationStore';
import { getApiErrorMessage } from '@/utils/apiError';

import './ExportProfilesTab.css';
import {
  emptyFormState,
  formToProfile,
  ProfileFormError,
  profileToForm,
  ROLE_OPTIONS,
  type ProfileFormState,
  type SelectionMode,
} from '../profileForm';
import type {
  ClassOption,
  CollectionOption,
  ProfileListItem,
  RunReport,
} from '../types';

const API_BASE = '/plugins/notees.export_profiles';

const SELECTION_MODES: Array<{ id: SelectionMode; label: string }> = [
  { id: 'class', label: 'Class' },
  { id: 'collection', label: 'Collection' },
  { id: 'saved_query', label: 'Saved query' },
  { id: 'ast', label: 'Query AST' },
];

function reportSummary(report: RunReport | null): string {
  if (!report) return 'Never run';
  const parts = [`${report.file_count} files`];
  if (report.created.length) parts.push(`${report.created.length} created`);
  if (report.updated.length) parts.push(`${report.updated.length} updated`);
  if (report.deleted.length) parts.push(`${report.deleted.length} deleted`);
  if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
  if (report.errors.length) parts.push(`${report.errors.length} errors`);
  if (report.conflicts.length) parts.push(`${report.conflicts.length} conflicts`);
  return parts.join(' · ');
}

export function ExportProfilesTab() {
  const notifications = () => useNotificationStore.getState();
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [exportRoot, setExportRoot] = useState('');
  const [form, setForm] = useState<ProfileFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProfileListItem | null>(null);
  const [busyProfile, setBusyProfile] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [profilesRes, classesRes, collectionsRes, settingsRes] = await Promise.all([
        apiClient.get<{ profiles: ProfileListItem[] }>(`${API_BASE}/profiles`),
        apiClient.get<{ classes: ClassOption[] }>(`${API_BASE}/options/classes`),
        apiClient.get<{ collections: CollectionOption[] }>(`${API_BASE}/options/collections`),
        apiClient.get<{ export_root: string | null }>(`${API_BASE}/settings`),
      ]);
      setProfiles(profilesRes.data.profiles);
      setClasses(classesRes.data.classes);
      setCollections(collectionsRes.data.collections);
      setExportRoot(settingsRes.data.export_root ?? '');
    } catch (error) {
      notifications().error(
        'Failed to load export profiles',
        getApiErrorMessage(error, 'Please try again.'),
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveProfile = async () => {
    if (!form) return;
    setFormError(null);
    let payload: ReturnType<typeof formToProfile>;
    try {
      payload = formToProfile(form);
    } catch (error) {
      setFormError(error instanceof ProfileFormError ? error.message : String(error));
      return;
    }
    try {
      if (form.id) {
        await apiClient.put(`${API_BASE}/profiles/${form.id}`, payload);
      } else {
        await apiClient.post(`${API_BASE}/profiles`, payload);
      }
      setForm(null);
      notifications().success('Profile saved', 'The export tree was reconciled.');
      await refresh();
    } catch (error) {
      setFormError(getApiErrorMessage(error, 'Could not save the profile.'));
    }
  };

  const runNow = async (profile: ProfileListItem) => {
    setBusyProfile(profile.id);
    try {
      const res = await apiClient.post<{ reports: RunReport[] }>(
        `${API_BASE}/profiles/${profile.id}/run`,
        {},
      );
      const report = res.data.reports[0];
      notifications().success('Export finished', report ? reportSummary(report) : undefined);
      await refresh();
    } catch (error) {
      notifications().error('Export failed', getApiErrorMessage(error, 'Please try again.'));
    } finally {
      setBusyProfile(null);
    }
  };

  const downloadZip = async (profile: ProfileListItem) => {
    setBusyProfile(profile.id);
    try {
      const response = await apiClient.get<Blob>(
        `${API_BASE}/profiles/${profile.id}/zip`,
        { responseType: 'blob' },
      );
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${profile.slug}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notifications().error('ZIP export failed', getApiErrorMessage(error, 'Please try again.'));
    } finally {
      setBusyProfile(null);
    }
  };

  const toggleEnabled = async (profile: ProfileListItem) => {
    try {
      const { slug: _slug, last_run: _lastRun, report: _report, ...payload } = profile;
      await apiClient.put(`${API_BASE}/profiles/${profile.id}`, {
        ...payload,
        enabled: !profile.enabled,
      });
      await refresh();
    } catch (error) {
      notifications().error('Could not update profile', getApiErrorMessage(error, 'Please try again.'));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.delete(`${API_BASE}/profiles/${deleteTarget.id}`);
      notifications().success('Profile deleted', 'Managed files were removed.');
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      notifications().error('Could not delete profile', getApiErrorMessage(error, 'Please try again.'));
    }
  };

  const saveExportRoot = async () => {
    try {
      await apiClient.put(`${API_BASE}/settings`, { export_root: exportRoot || null });
      notifications().success('Export root saved');
    } catch (error) {
      notifications().error('Could not save export root', getApiErrorMessage(error, 'Please try again.'));
    }
  };

  return (
    <div className="export-profiles">
      <p className="export-profiles__intro">
        Export profiles keep a folder of source files continuously in sync with a
        query-selected set of sources. Files land under your per-user export root
        (<code>&lt;export_root&gt;/&lt;you&gt;/&lt;profile&gt;/…</code>) and update
        automatically when sources, attachments, or metadata change.
      </p>

      <section className="export-profiles__section">
        <h3>Profiles</h3>
        {profiles.length === 0 && <p className="export-profiles__empty">No profiles yet.</p>}
        <ul className="export-profiles__list">
          {profiles.map((profile) => (
            <li key={profile.id} className="export-profiles__item">
              <div className="export-profiles__item-main">
                <label className="export-profiles__item-title">
                  <Checkbox
                    checked={profile.enabled}
                    onChange={() => void toggleEnabled(profile)}
                    aria-label={`Enable profile ${profile.name}`}
                  />
                  <span className="export-profiles__item-name">{profile.name}</span>
                  <code className="export-profiles__slug">{profile.slug}</code>
                </label>
                <div className="export-profiles__item-status">
                  {profile.last_run
                    ? `Last run ${new Date(profile.last_run).toLocaleString()} — ${reportSummary(profile.report)}`
                    : reportSummary(profile.report)}
                </div>
                {profile.report && profile.report.skipped.length > 0 && (
                  <details className="export-profiles__skipped">
                    <summary>
                      {profile.report.skipped.length} sources without matching attachments
                    </summary>
                    <ul>
                      {profile.report.skipped.map((skip) => (
                        <li key={skip.node_uuid}>{skip.title || skip.node_uuid}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {profile.report && profile.report.errors.length > 0 && (
                  <div className="export-profiles__errors">
                    {profile.report.errors.map((entry, index) => (
                      <div key={index}>
                        {entry.relative_path || 'profile'}: {entry.reason}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="export-profiles__item-actions">
                <Button
                  size="sm"
                  onClick={() => void runNow(profile)}
                  disabled={busyProfile === profile.id}
                >
                  Export now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void downloadZip(profile)}
                  disabled={busyProfile === profile.id}
                >
                  ZIP
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setForm(profileToForm(profile))}>
                  Edit
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDeleteTarget(profile)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {!form && (
          <Button variant="primary" size="sm" onClick={() => setForm(emptyFormState())}>
            New profile
          </Button>
        )}
      </section>

      {form && (
        <section className="export-profiles__section export-profiles__editor">
          <h3>{form.id ? 'Edit profile' : 'New profile'}</h3>
          <div className="export-profiles__field">
            <label htmlFor="ep-name">Name</label>
            <input
              id="ep-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="My books"
            />
          </div>
          <div className="export-profiles__field">
            <label htmlFor="ep-selection">Selection</label>
            <select
              id="ep-selection"
              value={form.selectionMode}
              onChange={(event) =>
                setForm({ ...form, selectionMode: event.target.value as SelectionMode })
              }
            >
              {SELECTION_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </div>
          {form.selectionMode === 'class' && (
            <div className="export-profiles__field">
              <label htmlFor="ep-class">Class</label>
              <select
                id="ep-class"
                value={form.classUuid}
                onChange={(event) => setForm({ ...form, classUuid: event.target.value })}
              >
                <option value="">Pick a class…</option>
                {classes.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {form.selectionMode === 'collection' && (
            <div className="export-profiles__field">
              <label htmlFor="ep-collection">Collection</label>
              <select
                id="ep-collection"
                value={form.collectionUuid}
                onChange={(event) => setForm({ ...form, collectionUuid: event.target.value })}
              >
                <option value="">Pick a collection…</option>
                {collections.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {form.selectionMode === 'saved_query' && (
            <div className="export-profiles__field">
              <label htmlFor="ep-saved-query">Saved query id</label>
              <input
                id="ep-saved-query"
                value={form.savedQueryId}
                onChange={(event) => setForm({ ...form, savedQueryId: event.target.value })}
              />
            </div>
          )}
          {form.selectionMode === 'ast' && (
            <div className="export-profiles__field">
              <label htmlFor="ep-ast">Query AST (JSON)</label>
              <textarea
                id="ep-ast"
                rows={6}
                value={form.astJson}
                onChange={(event) => setForm({ ...form, astJson: event.target.value })}
              />
            </div>
          )}
          <div className="export-profiles__field">
            <label htmlFor="ep-template">Filename template</label>
            <input
              id="ep-template"
              value={form.filenameTemplate}
              onChange={(event) => setForm({ ...form, filenameTemplate: event.target.value })}
              placeholder="/{class}/{citekey}.{ext}"
            />
            <small>
              Tokens: {'{author} {title} {year} {citekey} {class} {ext}'} plus any
              same-named user property (e.g. {'{series}'}).
            </small>
          </div>
          <div className="export-profiles__field">
            <label htmlFor="ep-destination">Destination (relative)</label>
            <input
              id="ep-destination"
              value={form.destination}
              onChange={(event) => setForm({ ...form, destination: event.target.value })}
              placeholder="(profile root)"
            />
          </div>
          <fieldset className="export-profiles__field">
            <legend>Attachment roles</legend>
            <div className="export-profiles__roles">
              {ROLE_OPTIONS.map((role) => (
                <label key={role}>
                  <Checkbox
                    checked={form.roles.includes(role)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        roles: event.target.checked
                          ? [...form.roles, role]
                          : form.roles.filter((entry) => entry !== role),
                      })
                    }
                  />
                  {role}
                </label>
              ))}
            </div>
            <small>No selection = all roles.</small>
          </fieldset>
          <div className="export-profiles__field">
            <label htmlFor="ep-mimes">MIME types (comma-separated, empty = all)</label>
            <input
              id="ep-mimes"
              value={form.mimeTypes}
              onChange={(event) => setForm({ ...form, mimeTypes: event.target.value })}
              placeholder="application/epub+zip, application/pdf"
            />
          </div>
          <div className="export-profiles__field">
            <label htmlFor="ep-enabled">Enabled (continuously reconciled)</label>
            <Checkbox
              id="ep-enabled"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
          </div>
          {formError && <div className="export-profiles__form-error">{formError}</div>}
          <div className="export-profiles__editor-actions">
            <Button variant="primary" size="sm" onClick={() => void saveProfile()}>
              Save profile
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      <section className="export-profiles__section">
        <h3>Export root</h3>
        <div className="export-profiles__field">
          <label htmlFor="ep-root">Custom export root (empty = default)</label>
          <input
            id="ep-root"
            value={exportRoot}
            onChange={(event) => setExportRoot(event.target.value)}
            placeholder="data/users/<you>/exports"
          />
          <small>
            Exports land in <code>&lt;root&gt;/&lt;your user id&gt;/&lt;profile&gt;/…</code>.
          </small>
        </div>
        <Button size="sm" onClick={() => void saveExportRoot()}>
          Save export root
        </Button>
      </section>

      <ConfirmationModal
        isOpen={deleteTarget !== null}
        title="Delete export profile?"
        message={`This deletes the profile "${deleteTarget?.name ?? ''}" and its engine-managed export files. Foreign files in the folder are kept.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
