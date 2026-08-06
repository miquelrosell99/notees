# Reference — Tests as Spec (spec-first, human-oracle) · OPT-IN

An **opt-in** discipline for projects whose work produces unit-testable code **and** where shipping under-tested changes has actually bitten you (e.g. recurring production incidents after only light testing). It is **not** a default: a project with no such baseline, or mostly non-unit-testable work (UI/visual/config), should not adopt it — forcing it would be the imagined-pain anti-pattern (SKILL.md Common Pitfalls #10). Frontend *style / interaction* is never in scope (§ Verification modes).

## The loop

1. **Plan → write the spec as test cases.** For Complex/Large, unit-testable work, author a concrete test-case catalog *at plan time*, saved with the plan (a `test-cases.md` sibling, or inline when small). Cover the behavior space — happy path, boundaries, failure modes, contract/schema — **not** a coverage %.
2. **The cases are the question-generator — this is the anti-false-green mechanism.** Writing a concrete case drags every silent assumption into the open ("expected result at `total = 100` → ?"). Each unresolved one is a **question for the human, at boundary/decision granularity**. Concretely: whenever a case's expected value depends on a rule you are *inferring* rather than one you were *told*, that inference is a question — ask it before coding. The human's answer is the independent **correctness oracle**: the agent cannot verify "did we build the *right* thing" against its own understanding — it wrote the code and the test from one mental model, so they agree *by construction, not by verification*.
3. **The cases are the spec that constrains implementation.** Build to satisfy the cases; realize them as the project's unit tests.
4. **Run. A failing test is a forced reconciliation (the trichotomy):** either the **code** is wrong, or the **test/case is wrong (our understanding was wrong)**. Fix the wrong one. If the case was wrong, **revise it with a one-line reason** — never edit a test just to make it green; that re-buries the bug.
5. **Report, don't self-certify.** Run the tests with fresh evidence (per [`../workflows/task-closure.md`](../workflows/task-closure.md) § Fresh verification evidence — no "passes" without running it *this message*), then **lay out for the user**: which cases pass/fail, whether the whole suite is still green (new work shouldn't break the regression net), what is still uncertain, and what is subjective (→ their sign-off). The **user makes the final acceptance call** — the agent's job is faithful generation + honest reporting, not being the arbiter of "right".

## The bugfix loop (red → green)

For bug fixes under this discipline, the generic reproduce-first step in [`../workflows/fix-bug.md`](../workflows/fix-bug.md) (step 3: any repeatable check) upgrades to **write the acceptance test first**:

1. Express the reported bug as an automated test (or repeatable script where a test has no seam) *before* any fix.
2. **Run it red.** If it passes, the reproduction or the acceptance understanding is wrong — fix that first, not the code.
3. Locate the root cause, apply the minimal fix.
4. **Run the same check green** (fresh evidence), then the smallest relevant regression. Same-check is the point: swapping in a different check after the fix re-opens the false-green door (§ The loop, step 4's trichotomy applies to the red run too).

The escape hatch stays: what can't be stably automated gets a written repeatable manual sequence plus the reason — this section only tightens "repeatable check" into "automated test first" for projects that adopted this reference.

## Verification modes — don't machine-test the unverifiable

| Mode | For | How |
|---|---|---|
| **Automated test** | unit-testable logic (backend logic; frontend utils / hooks / transforms / schema factories) | realize cases as unit tests; trichotomy on failure |
| **Human sign-off** | subjective / visual / UX ("looks right", layout, interaction feel) | the agent does **not** self-certify — surface the result to the user for acceptance |

A green test on a subjective thing is **false confidence**: machine "pass" ≠ user acceptance. Don't build verification for what only a human can judge.

## The two failure roots this closes (and its honest limit)

"under-tested → production incident" has two roots, each needing a different half:

- **too shallow / missing paths** → the case catalog forces coverage (step 1).
- **testing the wrong thing (false-green)** → human-oracle clarification forces correctness (step 2).

Neither half alone prevents the incident. **Honest limit:** once every load-bearing decision has been surfaced as a case and ruled on by the human, a remaining error is *upstream* — insufficient human analysis, or insufficient clarification dialogue — not something the test machinery can catch. The agent's duty is to **surface** every decision; the human's is to **rule** on it.

## When NOT to adopt / not applicable

- **No baseline** (no observed under-testing pain) → don't mandate; the imagined-pain rule applies.
- **Non-unit-testable work** (UI/visual/config/migration/exploratory/throwaway) → human sign-off or skip, not forced unit tests.
- **Trivial/Simple changes** → a couple of inline cases, or none; scale with the Complexity Gate.

*What counts as unit-testable:* isolated logic with deterministic input → output, checkable without side effects, live services, or user interaction — parsers, validators, state machines, data transforms, business rules. **Not:** visual layout, interaction feel, or flaky I/O with no seam to stub. When in doubt, it's a candidate for human sign-off, not a forced unit test.

## The agent reports; the user judges (not a blocking gate)

Enforcement is **not** a blocking gate that certifies correctness — no gate can (§ honest limit; false-green). The agent's contract is two things:

1. **Fidelity** — generate to the spec the user gave (the cases, clarified per step 2).
2. **Transparency** — lay out clearly what it did: which cases pass/fail (fresh evidence), what is still uncertain, and what is subjective (→ user sign-off).

Split cleanly: **the tests verify code-conforms-to-the-cases** (mechanical, fidelity); **the user verifies the-cases-are-right** (judgment, intent). The agent reports both layers; the **final acceptance is the user's call**. If a shipped result is still wrong after the agent faithfully generated to spec and reported honestly, the gap is upstream — insufficient clarification or analysis (§ honest limit) — not a missing machine gate. So: **don't block; list, explain, and let the user judge.** "Report" means surface it in the turn where you finish — so the user *can* judge and intervene — **not** halt-and-wait for explicit sign-off on every task (that would just be a blocking gate by another name; user review is async). (Kept out of `conformance.yaml` on purpose — it never forces itself on a downstream that didn't choose it.)
