/**
 * WorkflowsSettingsSection — Settings → Workflows tab (research-tier2
 * slice 2b): one row per `WORKFLOWS` registry entry.
 *
 * The installed state is DERIVED, never stored (D1): the anchor probe is ONE
 * read of the anchor node row — absent = Available, present + active =
 * Installed, present + archived = Disabled. Enable/disable run the
 * materializer (`materializeWorkflow` — the domain op plan executed with
 * per-step existence checks, ONE undo-journal batch per toggle); a disable
 * with instances confirms first, stating the F3 keep-data fact ("N nodes
 * carry this vocabulary; they keep it — the vocabulary hides from pickers").
 *
 * All chrome composes from `components/ui/kit` (the ui-primitives law); the
 * read/write wiring follows the SourcesSettingsSection precedent.
 */

import { useMemo, useState } from "react";

import { WORKFLOWS, type WorkflowId } from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import { Badge } from "../../components/ui/kit/Badge.js";
import { Button } from "../../components/ui/kit/Button.js";
import { ConfirmationModal } from "../../components/ui/kit/ConfirmationModal.js";

import {
  materializeWorkflow,
  workflowInstanceCount,
  workflowState,
  type WorkflowState,
} from "./materialize.js";

import "./WorkflowsSettingsSection.css";

const STATE_LABEL: Record<WorkflowState, string> = {
  available: "Available",
  installed: "Installed",
  disabled: "Disabled",
};

const STATE_BADGE_VARIANT: Record<WorkflowState, "neutral" | "primary" | "secondary"> = {
  available: "neutral",
  installed: "primary",
  disabled: "secondary",
};

export function WorkflowsSettingsSection({ client }: { client: AnyClient }) {
  /** Bumped after a toggle so the anchor probe re-reads (the modal holds no subscription of its own). */
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState<WorkflowId | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<{ wfId: WorkflowId; instances: number } | null>(null);

  const rows = useMemo(
    () =>
      (Object.keys(WORKFLOWS) as WorkflowId[]).map((wfId) => ({
        wfId,
        spec: WORKFLOWS[wfId],
        state: workflowState(client, wfId),
      })),
    // The client reads are the render input; epoch re-runs the probe after a toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, epoch],
  );

  const toggle = async (wfId: WorkflowId, target: "enabled" | "disabled") => {
    setBusy(wfId);
    try {
      await materializeWorkflow(client, wfId, target);
    } catch (error: unknown) {
      console.warn(`[workflows] materialize (${wfId} → ${target}) failed:`, error);
    } finally {
      setBusy(null);
      setEpoch((value) => value + 1);
    }
  };

  const requestDisable = (wfId: WorkflowId) => {
    // F3 confirmation: instances keep their data — state the count when
    // there is one, write straight through when the vocabulary is unused.
    const instances = workflowInstanceCount(client, wfId);
    if (instances > 0) {
      setConfirmDisable({ wfId, instances });
      return;
    }
    void toggle(wfId, "disabled");
  };

  return (
    <section className="workflows-settings" aria-label="Workflows settings">
      <p className="settings-item__description">
        Workflows install a documented vocabulary — classes, property schemas, and starter
        templates — as ordinary user-space nodes. Everything they install stays yours to rename and
        edit; disabling hides the vocabulary from pickers and hubs without touching your data.
      </p>
      {rows.map(({ wfId, spec, state }) => (
        <div className="settings-item workflows-settings__row" key={wfId}>
          <div className="settings-item__info">
            <span className="settings-item__label">{spec.label}</span>
            <ul className="workflows-settings__powers">
              {spec.powers.map((power) => (
                <li key={power}>{power}</li>
              ))}
            </ul>
          </div>
          <div className="workflows-settings__actions">
            <Badge variant={STATE_BADGE_VARIANT[state]} size="sm">
              {STATE_LABEL[state]}
            </Badge>
            {state === "installed" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => requestDisable(wfId)}
              >
                Disable
              </Button>
            ) : (
              <Button
                variant={state === "disabled" ? "primary" : "default"}
                size="sm"
                disabled={busy !== null}
                onClick={() => void toggle(wfId, "enabled")}
              >
                {state === "disabled" ? "Re-enable" : "Enable"}
              </Button>
            )}
          </div>
        </div>
      ))}

      <ConfirmationModal
        isOpen={confirmDisable !== null}
        title={confirmDisable !== null ? `Disable ${WORKFLOWS[confirmDisable.wfId].label}?` : "Disable?"}
        message={
          confirmDisable !== null
            ? `${confirmDisable.instances} node${confirmDisable.instances === 1 ? "" : "s"} ${
                confirmDisable.instances === 1 ? "carries" : "carry"
              } this vocabulary; they keep it — the vocabulary hides from pickers.`
            : ""
        }
        confirmLabel="Disable"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          if (confirmDisable !== null) void toggle(confirmDisable.wfId, "disabled");
          setConfirmDisable(null);
        }}
        onCancel={() => setConfirmDisable(null)}
      />
    </section>
  );
}
