# Subagent Verification Patterns

> Extends [`../workflows/subagent-driven.md`](../workflows/subagent-driven.md). Its two-stage review checks **worker compliance** — did the worker follow its contract (Stage A) and meet quality bars (Stage B). These two patterns cover what compliance review cannot: **is the worker's conclusion actually correct**, and **did the sweep find everything**. Reach for them only when a subagent's *output is a judgment or a discovery*, not a mechanical edit a test can settle.

Harness-agnostic. "Dispatch a verifier" = your harness's subagent primitive (Claude Code `Task`; degraded mode = reset mental context, re-read only the contract — see `../workflows/subagent-orchestration.md` § Degraded Mode). Each verifier / finder is an ordinary Subagent Contract (Goal / Inputs / Outputs / Forbidden / Acceptance), dispatched non-blocking per the Parallelism Premise.

## When NOT to reach for these

Both cost N× the dispatches of one pass. Skip them — the existing single review is enough — when:

- The worker's output is **mechanically checkable** (compiles, tests pass, `grep` settles it). The contract's Acceptance Criteria already decide correctness.
- The task list is **known and bounded** (refactor N sites, implement 3 subtasks). Use `subagent-driven.md` / `refactor-fanout.md` as-is.

Use them only when a **plausible-but-wrong** answer would survive a single review, or when the problem has **no known size**.

## Pattern 1 — Adversarial verification (uncertain findings)

A single review pass — even the two-stage one — can be fooled by a confident, wrong conclusion: a bug report that does not reproduce, a security finding that misread the flow, a research claim resting on a bad source. Compliance review asks "did the worker follow the contract"; it never asks "is the finding true."

**Mechanism.** For each finding worth trusting, dispatch **N independent verifiers** (3 is typical), each on a fresh context, each with a contract whose Goal is *refute this finding*. Default the verdict to **"not real / refuted when uncertain."** Keep the finding only if a majority fail to refute it.

- **Independence is the whole point** — each verifier sees only the claim, never the other verifiers nor the original worker's reasoning. Shared context produces correlated blind spots, which is exactly what voting exists to defeat.
- **Perspective-diverse variant** — when a finding can fail in more than one way, give each verifier a *distinct lens* (correctness / security / does-it-actually-reproduce) instead of N identical skeptics. Diversity catches failure modes redundancy cannot.

## Pattern 2 — Loop-until-dry (open-ended discovery)

`subagent-orchestration.md` Phase 1 assumes you can write the task list up front. For open-ended problems — *find all the bugs*, *every broken link*, *what edge cases are unhandled* — you cannot; a fixed-size sweep silently stops at whatever it happened to find first.

**Mechanism.** Dispatch a round of finder subagents, dedup their results against everything seen so far, then repeat. Stop only after **K consecutive rounds (2 is typical) surface nothing new.** The tail rounds are what catch the issues a one-shot sweep misses.

- **Dedup against *all seen*, not against *confirmed*** — otherwise a finding you already judged and rejected reappears every round and the loop never converges.
- **Multi-modal rounds** — vary how each finder searches (by file, by symbol, by data-flow, by recent change). Each angle is blind to what the others surface.
- **No silent caps** — if you bound a round (top-N, sampling, no retry), say so in the result. A silent truncation reads downstream as "covered everything" when it did not.

## Closing the loop

Both patterns feed the existing review, they do not replace it: a finding that survives adversarial verification, or a discovery loop that has gone dry, is what you merge or report. Run the Task Closure Protocol once at the end — not per verifier, not per round.
