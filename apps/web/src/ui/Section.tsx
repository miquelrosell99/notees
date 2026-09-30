/**
 * Section — the lazy-loading system-section primitive (SCHEMA.md contract):
 * collapsed by default, and a collapsed section executes NO query — `load`
 * runs only after the first expand. Results cache per section; while
 * expanded, a client notification re-runs the query, so an expanded section
 * picks up invalidating changes while a collapsed one stays silent. A query
 * failure (e.g. the client closing mid-flight) keeps the previous results
 * instead of crashing the tree — a section is reference material, never a
 * boot gate.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { NodeViewSection } from "./components/NodeViewSection.js";

export interface SectionProps<T> {
  client: WorkspaceClient | WorkerClient;
  title: string;
  icon?: ReactNode;
  /**
   * Materialized count badge — renders unconditionally and is exempt from
   * the lazy-loading contract (reading it is reading a stored number).
   * Omit for no badge: unlinked references never shows an eager count.
   */
  badge?: number;
  /** Collapsed on first render unless overridden. */
  defaultCollapsed?: boolean;
  /** The section query; MUST NOT be invoked while collapsed. */
  load: () => T;
  /** Results projection; rendered only while expanded. */
  renderResults: (results: T) => ReactNode;
  /** Text when the query came back empty. */
  emptyText: string;
}

export function Section<T>({
  client,
  title,
  icon,
  badge,
  defaultCollapsed = true,
  load,
  renderResults,
  emptyText,
}: SectionProps<T>) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [results, setResults] = useState<T | null>(null);
  /** Notification version at which `load` last ran; null = never ran. */
  const lastRunAt = useRef<number | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  useEffect(() => {
    if (!expanded) return;
    if (lastRunAt.current === version) return; // cached result is still fresh
    lastRunAt.current = version;
    try {
      setResults(load());
    } catch {
      // Closed client or a failed section query: keep the previous results.
    }
  }, [expanded, version, load]);

  return (
    <NodeViewSection
      title={title}
      icon={icon}
      count={badge}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {results === null ? null : Array.isArray(results) && results.length === 0 ? (
        <div className="nt-section-empty">{emptyText}</div>
      ) : (
        renderResults(results)
      )}
    </NodeViewSection>
  );
}
