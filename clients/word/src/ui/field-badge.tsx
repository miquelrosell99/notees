import type { ScannedField } from "../citation/ooxml";

export interface FieldCounts {
  /** Fields the shared scan classifies as `kind === "citation"`. */
  citations: number;
  /** Presence of a bibliography field — 0 or 1 by contract, never a raw count. */
  bibliography: number;
}

/**
 * Count a scan for the header badge. Pure so the pane contract (`N citations
 * · M bibliography`, M ∈ {0,1}) is unit-testable without React or a host.
 */
export function countFields(fields: ScannedField[]): FieldCounts {
  return {
    citations: fields.filter((f) => f.kind === "citation").length,
    bibliography: fields.some((f) => f.kind === "bibliography") ? 1 : 0,
  };
}

/** Badge copy: "2 citations · 1 bibliography". */
export function badgeText(counts: FieldCounts): string {
  return `${String(counts.citations)} citations · ${String(counts.bibliography)} bibliography`;
}

export interface FieldBadgeProps {
  /** null until the first scan completes. */
  counts: FieldCounts | null;
  scanning: boolean;
  /** Scan failure message, surfaced honestly (never silently retried to zero). */
  error: string | null;
  onRescan(): void;
}

/**
 * The pane-header field badge: live citation/bibliography counts from the
 * SAME scan path as refresh, a Rescan affordance, an honest empty state for
 * a document with no citations (never an error), and an honest scan-failure
 * message with a retry. Composes the existing .badge/.secondary/.pane-note
 * classes — the flex .pane-header is the layout container.
 */
export function FieldBadge({ counts, scanning, error, onRescan }: FieldBadgeProps) {
  return (
    <>
      {error !== null ? (
        <span className="badge" data-testid="citation-count" role="alert">
          Could not scan the document: {error}
        </span>
      ) : scanning || counts === null ? (
        <span className="badge" data-testid="citation-count">
          Scanning document…
        </span>
      ) : (
        <span className="badge" data-testid="citation-count">
          {badgeText(counts)}
        </span>
      )}
      <button
        type="button"
        className="secondary rescan-button"
        onClick={onRescan}
        disabled={scanning}
      >
        {scanning ? "Scanning…" : "Rescan"}
      </button>
      {counts !== null && counts.citations === 0 && counts.bibliography === 0 && (
        <span className="pane-note" role="status">
          No Notees citations in this document yet.
        </span>
      )}
    </>
  );
}
