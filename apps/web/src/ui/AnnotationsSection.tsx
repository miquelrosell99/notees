/**
 * AnnotationsSection — the body of an asset chip's annotations affordance
 * (SCHEMA.md annotation family): the highlight-classed objects whose seeded
 * highlight_asset property links this asset node, plus the add-annotation
 * form (quote excerpt, optional page, optional note).
 *
 * Lazy per the system-section contract: the section is mounted only when the
 * affordance opens, and Section itself runs `load` only while expanded — a
 * collapsed section executes no query. The load result is wrapped (not a
 * bare array) so the add form renders even when there are no annotations yet.
 * An expanded section re-runs its query on every client notification, so an
 * annotation added through the form (or landed from sync) appears while the
 * user watches.
 *
 * Row layout: the quote excerpt (the annotation object's name) plus its
 * provenance line (origin + page context); the row jumps to the
 * annotation object, which the outliner renders as an ordinary page.
 */

import { useState } from "react";

import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Section } from "./Section.js";
import { displayNameForSettings } from "./dateDisplay.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** The authored provenance value of an annotation, null when unset. */
function provenanceOf(client: AnyClient, annotationId: string): string | null {
  const row = client
    .getEffectiveProperties(annotationId)
    .find(
      (entry) =>
        entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.provenance &&
        entry.source === "authored",
    );
  if (row === undefined) return null;
  return typeof row.value === "string" && row.value !== "" ? row.value : null;
}

export function AnnotationsSection({
  client,
  assetId,
  onOpenPage,
}: {
  client: AnyClient;
  assetId: string;
  /** Page navigation for the annotation rows (the annotation is a page). */
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const [quote, setQuote] = useState("");
  const [page, setPage] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (quote.trim() === "") {
      setError("Quote text is required.");
      return;
    }
    setError(null);
    await client.createAnnotation({
      assetId,
      quote,
      ...(page.trim() !== "" ? { page: page.trim() } : {}),
      ...(note.trim() !== "" ? { note: note.trim() } : {}),
    });
    setQuote("");
    setPage("");
    setNote("");
  };

  return (
    <Section
      // Remount per asset: the Section result cache is version-keyed, so a
      // changed assetId with an unchanged notification version would serve
      // the previous asset's cached rows (PageView solves the same by keying
      // its sections with the page id).
      key={assetId}
      client={client}
      title="Annotations"
      defaultCollapsed={false}
      load={() => ({ annotations: client.getAnnotationsForAsset(assetId) })}
      emptyText="No annotations yet."
      renderResults={({ annotations }) => (
        <div className="nt-annotations">
          {annotations.length === 0 ? (
            <div className="nt-section-empty">No annotations yet.</div>
          ) : (
            <ul className="nt-section-list">
              {annotations.map((annotation) => {
                const provenance = provenanceOf(client, annotation.id);
                return (
                  <li key={annotation.id}>
                    <button
                      type="button"
                      className="nt-section-item nt-annotation-item"
                      onClick={() => onOpenPage?.(annotation.id)}
                    >
                      <span className="nt-annotation-quote">
                        {displayNameForSettings(annotation) || "Untitled"}
                      </span>
                      {provenance !== null && (
                        <span className="nt-annotation-page">{provenance}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <form
            className="nt-annotation-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              type="text"
              className="nt-annotation-quote-input"
              aria-label="Quote"
              placeholder="Quote…"
              value={quote}
              onChange={(event) => setQuote(event.target.value)}
            />
            <input
              type="text"
              className="nt-annotation-page-input"
              aria-label="Page"
              placeholder="Page (optional)"
              value={page}
              onChange={(event) => setPage(event.target.value)}
            />
            <input
              type="text"
              className="nt-annotation-note-input"
              aria-label="Note"
              placeholder="Note (optional)"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <button type="submit" className="nt-annotation-add">
              Add annotation
            </button>
          </form>
          {error !== null && (
            <p role="alert" className="nt-annotation-error">
              {error}
            </p>
          )}
        </div>
      )}
    />
  );
}
