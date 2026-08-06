# Profile Project Workflow

Use this before filling skill content for a new project, after a major repo reshape, or when the user asks to summarize / refresh project rules.

## Read First

1. Re-open `SKILL.md` if it exists, then match the current request to the closest route.
2. Read the user's request and any brainstorm notes.
3. Inspect real project evidence: README, build/package files, CI, entry points, config, module layout, tests, and recent validation commands.
4. Read existing `rules/`, `workflows/`, and `references/` only after the first evidence scan, so stale docs do not anchor the summary.

## Evidence Labels

Use these labels in the output. Do not blur them together.

- `Confirmed from code/config` — supported by a concrete file, command, or directory layout.
- `User-calibrated` — stated by the user; useful for direction, but not enough to write a hard rule until checked.
- `Inferred` — likely from names or repeated patterns; include why it is an inference.
- `Unknown` — not enough evidence; leave a question instead of guessing.

## Steps

1. **Set scope** — identify whether this is first migration, targeted refresh, or full re-profile.
2. **Collect user language** — record the exact phrases users actually say in every language they use. These feed `description`, but only at domain / intent-cluster level.
3. **Map domains** — list modules, subsystems, packages, apps, CLIs, services, data layers, or template areas that behave differently.
4. **Find recurring work** — identify common task types from scripts, tests, docs, issue language, or user examples. These feed Common Tasks, not the frontmatter description.
5. **Find always-read candidates** — choose only 2-3 files whose rules apply to almost every task. Domain-specific files stay task-routed.
6. **Choose structure tier** — classify the documentation shape as Single-file, Folder-light, or Full. Default to the lightest tier unless concrete line, recurrence, procedure, harness-sharing, or lesson-capture pressure exists.
7. **Choose execution mode** — classify the skill as Rule-only, Assisted-executable, or Executable. Upgrade only when evidence shows external APIs/CLIs, side effects, repeated script logic, local config, or stable output contracts.
8. **Choose domain topology** — decide whether this is Single-skill or a Multi-skill candidate. Split only when trigger language and rule sets genuinely diverge.
9. **Draft activation** — write a coarse `description` with real trigger phrases and activation conditions; do not enumerate every workflow.
10. **Draft routing** — propose Common Tasks rows with exact required reads and workflows.
11. **Draft validation** — list the commands or manual checks that prove ordinary changes are safe. For executable or high-risk routes, include contract/scenario-test candidates.
12. **Mark unknowns** — keep unresolved facts visible instead of converting them into rules.

## Output Shape

Produce a compact project profile with these sections:

- Purpose and boundaries
- Domains / modules
- User trigger phrases
- Description draft
- Structure tier: Single-file / Folder-light / Full
- Execution mode: Rule-only / Assisted-executable / Executable
- Domain topology: Single-skill / Multi-skill candidate
- Common Tasks draft
- Always Read proposal
- Split / no-split recommendation
- Validation commands
- Gotchas candidates
- Unknowns and follow-up checks

Each non-obvious claim must carry one evidence label. Only `Confirmed from code/config` claims should become stable `rules/` content.

## Completion Checklist

- [ ] User language captured as real phrases, not translated guesses
- [ ] Description draft is coarse activation — not a workflow keyword list, and not a step-summary the agent would run instead of opening the workflow
- [ ] Common Tasks draft covers recurring work without exceeding 8-10 rows
- [ ] Always Read proposal is 2-3 files
- [ ] Structure tier defaults to the lightest tier with evidence-backed upgrade pressure
- [ ] Execution mode names concrete APIs, CLIs, side effects, scripts, local config, or output contracts when present
- [ ] Domain topology explains trigger-language and rule-set pressure before recommending a split
- [ ] Unknowns remain labeled
- [ ] No brainstorm-only claim was promoted to a hard rule
- [ ] Ran `route-health.sh`; any no/weak-trigger or overlap warnings on the drafted routes were addressed or noted
