# Graph physics: real clustering, real cluster separation, real equilibrium

**Date:** 2026-10-09
**Status:** SHIPPED — slice 1 `bf1abe4d` (per-node alpha, settle, local
reheat), slice 2 `e955c08a` (weighted full Louvain, soft shell, force
balance), slice 3 `c5a61fc5` (settings surface, docs). Post-approval
additions beyond the original text: the per-node reheat design (owner
constraint — dragging a node must not move distant nodes), the Louvain
phase-2 community merge pass with the corrected ΔQ, and the γ default of
0.8.
**Scope:** `apps/web/src/ui/views/graph/engine/` (+ `GraphView.tsx` settings surface)

## The problem

On the real 7.5k-node workspace the graph view renders as a uniform hairball
(see screenshot in the owner request): communities are invisible, everything
drifts in one blob, and the layout never truly settles — it is held still by
dampers while the worker ticks physics at 60 fps forever.

## Review findings

### 1. Equilibrium is faked, not reached (the "fake falloffs")

- `integrator.ts:59` — velocity is multiplied by `friction: 0.92` **every
  tick** (a tick every 16 ms, `worker.ts:31`). After one second a velocity is
  ~0.7 % of its original value. The system does not converge to a force
  balance; it freezes wherever the damping leaves it. Any residual force
  imbalance is masked, so the layout lands in a non-equilibrium state and
  small perturbations (drag, filter toggle) visibly re-jitter.
- `integrator.ts:63-64` — the `SLEEP_V = 1e-4` hard-zero clamp is a second
  fake stillness layer.
- `integrator.ts:55-58` — the `maxVelocity: 10` clamp is a third.
- `integrator.ts:74-82` — the adaptive timestep shrinks `dt` when energy
  *rises*, treating the symptom (stiff forces at fixed `dt`) instead of
  letting the force mix converge; it recovers at 1.02× per tick, i.e. it
  fights itself.
- `worker.ts:146-154` — `doTick` self-schedules at `TICK_MS` with **no
  stop condition**. `energy` is computed, shipped to the main thread, and
  never consumed (`engineController.ts` forwards it; `GraphView.tsx` has no
  reader — confirmed by grep). The sim runs at 60 fps for as long as the
  view is open, burning a worker + wakeups on a settled graph.
- `engine.ts:7` — the docstring advertises "Alpha cooling for natural
  settling", and every force has an `apply(alpha)` parameter… but
  `engine.ts:579` calls `f.apply(1.0)` and **all six forces ignore the
  parameter**. No alpha mechanism exists; it is a vestige.
- `types.ts:32` — `damping: 0.85` sits in the raw config and is never read
  (the integrator reads `friction`). Dead key.

### 2. Clustering does not materialize

- **Cohesion is two orders of magnitude too weak.**
  `clusterStrength = 0.0012 × 1.8 = 0.00216` (`config.ts:55`) vs
  `springStrength ≈ 0.025` and `localRepelStrength ≈ 3360`. The
  `ClusterCohesionForce` shell spring cannot hold a community together
  against local node repulsion — clusters dissolve into the blob.
- **Cluster repulsion per node is diluted to nothing.**
  `clusterRepulsion.ts:60-61` distributes the centroid force as `clFx / cnt`.
  A 200-node community's share of the pairwise force is 1/200 per member;
  against that, inter-cluster springs (rest ×1.6, stiffness ×0.7,
  `engine.ts:458-460`) actively stitch communities together. Repulsion loses.
- **No size-aware separation.** The repulsion law
  `repelStr · √(mA·mB) / (d·200)` (`barnesHut.ts:151`) has no notion of
  cluster radius, so a small community can sit inside a large one's
  "shadow"; `clusterSpacing` (350–450) only seeds *initial* positions
  (`engine.ts:523`) and plays no role in the dynamics.
- **Local repel range shrinks with N.** `localRepel.ts:23` scales the radius
  by `√(1000/N)`; at 7.5k nodes it is ~183 px, so beyond that range nothing
  pushes overlapping communities apart except the diluted centroid force.
- **Louvain is unweighted.** `detectCommunities` counts every edge equally,
  so a `cooccurrence`/`temporal` edge (rest ×1.6–2.0, deliberately loose)
  defines a community as strongly as a `parent` edge (rest ×0.6,
  semi-rigid). The detected communities structurally resist tight packing.

### 3. The fakes exist because the raw mix is unstable

`springStrength 0.040` (compact) with `dt 0.5` and compression multipliers
up to ×3.0 (`types.ts:111`) put the Verlet integrator at the edge of
stability — the warmup runs 50 ticks at `dt × 2` (`worker.ts:33-34,156-162`),
which is why the oscillation detector trips in practice. The damping stack is
load-bearing *because* the force constants fight each other; fix the mix and
the fakes can go.

## Proposal

Three slices, landed in order. Each is independently verifiable.

### Slice 1 — Energy-gated alpha: reach equilibrium, then stop

Make settling a first-class engine state instead of a damping artifact.

1. Add a real `alpha` to `GraphEngine` (d3-force model):
   - `alpha` starts at 1; each tick `alpha += (alphaTarget − alpha) · alphaDecay`,
     `alphaTarget = 0`, `alphaDecay ≈ 0.02` (config keys `alphaDecay`,
     `alphaMin ≈ 0.005`).
   - `step()` passes `alpha` to every `ForcePlugin.apply(alpha)` — the
     parameter finally does what the interface promises. (Keep alpha out of
     pinned-node bookkeeping.)
