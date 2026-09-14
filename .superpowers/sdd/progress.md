# Class Schema Separation Progress Ledger

Task 1: complete (commit 5c37a783, review: tests pass)
Task 2: complete (commit f9570394, review: tests pass)
Task 3: complete (commit 26923220, review: tests pass; known concern: useClasses returns ClassRow[], UI type errors remain for Task 5)
Task 4: complete (commit 466ed642, review: tests pass)
Task 5: complete (commit `feat(class): migrate UI and remove kind='class'`, review: frontend 651 passed, backend 452 passed/6 skipped)

# Class-Aware Display Names Progress Ledger

Task 1: complete (commits a62b8ab6..f01b835d, review: approved)
Task 2: complete (commits f01b835d..ca734072, review: approved after fix)
Task 3: complete (commits ca734072..bbb24e72, review: approved)
Task 4: complete (commits bbb24e72..d5e676be, review: approved)
Task 5: complete (commit `feat(ui): use class-aware display names in remaining surfaces`, review: frontend lint/type-check/tests pass)
Task 5: complete (commits d5e676be..a22d65dc, review: approved after fix)
Task 6: complete (commit `chore(ui): clean up redundant date formatting after class-aware migration`, review: lint/tests/type-check pass; browser verification skipped in headless environment)
Task 6: complete (commits a22d65dc..3db47e0c, review: controller verified after correcting subagent revert)

# GTK/Adwaita Client (notees-gtk) Progress Ledger

Plan: docs/plans/2026-09-14-gtk-adwaita-client/ (prd.md + tasks.md)
New repo: /etc/periphery/stacks/notees-gtk (public, AGPL-3.0)

Task 1: complete (commit 41d3cb7, review: approved; minors: inert pydocstyle config, README stub wording)
Task 2: complete (commits 2ff737c..2961355, review: approved; minors: busy-spin yield, docstring ordering claim, deterministic overflow test)
Owner directive 2026-09-14: no local builds — CI builds artifacts (wheel + Arch pkg in archlinux container); Arch build instructions in README.
Task 3: complete (commit 16cb1e8, review: approved; minors: 3xx classified Quarantined, malformed-JSON 2xx escapes taxonomy, stats dict guard — triage at final review)
Task 4: complete (commits ba2ff4a..f5fa47e, review: pending; known: snapshot restore drops non-intersecting cols (active/kind), up_to_seq=None snapshots skipped, nodes(parent_id=None)=no filter)
Task 4: complete (commits ba2ff4a..f5fa47e, review: approved; minors: snapshot SQL identifier quoting, empty txn on dedupe, O(pending) outbox match, no LWW baseline after restore, unused attempts col)
Task 5: complete (commits 176cfa4..a422969, review: approved after fixes; minors: main-thread may block behind store lock, optimistic mirror-ahead on push failure, TodoView speculative shape, ImportError message blame, interval source leak on logout, highlight hardcodes light theme)
Task 6: complete (commits b6399b1..629fa6b, review: approved; minors: pipefail consistency, su HOME, pipx #egg syntax)
Task 6: complete (commits b6399b1..629fa6b, review: approved)
Final review: With fixes -> fix wave 118d23d..06bf4e0 (snapshot real-schema restore, version fail-loud, clock merge, perms/guard/polish) -> re-review: READY TO MERGE YES
Plan docs/plans/2026-09-14-gtk-adwaita-client: status done; distilled to SPEC + project-rules + gotchas + tech-stack + SKILL
