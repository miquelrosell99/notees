# Workflow rules (issue #13)

Server-side **"when X happens to nodes that fall into Y criteria, do Z"**:
a small rules engine inside the sync server watches every ingest and, on a
match, writes ordinary operation envelopes as a server actor. This page is
the canonical home of the feature — the shape of the state, the evaluation
point, the loop policy, and the audit.

## The ruling: coordination state, not log state

Rule *definitions* and the run audit live in the sync server's `relay.db`
(`workflow_rule` / `workflow_run` tables, additive `CREATE IF NOT EXISTS` —
the prefs/shares/plugins precedent). They are deliberately NOT operation-log
state: a rule is server configuration, not a semantic fact every client must
converge on. Rule *effects* are different: they are **ordinary envelopes**
(`property.set`, or a re-issued `object.create` carrying `classIds`) stamped
by the server with the client claim `rules-engine` and pushed through the
one write path (`ServerContext.ingestBatch`). Every derived store converges
on them like on any other op; there is no new op type, no wire change, no
fixture gate, no client lockstep.

The only log entries a workflow ever produces are the action envelopes
themselves. Rule CRUD stamps nothing (test-pinned).

## Tables (relay.db)

```
workflow_rule
  id TEXT PRIMARY KEY            -- uuidv7
  workspace_id TEXT NOT NULL     -- v1 object-authz scope: the default workspace
  name TEXT NOT NULL
  enabled INTEGER NOT NULL DEFAULT 1
  trigger_op_type TEXT NOT NULL  -- object.create | property.set | class.assign
  criteria TEXT NOT NULL         -- QueryAST v1 JSON (a node filter, no aggregation)
  actions TEXT NOT NULL          -- JSON array, 1..10 entries
  created_at / updated_at INTEGER

workflow_run                     -- append-only audit
  id TEXT PRIMARY KEY            -- uuidv7
  rule_id / workspace_id TEXT
  trigger_envelope_id TEXT       -- the saved envelope that tripped the rule
  node_id TEXT                   -- the affected node that matched the criteria
  actions_written TEXT           -- [{opType, envelopeId}] actually persisted
  outcome TEXT                   -- actions_written | actions_failed |
                                 -- skipped_loop | skipped_depth_cap
  detail TEXT                    -- failure message / skip reason
  created_at INTEGER
```

Caps: 100 rules per workspace, 10 actions per rule. The audit is append-only
with no retention sweep yet — runs grow with matches; prune is future work.

## X / Y / Z, concretely

- **X (trigger)** — existing op types, v1 set: `object.create`,
  `property.set`, and the semantic **`class.assign`**. There is no
  `class.assign` op on the wire: class membership add-wins rides a re-issued
  `object.create` carrying `classIds` (see `op-catalog.ts`), and the semantic
  trigger matches exactly those envelopes. Validation is fail-loud at the API
  (422 on anything else).
- **Y (criteria)** — the QueryAST (`packages/protocol/src/query-ast.ts`),
  compiled by `@notees/query` against the workspace's **derived store** and
  probed for the envelope's affected node. Criteria must be a pure node
  filter: an AST carrying an aggregation is rejected at creation, and a trial
  `compile()` runs at creation so a placeholder/scope error surfaces there,
  never at trigger time. `{today}`-style placeholders resolve against the run
  clock at evaluation.
- **Z (actions)** — v1: `property.set` `{propertySchemaId, value, idx?}` and
  `class.assign` `{classId}`. Each translates to its existing wire op at
  execution time (`class.assign` → `object.create` re-issue with `classIds` —
  the OR-Set add carrier). The composed payload is validated against the
  wire's own op schema at rule creation, so a firing cannot stamp a
  schema-invalid envelope. Action values are written verbatim; a value that
  violates the property schema's shape (e.g. a string into a number slot)
  fails at apply time — see the failure policy below.

## Evaluation point

`ServerContext.ingestInternal` runs the engine after each workspace group's
apply + broadcast, over the **freshly saved** envelopes of that group only
(duplicates that ingest ignored are not re-evaluated). Per ingest:

1. enabled rules for the workspace are loaded and each criteria AST is
   **compiled once** (not per envelope);
2. envelopes are checked against rules in creation order — a rule only sees
   envelopes whose op type can trip its trigger;
