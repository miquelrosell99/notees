/**
 * SourcesSettingsSection — the Sources feature's settings block, the first
 * "feature settings section" under the workspace settings' Features tab
 * (source-library slice 3 task 5).
 *
 * Four controls, all writing through the converged op log:
 *
 *  1. Citekey pattern — a TextField compiling the shared pattern language
 *     (../sources/citekey.ts) with a LIVE PREVIEW of the  sample
 *     entry (Lovelace, Ada / 1843 / "Notes on the Analytical Engine"). An
 *     invalid pattern shows the inline compile error and the write is
 *     refused client-side (commit on blur/Enter, the rename precedent).
 *  2. Metadata resolver toggle — honest sub-note: a lookup reveals the
 *     queried identifier to the provider, never workspace content.
 *  3. The class-visibility list — all 39 source type-classes (the
 *     SYSTEM_SOURCE_CLASS_BINDINGS roster, every member extends `source`,
 *     listed in the seed roster order) as checked rows: checked = the class
 *     node's `active` bit, unchecked = archived. Toggling a row writes the
 *     SAME archive flag the classes gallery and the pickers respect — two
 *     doors to one switch (enable = un-archive, the gallery's
 *     `setArchived(id, true)` seam; disable = archive, the identical
 *     `setArchived(id, false)` write).
 *
 * Generation has NO toggle (citekeys always generate while the Sources
 * feature is on — the owner ruling 2026-10-29; pinning or a hand-edit is
 * the opt-out), so the settings vocabulary carries two keys only:
 * `citekeyPattern` + `resolverEnabled`.
 *
 * Every settings write is ONE `workspace.feature.set {feature: "sources",
 * enabled: true, settings}` carrying the READ-MODIFIED-MERGED record, so
 * the keys never clobber each other (the row is one whole-row LWW
 * unit — the undo journal restores the prior enabled + settings).
 */

import { useEffect, useState } from "react";

import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  type SystemClassName,
} from "@notees/domain";

import type { AnyClient } from "../../ui/app/Sidebar.js";
import { titleOf } from "../../ui/dateDisplay.js";
import { BooleanToggle } from "../../components/ui/kit/BooleanToggle.js";
import { Button } from "../../components/ui/kit/Button.js";
import { Checkbox } from "../../components/ui/kit/Checkbox.js";
import { TextField } from "../../components/ui/kit/TextField.js";

import {
  CITEKEY_SAMPLE_ENTRY,
  DEFAULT_CITEKEY_PATTERN,
  compileCitekeyPattern,
} from "../sources/citekey.js";

import "./SourcesSettingsSection.css";

/**
 * The 39 source type-classes (the bindings roster keys — every one extends
 * `source`; the base itself rides the family toggle above this section).
 * The object-literal order is the seed roster order (the everyday types
 * first, the long tail after), pinned by the domain test.
 */
const SOURCE_TYPE_CLASS_ROSTER = Object.keys(SYSTEM_SOURCE_CLASS_BINDINGS) as SystemClassName[];

/** The feature-scoped settings vocabulary (the first consumer; SCHEMA.md
 *  "Workspace features" names it normatively). Citekey generation has NO
 *  toggle — it is always on while the Sources feature is on (the owner
 *  ruling 2026-10-29: the opt-out is pinning or hand-editing, not a
 *  default-off switch); the vocabulary keeps only the pattern + the
 *  resolver gate. */
export interface SourcesFeatureSettings {
  citekeyPattern: string | undefined;
  resolverEnabled: boolean;
}

function readSourcesSettings(
  client: AnyClient,
): SourcesFeatureSettings {
  const row = client.listFeatureRows().find((entry) => entry.feature === "sources");
  const settings = row?.settings ?? {};
  return {
    citekeyPattern: typeof settings.citekeyPattern === "string" ? settings.citekeyPattern : undefined,
    // The server gate's default is ON (an absent row/key allows) — the
    // toggle mirrors that contract, not an absent-means-off reading.
    resolverEnabled: settings.resolverEnabled !== false,
  };
}

