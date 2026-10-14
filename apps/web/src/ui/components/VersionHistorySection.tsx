/**
 * VersionHistorySection — the Version history section of the page chrome's
 * context column (owner 2026-10-14): the per-node slice of the operation
 * log. The op log retains every edit a node ever received, so this surface
 * is a pure projection — the feed is the existing GET /api/operations
 * relay-log read filtered to ops whose payload names THIS node, no wire
 * change. Content-bearing ops (object.create / object.update carrying a
 * readable contentAst) are full snapshots: each expands to a read-only
 * preview, and a restore composes an ordinary object.update with that
 * snapshot — the current content keeps its own op in the log, so restoring
 * never destroys anything.
 *
 * The normative lazy contract holds: collapsed renders nothing and runs no
 * query; the first expand fetches. Honest degradation matches the property
 * history modal: when the feed is unreachable the section says so and notes
 * the history is a server-side-log surface.
 */

import { useEffect, useState } from "react";

import { plainTextExcerpt } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import type { WorkerClient } from "@/core/worker-client.js";
import type { OperationFeedEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Button } from "./ui/Button.js";
import { Spinner } from "./ui/Spinner.js";
import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { relativeTime } from "./ActivityLogSection.js";
import "./VersionHistorySection.css";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * The readable snapshot an entry carries, when it carries one — the
 * contentAst of an object.create/object.update. Delta-carried edits
 * (contentDeltaB64) have no readable snapshot and return null. Exported for
 * the unit tests.
 */
export function historyEntrySnapshot(entry: OperationFeedEntry): ContentAst | null {
  const raw = entry.payload.contentAst;
  return Array.isArray(raw) ? (raw as ContentAst) : null;
}

/** object.update field keys → human labels (the summary's "Updated …"). */
const UPDATE_FIELD_LABELS: Record<string, string> = {
  presentAsMain: "present as main",
  icon: "icon",
  color: "color",
  coverAssetId: "cover",
  bannerAssetId: "banner",
  aliasedNodeId: "alias",
  description: "description",
};

/**
 * One feed entry's one-line summary. `schemaName` resolves property.set/
 * property.unset payloads to the property's display name (the caller passes
 * the listPropertySchemas lookup). Exported for the unit tests.
 */
export function describeHistoryEntry(
  entry: OperationFeedEntry,
  schemaName?: string | null,
): string {
  const p = entry.payload;
  switch (entry.opType) {
    case "object.create":
      return "Created";
    case "object.update": {
      if (historyEntrySnapshot(entry) !== null || "contentDeltaB64" in p) return "Edited content";
      const fields = Object.keys(UPDATE_FIELD_LABELS).filter((key) => key in p);
      if (fields.length === 0) return "Updated";
      return `Updated ${fields.map((key) => UPDATE_FIELD_LABELS[key]).join(", ")}`;
    }
    case "object.delete":
      return p.permanent === true ? "Deleted permanently" : "Moved to trash";
    case "object.restore":
      return "Restored from trash";
    case "object.move":
      return "Moved";
    case "property.set":
      return `Set ${schemaName ?? "property"}`;
    case "property.unset":
      return `Unset ${schemaName ?? "property"}`;
    case "class.unassign":
      return "Removed class";
    case "tag.unassign":
      return "Removed tag";
    case "asset.attach":
      return "Attached asset";
    case "asset.detach":
      return "Detached asset";
    default:
      return entry.opType;
  }
}

export interface VersionHistorySectionProps {
  client: AnyClient;
  /** The active node — the feed is scoped to its own ops. */
  nodeId: string;
}

export function VersionHistorySection({ client, nodeId }: VersionHistorySectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<OperationFeedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumps after a restore so the feed refetches (the restore is a new op). */
  const [reloadKey, setReloadKey] = useState(0);
  /** Preview-open rows, by feed seq. */
  const [openSeqs, setOpenSeqs] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    client
      .fetchNodeHistory(nodeId)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, nodeId, expanded, reloadKey]);

  const schemaNameOf = (schemaId: unknown): string | null => {
    if (typeof schemaId !== "string") return null;
    return client.listPropertySchemas().find((schema) => schema.id === schemaId)?.name ?? null;
  };

  const togglePreview = (seq: number) => {
    setOpenSeqs((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  return (
    <NodeViewSection
      title="Version history"
      icon={<Icon path="mdi-file-restore-outline" size={0.9} />}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <div className="version-history">
        {error !== null && (
          <div role="alert" className="version-history__unavailable">
            <p>Version history is unavailable: {error}</p>
            <p className="version-history__unavailable-note">
              The history reads the server-side operation log; this device cannot reach it right
              now.
            </p>
          </div>
        )}
        {error === null && entries === null && (
          <div className="version-history__loading">
            <Spinner />
            <span>Reading the operation log…</span>
          </div>
        )}
        {error === null && entries !== null && entries.length === 0 && (
          <p className="version-history__empty">No edits recorded for this node yet.</p>
        )}
        {error === null && entries !== null && entries.length > 0 && (
          <ul className="version-history__rows">
            {entries.map((entry) => {
              const snapshot = historyEntrySnapshot(entry);
              const open = openSeqs.has(entry.seq);
              return (
                <li key={entry.seq} className="version-history__row">
                  <div className="version-history__line">
                    {snapshot !== null ? (
                      <button
                        type="button"
                        className="version-history__preview-toggle"
                        aria-expanded={open}
                        aria-label={`${describeHistoryEntry(entry, schemaNameOf(entry.payload.propertySchemaId))} — ${open ? "hide" : "show"} snapshot`}
                        onClick={() => togglePreview(entry.seq)}
                      >
                        <Icon
                          path="mdi-chevron-right"
                          size={0.8}
                          className={open ? "version-history__chevron version-history__chevron--open" : "version-history__chevron"}
                        />
                        <span className="version-history__event">
                          {describeHistoryEntry(entry, schemaNameOf(entry.payload.propertySchemaId))}
                        </span>
                      </button>
                    ) : (
                      <span className="version-history__event version-history__event--plain">
                        {describeHistoryEntry(entry, schemaNameOf(entry.payload.propertySchemaId))}
                      </span>
                    )}
                    <span
                      className="version-history__stamp"
                      title={new Date(entry.hlc.physical).toLocaleString()}
                    >
                      {relativeTime(entry.timestamp)}
                    </span>
                  </div>
                  {snapshot !== null && open && (
                    <div className="version-history__snapshot">
                      <p className="version-history__snapshot-text">
                        {plainTextExcerpt(snapshot) || "(empty)"}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void client
                            .updateObject(nodeId, { contentAst: snapshot })
                            .then(() => setReloadKey((key) => key + 1));
                        }}
                      >
                        Restore this version
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </NodeViewSection>
  );
}