2. Quiescence stop: when `alpha < alphaMin` **and** average kinetic energy
   has stayed below an epsilon for M consecutive ticks (M ≈ 30), the engine
   marks itself `settled` and the worker **stops the `doTick` clock**
   (`running = false`, no more 16 ms wakeups). Wake events reheat:
   `dragStart` → `alpha = max(alpha, 0.3)` and resume; `setTopology`,
   `setConfig`, `unpin`, `applyForce` → `alpha = 1` (or reheat only when
   actually settled — cheap either way). The existing `pause`/`resume` pref
   keeps working on top.
3. Retire the fake-stillness stack, in this order:
   - `friction 0.92` → replaced by alpha-scaled drag: velocity damping
     `1 − (1 − dragBase) · alpha` with `dragBase ≈ 0.6` (strong during
     warmup, ~none at equilibrium). This is the load-bearing change — the
     warmup must not explode, and the long tail must be force-driven.
   - `SLEEP_V` clamp: keep, but drop it to a genuinely negligible threshold
     (`1e-6`) and document it as a denormal-drift guard, not a stillness
     mechanism. At true equilibrium velocities pass through small values
     naturally on their way to zero force balance.
   - `maxVelocity`: keep as a safety clamp during warmup (reheat can inject
     energy); it should never bind at equilibrium.
   - Adaptive `dt`: keep (it is a real stabilizer) but let it recover fully
     once `alpha` is high; remove the 1.02× crawl in favour of restoring
     `cfg.dt` directly when energy is falling.
4. Remove the dead `damping` key from `GraphEngineConfig`.
5. Expose `settled` in the worker's frame message so the UI can show a
   "settled" affordance later (optional this slice — the wire field is
   additive and trivial).

**Verification:** unit tests — alpha decays monotonically; forces scale with
alpha; after N ticks on a small fixture graph `energy → epsilon` and
`settled === true`; a reheat event un-settles. Manual: open the 7.5k graph,
watch it animate, settle, and the worker go quiet (CPU idle in devtools);
drag a node → brief reheat → settles again.

### Slice 2 — Cluster forces that produce visible islands

1. **Strengthen cohesion ~5–10×:** `clusterStrength` from `0.0012·mult` to
   `0.006·mult` (preset-tunable), keeping the shell model and its
   `idealDistance × 6` cap (`clusterCohesion.ts:38`) so clusters stay
   internally airy.
2. **Size-aware soft-shell cluster repulsion** (the core of
   "cluster-to-cluster separation"): per-cluster radius
   `rC = idealDistance · 0.5 · √(cnt)` — the same shell cohesion already
   uses. Repulsion engages when centroid distance
   `d < rA + rB + margin` (margin ≈ `clusterSpacing`, which becomes a
   *dynamic* quantity, not just a seed), with a smooth `t²` envelope like
   `componentBubble.ts:72-77`, **plus** the existing long-range 1/d
   Barnes–Hut term so the global spread keeps working beyond contact.
   Centroid forces are distributed as `clFx / √cnt` (not `/ cnt`) so a large
   community moves as a unit instead of being diluted per member — the
   current dilution is the main reason big communities smear.
3. **Loosen inter-cluster bridges:** rest multiplier 1.6 → 2.2, stiffness
   0.7 → 0.35 for inter-cluster edges (`engine.ts:458-460`) — bridges stay
   visible but stop welding communities into one mass.
4. **Weight Louvain by link type:** in `detectCommunities`, weight each
   adjacency edge by `1 / LINK_REST_MULT[type]` (structural links count
   most, cooccurrence least). Communities then match the visual notion of a
   cluster, and cohesion/repulsion work *with* the spring structure instead
   of against it.

**Risk & mitigation:** stronger cohesion + weakened bridges can strand
low-degree nodes at the end of long springs; the alpha reheat from Slice 1
keeps them finding their place on interaction, and the shell cap prevents
clusters from collapsing into single points. If the eyeball test shows
strays, raise inter-cluster stiffness to 0.5 (one constant).

**Verification:** unit test — two bridged fixture communities end with
centroid distance > rA + rB; intra-cluster mean pairwise distance stays
within the shell; a cooccurrence-only bridge does not merge communities in
`detectCommunities`. Manual: screenshot before/after on the test workspace
(`c491595f-…`, law 8) — islands visible at whole-graph zoom, bridges thin.

### Slice 3 — Settings surface + records

1. The `clustering` toggle is hardcoded `true` in `GraphView.tsx:335,515`
   and never read from prefs. Either expose it (Simulation section) or drop
   it from `GraphEnginePhysicsConfig`; the owner-facing default stays on.
2. Add a **Cluster separation** slider (0–100) mapped to the soft-shell
   `margin` (0 → margin 0.5× clusterSpacing, 100 → 2×) so separation is
   owner-tunable without preset edits.
3. Docs + record (law 3/4): `docs/usage.md` graph section (Simulation
   paragraph), `CHANGELOG.md` entry, engine docstring made true (alpha
   cooling is real by then).

## Non-goals

- No change to the wire, store projections, or fixtures (this is
  client-local presentation physics — display state only).
- No new layout modes; fixed layouts (circle/tree) are untouched.
- No settings-sync across devices (already a parked follow-up from the v1
  register slice).
- Renderer changes beyond what labels/minimap need for the wider spreads
  (minimap already fits content — verify on Slice 2).

## Perf notes

Alpha stop alone removes a permanent 60 fps worker loop per open graph view.
Slice 2's soft shell is O(K) per cluster with the existing BH tree (K =
community count, already pooled); the `√cnt` distribution reuses the existing
member loop. No new allocations on the hot path.

## Suggested gate per slice

`pnpm typecheck && pnpm test` (web suites: engine, graph-controller,
graph-sizing, toolbar composition), plus the manual eyeball pass on the test
workspace per Slice 1/2 verification. Redeploy `notees-web` after each
landed slice per the redeploy law.
