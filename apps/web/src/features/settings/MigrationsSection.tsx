/**
 * MigrationsSection — the client-side content-migration runner surface
 * (F3), the "Advanced" block of the workspace settings' General tab.
 *
 * A "content"-class migration plans against the object graph, so the
 * server-side scripts refuse to run it against a keyed workspace (the
 * sealed prefix is invisible to a server-side plan). This section is the
 * remedy the refusal names: the migration's node-free planning core runs
 * against the local UNSEALED store, and the commit rides the client's
 * normal write path — the sync engine seals and pushes the ops like any
 * write. No new crypto, no wire change.
 *
 * The flow is dry-run-first: each pending migration is a row (title + the
 * report's counts + conflicts); Run opens the report, the confirm commits
 * ONE undo batch through the single enqueue seam. An unkeyed workspace
 * still lists a pending migration — with the hint that the server-side
 * path applies there too (the refusal only fires on keyed workspaces).
 */

import { useEffect, useState } from "react";

import { useClientVersion } from "../../components/ui/kit/useClientVersion.js";
import { Button } from "../../components/ui/kit/Button.js";
import { Modal } from "../../components/ui/kit/Modal.js";

import type { AnyClient } from "../../ui/app/clients.js";
import type { MigrationPlanReport } from "../../core/migrations/registry.js";

import "./MigrationsSection.css";

interface MigrationsSectionProps {
  client: AnyClient;
}

export function MigrationsSection({ client }: MigrationsSectionProps) {
  const version = useClientVersion(client);
  const [pending, setPending] = useState<MigrationPlanReport[] | null>(null);
  const [keyed, setKeyed] = useState<boolean | null>(null);
  /** The migration whose dry-run report is open (the confirm gates the run). */
  const [dryRun, setDryRun] = useState<MigrationPlanReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([Promise.resolve(client.listPendingMigrations()), Promise.resolve(client.isKeyedWorkspace())]).then(
      ([reports, keyedWorkspace]) => {
        if (cancelled) return;
        setPending(reports);
        setKeyed(keyedWorkspace);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.warn("[migrations] listing failed:", error);
        setPending([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, version]);

  if (pending === null || pending.length === 0) return null;

  const confirmRun = async () => {
    if (dryRun === null) return;
    setRunning(true);
    setRunError(null);
    try {
      await Promise.resolve(client.runMigration(dryRun.id));
      setDryRun(null);
      setPending(await Promise.resolve(client.listPendingMigrations()));
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <h3 className="settings-section__title settings-section__title--spaced">Migrations</h3>
      <p className="settings-item__description">
        Content migrations this workspace still needs. They run on this device through the normal
        sync path — on a keyed workspace the operations are sealed and pushed like any write.
      </p>
      {keyed === false && (
        <p className="settings-item__description migrations-section__hint">
          This workspace is not keyed — the server-side migration scripts can also run it.
        </p>
      )}
      <ul className="migrations-section__list">
        {pending.map((report) => (
          <li key={report.id} className="migrations-section__row">
            <div className="migrations-section__info">
              <span className="settings-item__label">{report.title}</span>
              <p className="settings-item__description">{report.description}</p>
              <p className="settings-item__description migrations-section__counts">
                {report.counts
                  .filter(([, count]) => count > 0)
                  .map(([label, count]) => `${count} ${label}`)
                  .join(" · ")}
                {report.conflicts.length > 0
                  ? ` · ${report.conflicts.length} kept for review`
                  : ""}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRunError(null);
                void Promise.resolve(client.planMigration(report.id)).then(setDryRun, (error: unknown) => {
                  setRunError(error instanceof Error ? error.message : String(error));
                });
              }}
            >
              Review &amp; run…
            </Button>
          </li>
        ))}
      </ul>
      {runError !== null && <div className="settings-error">{runError}</div>}

      <Modal
        isOpen={dryRun !== null}
        onClose={() => setDryRun(null)}
        title={dryRun !== null ? dryRun.title : ""}
        size="md"
        closeOnBackdrop={false}
        closeOnEscape={!running}
      >
        {dryRun !== null && (
          <div className="migrations-section__dryrun">
            <p className="settings-item__description">
              Running this migration commits {dryRun.opCount} operation
              {dryRun.opCount === 1 ? "" : "s"} through the normal sync path
              {keyed === false ? " (this workspace is not keyed — the server-side scripts can also run it)" : ""}.
              Every client converges on the same result.
            </p>
            <ul className="migrations-section__report">
              {dryRun.counts
                .filter(([, count]) => count > 0)
                .map(([label, count]) => (
                  <li key={label}>
                    {count} {label}
                  </li>
                ))}
            </ul>
            {dryRun.conflicts.length > 0 && (
              <>
                <p className="settings-item__description migrations-section__conflicts-title">
                  These values stay put (reported, never silently dropped):
                </p>
                <ul className="migrations-section__report migrations-section__conflicts">
                  {dryRun.conflicts.map((conflict) => (
                    <li key={conflict.nodeId}>
                      <code>{conflict.nodeId}</code> — {conflict.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {runError !== null && <div className="settings-error">{runError}</div>}
            <div className="migrations-section__actions">
              <Button variant="ghost" size="sm" onClick={() => setDryRun(null)} disabled={running}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => void confirmRun()} disabled={running}>
                {running ? "Running…" : "Run migration"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
