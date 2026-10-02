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
  const body =
    props.items.length === 0 && props.emptyTitle !== undefined ? (
      <EmptyState title={props.emptyTitle} description={props.emptyHint} />
    ) : (
      <Suspense fallback={<Spinner />}>
        <View {...props} />
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
