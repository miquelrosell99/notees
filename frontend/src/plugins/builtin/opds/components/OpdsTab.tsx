/**
 * OPDS Catalog settings tab: feed URL, selection, and served classes.
 *
 * Plugin enablement is the on/off toggle; this tab shows how to point an
 * OPDS client (KOReader, Panels, …) at the catalog and which sources it
 * serves. Authentication is per user — OPDS clients use HTTP Basic with the
 * Notees account credentials.
 */

import { useCallback, useEffect, useState } from 'react';

import apiClient from '@/api/client';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { useNotificationStore } from '@/stores/notificationStore';
import { getApiErrorMessage } from '@/utils/apiError';

import type { OpdsInfo, OpdsSettings } from '../types';

import './OpdsTab.css';

const API_BASE = '/plugins/notees.opds';

export function OpdsTab() {
  const notifications = () => useNotificationStore.getState();
  const [info, setInfo] = useState<OpdsInfo | null>(null);
  const [savedQueryId, setSavedQueryId] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [infoRes, settingsRes] = await Promise.all([
        apiClient.get<OpdsInfo>(`${API_BASE}/info`),
        apiClient.get<OpdsSettings>(`${API_BASE}/settings`),
      ]);
      setInfo(infoRes.data);
      setSavedQueryId(settingsRes.data.saved_query_id ?? '');
    } catch (error) {
      notifications().error(
        'Failed to load OPDS catalog info',
        getApiErrorMessage(error, 'Please try again.'),
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSelection = async () => {
    setSaving(true);
    try {
      await apiClient.put(`${API_BASE}/settings`, {
        saved_query_id: savedQueryId.trim() || null,
      });
      notifications().success('OPDS selection saved', 'The catalog now uses the new selection.');
      await refresh();
    } catch (error) {
      notifications().error(
        'Could not save the OPDS selection',
        getApiErrorMessage(error, 'Please try again.'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="opds-tab">
      <p className="opds-tab__intro">
        Serve your sources as an OPDS 1.2 catalog for ereader clients such as KOReader. The
        catalog lists sources with downloadable attachments (role <em>representation</em>, or
        unroled); attachment-less sources are simply absent. Enable or disable the plugin itself
        from the plugin catalog.
      </p>

      <section className="opds-tab__section">
        <h3>Feed URL</h3>
        {info ? (
          <>
            <code className="opds-tab__feed-url">{info.feed_url}</code>
            <p className="opds-tab__hint">
              Point your OPDS client at this URL and sign in with your Notees email and password
              (HTTP Basic authentication). The catalog only exposes content in your active
              workspace.
            </p>
          </>
        ) : (
          <p className="opds-tab__hint">Loading…</p>
        )}
      </section>

      <section className="opds-tab__section">
        <h3>Selection</h3>
        <p className="opds-tab__hint">
          {info?.selection.kind === 'saved_query'
            ? 'The catalog serves the sources matched by a saved query — the same selection mechanism as export profiles.'
            : 'The catalog serves every source in the workspace (default).'}
        </p>
        <TextField
          label="Saved query node UUID (empty = all sources)"
          value={savedQueryId}
          onChange={(event) => setSavedQueryId(event.target.value)}
          placeholder="e.g. 018f…"
        />
        <div>
          <Button onClick={() => void saveSelection()} disabled={saving}>
            {saving ? 'Saving…' : 'Save selection'}
          </Button>
        </div>
      </section>

      <section className="opds-tab__section">
        <h3>Contents</h3>
        {info ? (
          info.publication_count > 0 ? (
            <ul className="opds-tab__list">
              <li className="opds-tab__item">
                <span>All publications</span>
                <span>{info.publication_count}</span>
              </li>
              {info.classes.map((cls) => (
                <li key={cls.name} className="opds-tab__item">
                  <span>{cls.name}</span>
                  <span>{cls.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="opds-tab__empty">
              No publications yet — attach a downloadable file (EPUB, PDF, …) to a source and it
              will appear here.
            </p>
          )
        ) : (
          <p className="opds-tab__hint">Loading…</p>
        )}
      </section>
    </div>
  );
}
