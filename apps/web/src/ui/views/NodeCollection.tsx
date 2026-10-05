/**
 * NodeCollection — the view dispatcher. Resolves the registry entry for the
 * requested mode and renders its component inside a mode-classed container
 * (`node-collection node-collection--{mode}`, the v1 convention) with a
 * Suspense boundary and (when the entry opts in) the kit ErrorBoundary. The
 * empty collection renders the kit EmptyState when the container offers a
 * title; otherwise nothing.
 */

import { Suspense } from "react";

import { EmptyState, ErrorBoundary, Spinner } from "../components/ui/index.js";
import { getViewDefinition } from "./registry.js";
import type { NodeCollectionProps, ViewMode } from "./types.js";

export function NodeCollection({ viewMode, ...props }: NodeCollectionProps & { viewMode: ViewMode }) {
  const entry = getViewDefinition(viewMode);
  if (entry === undefined) {
    return <div className="node-collection node-collection--missing">Unknown view: {viewMode}</div>;
  }
  const View = entry.component;
  // Whole-topology views (graph) omit `items`; list views always receive [].
  const viewProps = { ...props, items: props.items ?? [] };
  const body =
    viewProps.items.length === 0 && entry.id !== "graph" && props.emptyTitle !== undefined ? (
      <EmptyState title={props.emptyTitle} description={props.emptyHint} />
    ) : (
      <Suspense fallback={<Spinner />}>
        <View {...viewProps} />
      </Suspense>
    );
  const content = entry.capabilities.errorBoundary === true
    ? <ErrorBoundary>{body}</ErrorBoundary>
    : body;
  return (
    <div className={`node-collection node-collection--${entry.id} ${props.className ?? ""}`.trim()}>
      {content}
    </div>
  );
}
