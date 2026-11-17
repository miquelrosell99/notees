import { useCallback, useEffect, useState } from "react";
import { createBridge } from "../bridge/client";
import { createSettingsStore } from "../settings/store";
import {
  bodyBibliographyWriter,
  describeBibliographyOutcome,
  insertOrReplaceBibliography,
} from "../word/bibliography";
import { insertCitationField, scanDocument } from "../word/document";
import { describeRefreshOutcome, describeRestyleOutcome, refreshCitations, restyleAllCitations, wordFieldAccess } from "../word/refresh";
import { useConnection } from "./connection";
import { FieldBadge, countFields, type FieldCounts } from "./field-badge";
import { SearchPanel } from "./search-panel";
import { SettingsPanel } from "./settings-panel";
import { StylePicker } from "./style-picker";
import "./app.css";

const store = createSettingsStore({
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
});

const bridgeFactory = (port: number, token: string) => createBridge({ port, token });

export function App() {
  const conn = useConnection({ createBridge: bridgeFactory, store });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [refreshIsError, setRefreshIsError] = useState(false);
  const [restyleBusy, setRestyleBusy] = useState(false);
  const [restyleNote, setRestyleNote] = useState<string | null>(null);
  const [restyleIsError, setRestyleIsError] = useState(false);
  const [bibliographyBusy, setBibliographyBusy] = useState(false);
  const [bibliographyNote, setBibliographyNote] = useState<string | null>(null);
  const [bibliographyIsError, setBibliographyIsError] = useState(false);
  /**
   * Host field capability, probed on pane open: true = WordApi 1.5 fields are
   * writable (desktop), false = read-only OOXML scan host, null = not probed
   * yet. Read-only gates refresh/restyle/bibliography (disabled with an
   * explanation, never hidden).
   */
  const [fieldsWritable, setFieldsWritable] = useState<boolean | null>(null);
  const [fieldCounts, setFieldCounts] = useState<FieldCounts | null>(null);
  const [fieldScanning, setFieldScanning] = useState(false);
  const [fieldScanError, setFieldScanError] = useState<string | null>(null);

  // The ONE rescan path: same WordFieldAccess + scanDocument classification
  // refresh uses, so the badge can never disagree with a later refresh.
  const rescan = useCallback(async () => {
    setFieldScanning(true);
    setFieldScanError(null);
    try {
      const { access, writable } = wordFieldAccess();
      setFieldsWritable(writable);
      setFieldCounts(countFields(await scanDocument(access)));
    } catch (e) {
      setFieldScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setFieldScanning(false);
    }
  }, []);

  // Document-open scan: the pane just opened on this document.
  useEffect(() => {
    void rescan();
  }, [rescan]);

  // Citation insert goes through the search panel's injectable seam; a
  // successful insert mutates the document, so the badge follows.
  const insertCitationAndRescan = useCallback(
    async (embed: Parameters<typeof insertCitationField>[0], displayText: string) => {
      await insertCitationField(embed, displayText);
      await rescan();
    },
    [rescan],
  );

  async function onRefresh() {
    const bridge = conn.bridge;
    if (bridge === null || refreshing) return;
    setRefreshing(true);
    setRefreshNote(null);
    setRefreshIsError(false);
    try {
      const { access, writable } = wordFieldAccess();
      if (!writable) {
        // Word for the web et al.: fields are read-only there — report the
        // degradation up front; the document is never touched.
        setRefreshNote(
          "Refresh needs the Word desktop app — citation fields are read-only in this host.",
        );
        setRefreshIsError(true);
        return;
      }
      const outcome = await refreshCitations(bridge, access);
      setRefreshNote(describeRefreshOutcome(outcome));
      await rescan();
    } catch (e) {
      setRefreshNote(e instanceof Error ? e.message : String(e));
      setRefreshIsError(true);
    } finally {
      setRefreshing(false);
    }
  }

  async function onRestyleAll() {
    const bridge = conn.bridge;
    if (bridge === null || restyleBusy) return;
    setRestyleBusy(true);
    setRestyleNote(null);
    setRestyleIsError(false);
    try {
      const { access, writable } = wordFieldAccess();
      if (!writable) {
        // Same read-only degradation as refresh: the document is never touched.
        setRestyleNote(
          "Restyling needs the Word desktop app — citation fields are read-only in this host.",
        );
        setRestyleIsError(true);
        return;
      }
      // The engine validates the persisted pick against the loaded style list
      // before any rewrite — a stale styleId must never re-embed citations.
      const outcome = await restyleAllCitations(
        bridge,
        access,
        conn.settings.styleId,
        conn.styles.map((s) => s.id),
      );
      setRestyleNote(describeRestyleOutcome(outcome));
      await rescan();
    } catch (e) {
      setRestyleNote(e instanceof Error ? e.message : String(e));
      setRestyleIsError(true);
    } finally {
      setRestyleBusy(false);
    }
  }

  async function onInsertBibliography() {
    const bridge = conn.bridge;
    if (bridge === null || bibliographyBusy) return;
    setBibliographyBusy(true);
    setBibliographyNote(null);
    setBibliographyIsError(false);
    try {
      const { access, writable } = wordFieldAccess();
      if (!writable) {
        // Same read-only degradation as refresh: the document is never touched.
        setBibliographyNote(
          "Inserting a bibliography needs the Word desktop app — fields are read-only in this host.",
        );
        setBibliographyIsError(true);
        return;
      }
      const outcome = await insertOrReplaceBibliography(bridge, conn.settings.styleId, access, bodyBibliographyWriter());
      setBibliographyNote(describeBibliographyOutcome(outcome));
      // "no citations yet" is guidance, not a failure of the insert itself.
      setBibliographyIsError(outcome.status !== "inserted" && outcome.status !== "replaced" && outcome.status !== "no-citations");
      if (outcome.status === "inserted" || outcome.status === "replaced") await rescan();
    } catch (e) {
      setBibliographyNote(e instanceof Error ? e.message : String(e));
      setBibliographyIsError(true);
    } finally {
      setBibliographyBusy(false);
    }
  }

  if (conn.connection !== "paired") {
    return (
      <main data-testid="app-shell" className="pane">
        <header className="pane-header">
          <h1 className="pane-title">Notees</h1>
        </header>
        <SettingsPanel connection={conn} />
      </main>
    );
  }

  return (
    <main data-testid="app-shell" className="pane">
      <header className="pane-header">
        <h1 className="pane-title">Notees</h1>
        <FieldBadge
          counts={fieldCounts}
          scanning={fieldScanning}
          error={fieldScanError}
          onRescan={() => void rescan()}
        />
      </header>
      <section className="pane-body">
        {fieldsWritable === false && (
          <p className="pane-note" role="status">
            This Word host can read citation fields only — inserting, refreshing,
            and restyling them needs the Word desktop app (WordApi 1.5).
          </p>
        )}
        <StylePicker
          connection={conn}
          onRestyleAll={() => void onRestyleAll()}
          restyleBusy={restyleBusy}
          restyleNote={restyleNote}
          restyleIsError={restyleIsError}
        />
        <div className="refresh-row">
          <button
            type="button"
            className="secondary"
            onClick={() => void onRefresh()}
            disabled={refreshing || conn.bridge === null || fieldsWritable === false}
          >
            {refreshing ? "Refreshing…" : "Refresh citations"}
          </button>
          {refreshNote !== null && (
            <p className={refreshIsError ? "form-error" : "pane-note"} role={refreshIsError ? "alert" : "status"}>
              {refreshNote}
            </p>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => void onInsertBibliography()}
            disabled={bibliographyBusy || conn.bridge === null || fieldsWritable === false}
          >
            {bibliographyBusy ? "Inserting bibliography…" : "Insert bibliography"}
          </button>
          {bibliographyNote !== null && (
            <p
              className={bibliographyIsError ? "form-error" : "pane-note"}
              role={bibliographyIsError ? "alert" : "status"}
            >
              {bibliographyNote}
            </p>
          )}
        </div>
        {conn.bridge !== null ? (
          <SearchPanel
            bridge={conn.bridge}
            styleId={conn.settings.styleId}
            insertCitation={insertCitationAndRescan}
          />
        ) : (
          <p className="pane-placeholder">
            Connected to the Notees bridge ({conn.styles.length} citation styles
            available).
          </p>
        )}
      </section>
    </main>
  );
}
