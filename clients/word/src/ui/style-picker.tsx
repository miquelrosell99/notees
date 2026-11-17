import { useState } from "react";
import { isKnownStyleId, reconcileStyleId, type Connection } from "./connection";

export interface StylePickerProps {
  connection: Connection;
  /** "Refresh all with this style" — the caller owns the Word/bridge work. */
  onRestyleAll: () => void;
  restyleBusy: boolean;
  restyleNote: string | null;
  restyleIsError: boolean;
}

/**
 * The citation-style picker: a <select> of bridge-provided styles keyed by
 * id, persisted through the settings store. The picked style applies to NEW
 * citations only — existing citation fields keep the styleId baked into
 * their own embed until the user explicitly runs "Refresh all with this
 * style" (Review-Focus #3).
 */
export function StylePicker({
  connection,
  onRestyleAll,
  restyleBusy,
  restyleNote,
  restyleIsError,
}: StylePickerProps) {
  const [reloading, setReloading] = useState(false);
  const [reloadNote, setReloadNote] = useState<string | null>(null);
  const { styles, settings, bridge } = connection;
  // Survive a styles list that no longer carries the persisted selection
  // (display falls back to first, else apa; reloadStyles persists it).
  const selected = reconcileStyleId(settings.styleId, styles);
  // Restyle rewrites every citation embed to the persisted pick, so the
  // action is gated off — with an honest note, never hidden — when that pick
  // is not in the bridge's current list (style removed, re-paired workspace).
  const styleKnown = isKnownStyleId(settings.styleId, styles);

  async function onReload() {
    if (reloading) return;
    setReloading(true);
    setReloadNote(null);
    const ok = await connection.reloadStyles();
    if (!ok) setReloadNote("Could not reload styles — the bridge did not answer.");
    setReloading(false);
  }

  return (
    <section className="style-picker" aria-label="Citation style">
      <label className="field">
        <span className="field-label">Citation style</span>
        <select
          aria-label="Citation style"
          value={selected}
          onChange={(e) => connection.setStyleId(e.target.value)}
          disabled={bridge === null}
        >
          {styles.length === 0 && <option value={selected}>{selected}</option>}
          {styles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="refresh-row">
        <button
          type="button"
          className="secondary"
          onClick={() => void onReload()}
          disabled={reloading || bridge === null}
        >
          {reloading ? "Reloading styles…" : "Reload styles"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onRestyleAll}
          disabled={restyleBusy || bridge === null || !styleKnown}
        >
          {restyleBusy ? "Restyling…" : "Refresh all with this style"}
        </button>
      </div>
      {!styleKnown && (
        <p className="pane-note" role="status">
          The saved style is not in the bridge's list, so restyling is off —
          reload styles, then pick a listed style.
        </p>
      )}
      {reloadNote !== null && (
        <p className="form-error" role="alert">{reloadNote}</p>
      )}
      {restyleNote !== null && (
        <p className={restyleIsError ? "form-error" : "pane-note"} role={restyleIsError ? "alert" : "status"}>
          {restyleNote}
        </p>
      )}
    </section>
  );
}
