/**
 * PropertyHistoryModal — a property value's history (§34.32 PG13; panel
 * scope decided: modal). The op log is the authority and the server
 * exposes it as the GET /api/operations feed (§34.33.1); this modal pulls
 * the feed (paginated), filters client-side to property.set/property.unset
 * for ONE node + schema, and renders the entries newest-first (HLC order —
 * physical then logical then seq). Honest degradation: when the feed is
 * unreachable (offline, no REST config, server error) the modal says so
 * and notes the history is a server-side-log surface — a device-local op
 * journal is registered follow-up work, never a silent local guess.
 */

import { useEffect, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { OperationFeedEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { Spinner } from "./ui/Spinner.js";
import "./PropertyHistoryModal.css";

type AnyClient = WorkspaceClient | WorkerClient;

function valuePreview(payload: Record<string, unknown>): string {
  if ("value" in payload) {
    const raw = JSON.stringify(payload.value);
    return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
  }
  return "";
}

export function PropertyHistoryModal({
  client,
  nodeId,
  propertySchemaId,
  schemaName,
  onClose,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  schemaName: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<OperationFeedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    client
      .fetchOperationsFor(nodeId, propertySchemaId)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, nodeId, propertySchemaId]);

  return (
    <Modal isOpen onClose={onClose} size="md" showCloseButton={false} className="nt-property-history">
      <div className="modal__header">
        <h2 className="modal__title">Value history — {schemaName}</h2>
        <button
          type="button"
          aria-label="Close modal"
          className="btn btn--ghost btn--sm btn--icon-only modal__close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="modal__content">
        {error !== null && (
          <div role="alert" className="nt-property-history__unavailable">
            <p>History is unavailable: {error}</p>
            <p className="nt-property-history__unavailable-note">
              The history reads the server-side operation log; this device cannot reach it right
              now. A device-local op journal is registered follow-up work.
            </p>
          </div>
        )}
        {error === null && entries === null && (
          <div className="nt-property-history__loading">
            <Spinner />
            <span>Reading the operation log…</span>
          </div>
        )}
        {error === null && entries !== null && entries.length === 0 && (
          <p className="nt-property-history__empty">No property writes for this value yet.</p>
        )}
        {error === null && entries !== null && entries.length > 0 && (
          <ul className="nt-property-history__list">
            {entries.map((entry) => (
              <li key={entry.seq} className="nt-property-history__row">
                <span className="nt-property-history__time">
                  {new Date(entry.hlc.physical).toLocaleString()}
                </span>
                <span
                  className={
                    entry.opType === "property.unset"
                      ? "nt-property-history__op nt-property-history__op--unset"
                      : "nt-property-history__op"
                  }
                >
                  {entry.opType === "property.unset" ? "unset" : "set"}
                </span>
                <span className="nt-property-history__value">
                  {valuePreview(entry.payload)}
                  {typeof entry.payload.idx === "number" && entry.payload.idx !== 0 ? (
                    <span className="nt-property-history__idx">slot {entry.payload.idx}</span>
                  ) : null}
                </span>
                <span className="nt-property-history__actor" title={`device ${entry.deviceId}`}>
                  {entry.actorId.slice(0, 8)}…
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="modal__footer">
        <Button variant="default" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