3. for a tripped envelope, the affected-node candidates (its declared
   `affectedNodeIds` plus the payload's `objectId`/`classId`) are probed
   against the criteria — the store state includes the just-applied batch;
4. each match fires: actions for all matched nodes are stamped by
   `EnvelopeFactory` (client `rules-engine`) and written through a
   **re-entrant, depth-capped ingest** (below), then recorded in
   `workflow_run`.

Evaluation is awaited inside the ingest, so a rule's effects are durable and
broadcast before the triggering batch's response returns. Engine ingests do
**not** charge the client relay rate budget (server-authored ops, the seed
precedent) but do broadcast — clients converge on rule effects immediately.
Workspace seeding (`ensureSeeded`) and snapshot restores intentionally bypass
the engine (they don't go through `ingestBatch`); client and API writes all
do, so a rule cannot tell them apart and doesn't need to.

## Loop policy (the correctness crux)

The re-entrant ingest carries an evaluation context — `{depth, firedRuleIds}`:

- Client-authorized ingest is **depth 0**. A firing's actions ingest at
  **depth 1** with `firedRuleIds = {that rule}`.
- Depth-1 envelopes are evaluated once more, but a match there **writes
  nothing** (`skipped_depth_cap`): **rule chains beyond one hop do not
  execute in v1.**
- Within that re-entry, the **loop breaker**: a rule never fires on envelopes
  it caused (`skipped_loop`) — `class.assign` actions are themselves
  class-add carriers and would otherwise re-trip their own rule forever.

Both skips are recorded in the audit, so the policy is observable rather than
silent. Termination is structural: firings only ever happen at depth 0 of an
evaluation whose re-entry cannot write.

Order note: rules evaluate in creation order within one batch, and a firing's
effects land before later rules probe — so a later rule can match the earlier
rule's fresh effect against the *same* trigger envelope (it then fires at
depth 0 with its own fresh chain). Deterministic, and bounded by the same
caps; just don't read creation order as causal ordering.

## Failure policy

A firing whose action ingest throws (e.g. a schema shape violation) is
recorded as `actions_failed` with the error message and **never blocks the
triggering ingest** — the client batch answered 200/201 already applied
everything before evaluation ran. One consequence of the log-first order: a
failed action's envelope IS persisted to the relay log (unapplied); hydration
retries it each boot and skips it as not-yet-applicable, the same treatment
any not-yet-applicable envelope gets. A rule that fails loudly in evaluation
itself (a broken stored rule) is skipped with a console error, not an ingest
failure — creation-time validation is the real guard.

## Audit

`GET /api/workflows/:id/runs` (reader-scoped) returns the newest-first page
(200) of `workflow_run` rows: trigger envelope id, matched node, action
envelope ids, outcome, detail, timestamp. Nothing is recorded for
evaluations that didn't match — the audit is proportional to firing attempts,
not to ingest volume.

## API and authorization

Read (`GET /workflows`, `GET /workflows/:id`, `GET /workflows/:id/runs`):
any authenticated principal — the v1 object-authz scope is the default
workspace. Write (`POST`, `PATCH`, `DELETE`): **owner/admin only** — the
shares idiom: the operator key, an administrator account, or the owner
membership role on the default workspace. All rule routes address the default
workspace (`X-Workspace-Id` is not consulted, again like shares).

Bodies are zod-strict; unknown keys are 422. `PATCH` merge-patches any of
`name` / `enabled` / `trigger` / `criteria` / `actions` and re-validates
present fields exactly as on create.

## Who may author rules, and the parked plugin runtime

Rules are operator tooling, v1: owner/admin only, API-only (no UI surface
yet). They share the server's "declared, not executed" culture with the
plugin registry, but they are NOT plugins: the workflow engine is live
server code with a fixed action vocabulary, not a manifest consumed by a
(parked) runtime. If the plugin runtime ever un-parks, workflow actions are
a natural extension point — a plugin-provided action would still translate
to existing wire ops at execution time, or it becomes a lockstep event.

## Testing

`apps/server/test/workflows.test.ts` — engine semantics (match → action
written by the server actor; non-match → nothing; loop cap and depth cap
audits; disabled no-op; failure audited + ingest unaffected) and the route
surface (authz matrix, fail-loud validation, 404s, restart persistence, the
no-envelope-from-CRUD invariant).
