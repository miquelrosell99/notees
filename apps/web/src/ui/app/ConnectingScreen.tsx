/**
 * ConnectingScreen — the bootstrap "Connecting…" surface.
 *
 * Composes the kit LoadingScreen (spinner + label) so the catch-up phase can
 * also render its REAL progress: when a progress payload is live the label
 * becomes "Catching up… N%" (rounded down) and the kit renders the progress
 * bar; before the first payload the phase text ("Catching up… 128,450
 * operations") shows with the plain spinner. The fraction arrives over the
 * same push channel as the sync phases (engine onPullProgress → worker
 * {type:"syncProgress"} → the connection's connectProgressFraction).
 */
import { LoadingScreen } from "@/components/ui/kit/LoadingScreen.js";

export interface ConnectingScreenProps {
  /** Phase text: the engine's sync-phase message, or the static label before any phase. */
  label: string;
  /** Catch-up fraction 0–1, or null before the first progress payload / outside catch-up. */
  progress: number | null;
  /** Connect failure, when the open rejected. */
  error?: string | null;
}

export function ConnectingScreen({ label, progress, error }: ConnectingScreenProps) {
  const fraction =
    progress !== null && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null;
  // The engine's catch-up message carries a raw op count ("Catching up… 0
  // operations") — uninformative on everyday boots, so the label is the clean
  // phase name; the fraction (when a real replay reports one) carries the
  // progress instead.
  const catchingUp = /^catching up/i.test(label);
  const text =
    fraction !== null
      ? `Catching up… ${Math.floor(fraction * 100)}%`
      : catchingUp
        ? "Catching up…"
        : label;
  return (
    <div className="nt-bootstrap">
      <div className="nt-bootstrap-form">
        <h1 className="nt-bootstrap-title">Notees</h1>
        <LoadingScreen
          fullscreen={false}
          label={text}
          {...(fraction !== null ? { progress: fraction } : {})}
        />
        {error !== null && error !== undefined && (
          <p className="nt-error" role="alert">{error}</p>
        )}
      </div>
    </div>
  );
}
