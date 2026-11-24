/**
 * CalendarsSection — Settings → Calendars: manage the workspace's ONE-WAY
 * iCal subscriptions (the server module calendar-subscriptions.ts owns the
 * semantics). Add a feed (URL + optional name/timezone), see each
 * subscription's last refresh status, refresh now, remove (ingested events
 * stay — ordinary graph content). Server-backed rows (owner/admin gated
 * server-side); the section is honest offline — a failed list read shows
 * the error line instead of a lying empty state.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/kit/Button.js";
import { Card } from "../../components/ui/kit/Card.js";
import { readStored, STORAGE_KEYS } from "../../ui/app/storage.js";

interface Subscription {
  id: string;
  url: string;
  name: string;
  timezone: string;
  refreshMinutes: number;
  lastFetchedAt: number | null;
  lastStatus: string | null;
}

export function CalendarsSection({
  serverUrl,
  token,
}: {
  serverUrl: string;
  token: string;
}) {
  const workspaceId = readStored(STORAGE_KEYS.workspaceId);
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${serverUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    },
    [serverUrl, token],
  );

  const reload = useCallback(async () => {
    try {
      const body = await request<{ subscriptions: Subscription[] }>(
        `/api/calendars?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      setSubscriptions(body.subscriptions);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [request, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    if (url.trim() === "" || busy) return;
    setBusy(true);
    try {
      await request("/api/calendars", {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          url: url.trim(),
          ...(name.trim() !== "" ? { name: name.trim() } : {}),
        }),
      });
      setUrl("");
      setName("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (id: string) => {
    try {
      await request(`/api/calendars/${id}/refresh`, { method: "POST" });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async (id: string) => {
    try {
      await request(`/api/calendars/${id}`, { method: "DELETE" });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section__title">Calendars</h3>
      <Card>
        <div className="settings-item">
          <div className="settings-item__info">
            <label htmlFor="calendar-feed-url" className="settings-item__label">
              Subscribe to a calendar
            </label>
            <p className="settings-item__description">
              A one-way iCal feed (a Google secret iCal URL, a Nextcloud calendar, any
              .ics): events import as event pages and refresh automatically. Removing a
              subscription keeps the imported events.
            </p>
          </div>
        </div>
        <div className="settings-item">
          <input
            id="calendar-feed-url"
            className="settings-item__select"
            type="url"
            placeholder="https://…/calendar.ics"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <input
            aria-label="Calendar name (optional)"
            className="settings-item__select"
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button size="sm" onClick={() => void add()} disabled={busy || url.trim() === ""}>
            {busy ? "Subscribing…" : "Subscribe"}
          </Button>
        </div>

        {error !== null && (
          <p className="settings-section__subtitle" role="alert">
            {error}
          </p>
        )}

        {subscriptions !== null && subscriptions.length === 0 && error === null && (
          <p className="settings-section__subtitle">No calendar subscriptions yet.</p>
        )}

        {subscriptions?.map((subscription) => (
          <div className="settings-item" key={subscription.id}>
            <div className="settings-item__info">
              <span className="settings-item__label">{subscription.name}</span>
              <p className="settings-item__description">
                {subscription.url} · every {subscription.refreshMinutes} min ·{" "}
                {subscription.lastStatus ?? "never refreshed"}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void refresh(subscription.id)}>
              Refresh
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void remove(subscription.id)}>
              Remove
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
