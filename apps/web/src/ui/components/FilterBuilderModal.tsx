/**
 * FilterBuilderModal — the full-AST editor as a shell modal (the
 * ad-hoc query composer behind the Queries hub's "New query"). It edits the
 * same representable subset as the token popover (queryBuilder.ts — flat AND
 * of class/bits/text/created-window, one sort, one aggregation
 * dimension+measure) through the shared QueryBuilderFields surface (the
 * original ViewBuilder card-list presentation), and carries the C1 guard:
 * an initial AST with constructs outside the subset renders the read-only
 * summary + explicit "edit anyway" opt-in, never silent defaults.
 *
 * The created-window fields accept `{today}`-style placeholders (compiled at
 * run time — @notees/query's placeholders module), so a saved view re-
 * evaluates on the day it runs.
 *
 * Outcomes: "Run" composes the AST for a session-only ad-hoc run; "Save as
 * view" requires a name and persists a query token (view record per
 * V3) on the host the caller provides — the same content-token write path
 * everything else uses, no new op.
 */

import { useEffect, useState } from "react";

import { parseQueryAst, type QueryAst } from "@notees/query";

import { Button, Modal, TextField } from "./ui/index.js";

import {
  DEFAULT_BUILDER_STATE,
  builderUnsupportedConstructs,
  composeQueryAst,
  describeBuilderState,
  extractBuilderState,
  type QueryBuilderState,
} from "../queryBuilder.js";
import { QueryBuilderFields, useBuilderFacts, type BuilderFactsClient } from "./QueryBuilderFields.js";

export interface FilterBuilderModalProps {
  client: BuilderFactsClient;
  isOpen: boolean;
  onClose: () => void;
  /**
   * The "this page" scope anchor: when null the scope select offers only
   * workspace/pages (the hub has no single page context).
   */
  scopeAnchor?: { rootId: string; rootIsPage: boolean } | undefined;
  /** An AST to prefill the form (the hub's "edit this view" path). */
  initialAst?: unknown;
  /** The prefilled view name (edit path); the name field starts empty otherwise. */
  initialName?: string | undefined;
  /** The modal's submit actions: run ad-hoc, or persist as a named view. */
  onRun: (ast: QueryAst) => void;
  onSaveAsView: (ast: QueryAst, name: string) => Promise<void> | void;
}

export function FilterBuilderModal({
  client,
  isOpen,
  onClose,
  scopeAnchor,
  initialAst,
  initialName,
  onRun,
  onSaveAsView,
}: FilterBuilderModalProps) {
  const facts = useBuilderFacts(client);
  const [state, setState] = useState<QueryBuilderState>(DEFAULT_BUILDER_STATE);
  const [guard, setGuard] = useState<string[]>([]);
  const [override, setOverride] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Prefill on open (the modal stays mounted across open/close cycles).
  useEffect(() => {
    if (!isOpen) return;
    let parsed: QueryAst | null = null;
    if (initialAst !== undefined) {
      try {
        parsed = parseQueryAst(initialAst);
      } catch {
        parsed = null; // unparseable shapes yield the default state
      }
    }
    setGuard(builderUnsupportedConstructs(parsed));
    setOverride(false);
    setState(extractBuilderState(parsed));
    setName(initialName ?? "");
    setError(null);
  }, [isOpen, initialAst, initialName]);

  const compose = (): QueryAst =>
    composeQueryAst(
      state,
      scopeAnchor?.rootId ?? "",
      scopeAnchor?.rootIsPage ?? false,
    );

  const handleRun = () => {
    onRun(compose());
    onClose();
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Name the view before saving it.");
      return;
    }
    setError(null);
    await onSaveAsView(compose(), trimmed);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Query builder"
      size="md"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={handleRun}>
            Run
          </Button>
          <Button type="button" variant="primary" onClick={() => void handleSave()}>
            Save as view
          </Button>
        </>
      }
    >
      {guard.length > 0 && !override ? (
        <>
          <p className="nt-query-guard" role="alert">
            This query uses constructs the builder can&rsquo;t represent ({guard.join(", ")}).
            Editing it here would rewrite the query and drop them.
          </p>
          <ul className="nt-query-summary">
            {describeBuilderState(state, {
              className: (id) => facts.classNames.get(id) ?? id,
              propertyName: (id) => facts.propertyNames.get(id) ?? id,
            }).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="nt-query-builder-actions">
            <Button type="button" variant="outline" onClick={() => setOverride(true)}>
              Edit anyway
            </Button>
          </div>
        </>
      ) : (
        <>
          {guard.length > 0 && (
            <p className="nt-query-guard" role="alert">
              Editing will drop: {guard.join(", ")}.
            </p>
          )}
          <QueryBuilderFields
            state={state}
            onChange={(patch) => setState((s) => ({ ...s, ...patch }))}
            facts={facts}
            rootIsPage={scopeAnchor?.rootIsPage ?? false}
          />
          <TextField
            label="View name"
            placeholder="e.g. This week's captures"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {error !== null && (
            <p className="nt-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