export function SourcesSettingsSection({
  client,
  onAddSource = undefined,
}: {
  client: AnyClient;
  /** Opens the add-source dialog (the command palette row's twin door). */
  onAddSource?: (() => void) | undefined;
}) {
  const settings = readSourcesSettings(client);
  const storedPattern = settings.citekeyPattern ?? DEFAULT_CITEKEY_PATTERN;

  // The pattern draft is local until it compiles AND commits (blur/Enter);
  // `committed` tracks the last store value the draft was synced from, so a
  // converged external change re-syncs the field without clobbering an
  // in-progress edit.
  const [draft, setDraft] = useState(storedPattern);
  const [committed, setCommitted] = useState(storedPattern);
  useEffect(() => {
    if (storedPattern !== committed) {
      setDraft(storedPattern);
      setCommitted(storedPattern);
    }
  }, [storedPattern, committed]);

  const compiled = compileCitekeyPattern(draft);

  const writeSettings = (patch: Record<string, unknown>) => {
    // Read-modify-merge against the CURRENT row so the keys never
    // clobber each other; one whole-row LWW write per change.
    const current = client.listFeatureRows().find((entry) => entry.feature === "sources")?.settings ?? {};
    void client.setFeatureSettings("sources", { ...current, ...patch }).catch((error: unknown) => {
      console.warn("[features] setFeatureSettings (sources) failed:", error);
    });
  };

  const commitPattern = () => {
    const trimmed = draft.trim();
    if (trimmed === committed) return;
    if (!compileCitekeyPattern(trimmed).ok) return; // refused client-side
    setDraft(trimmed);
    setCommitted(trimmed);
    writeSettings({ citekeyPattern: trimmed });
  };

  const toggleClass = (name: SystemClassName, next: boolean) => {
    // Two doors to one switch: the SAME active bit the classes gallery and
    // the pickers read (setArchived = object.update {active}, the
    // classes-gallery batch's archival seam).
    void client.setArchived(SYSTEM_CLASS_UUIDS[name], next).catch((error: unknown) => {
      console.warn(`[sources] setArchived (${name}) failed:`, error);
    });
  };

  return (
    <section className="sources-settings" aria-label="Sources settings">
      <h3 className="settings-section__title settings-section__title--spaced">Sources</h3>
      <p className="settings-item__description">
        Citation library behavior — citekey generation, the metadata resolver,
        and which source types appear in pickers and hubs.
      </p>
      {onAddSource !== undefined && (
        <div className="sources-settings__add">
          <Button variant="outline" size="sm" icon="mdi-book-plus-outline" onClick={onAddSource}>
            Add source…
          </Button>
        </div>
      )}

      <div className="settings-item sources-settings__pattern">
        <div className="settings-item__info">
          <label htmlFor="sources-citekey-pattern" className="settings-item__label">
            Citekey pattern
          </label>
          <p className="settings-item__description">
            Pattern for citekey generation — always on while Sources is on: an empty citekey fills on
            create, when a source is opened, and as its metadata changes. Tokens:{" "}
            <code>[auth]</code>, <code>[auth:lower]</code>, <code>[year]</code>, <code>[title]</code>,{" "}
            <code>[title:lower]</code>, <code>[title:N]</code>, <code>[title:lower:N]</code> (first N
            words); anything else is a literal. A pinned citekey is never recomputed; an unpinned one
            follows the pattern as it tracks metadata.
          </p>
        </div>
        <div className="sources-settings__pattern-field">
          <TextField
            id="sources-citekey-pattern"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitPattern}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPattern();
            }}
            size="sm"
            aria-label="Citekey pattern"
            error={!compiled.ok}
            {...(compiled.ok ? {} : { errorMessage: `Invalid pattern — ${compiled.error}` })}
          />
          <p className="sources-settings__preview" aria-live="polite">
            {compiled.ok ? (
              <>
                Preview <code>{compiled.render(CITEKEY_SAMPLE_ENTRY)}</code> — “Lovelace, Ada” (1843),{" "}
                “Notes on the Analytical Engine”
              </>
            ) : (
              "Fix the pattern to see the preview."
            )}
          </p>
        </div>
      </div>

      <div className="settings-item">
        <BooleanToggle
          label="Metadata resolver"
          description={
            <>
              Look up DOIs and ISBNs against public metadata providers (Crossref, Open Library, arXiv) when
              a source lacks metadata. A lookup reveals the queried identifier to the provider — never
              workspace content.
            </>
          }
          checked={settings.resolverEnabled}
          onChange={(checked) => writeSettings({ resolverEnabled: checked })}
          labelPosition="left"
        />
      </div>

      <div className="settings-item sources-settings__classes">
        <div className="settings-item__info">
          <span className="settings-item__label" id="sources-class-visibility-label">
            Source types
          </span>
          <p className="settings-item__description">
            The source type-classes available in pickers and hubs. Unchecked types stay in the graph —
            they are archived, exactly the archive flag the classes gallery toggles.
          </p>
        </div>
        <div
          className="sources-settings__class-list"
          role="group"
          aria-labelledby="sources-class-visibility-label"
        >
          {SOURCE_TYPE_CLASS_ROSTER.map((name) => {
            const id = SYSTEM_CLASS_UUIDS[name];
            const node = client.getNodeRaw(id);
            const checked = node !== undefined && node.isActive;
            const label =
              (node !== undefined ? (titleOf(client, id) ?? null) : null) ??
              SYSTEM_CLASS_DISPLAY_NAMES[name];
            return (
              <Checkbox
                key={name}
                size="sm"
                checked={checked}
                onChange={(next) => toggleClass(name, next)}
                label={label}
                aria-label={`${label} source type`}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
