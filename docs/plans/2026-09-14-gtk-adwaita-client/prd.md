---
status: done
created: 2026-09-14
implemented: 2026-09-15
distilled_to: [protocol/SPEC.md, skills/notees/rules/project-rules.md, skills/notees/references/gotchas.md, skills/notees/references/tech-stack.md, skills/notees/SKILL.md]
---

# GTK/Adwaita Desktop Client — Notees

Canonical plan. Approved by owner directive 2026-09-14 ("write a plan for it, then implement in a new
public repo"). The design discussion and option weighing happened in-session on 2026-09-14; conclusions
are recorded under *Options Considered* so they survive context loss.

## Context

Notees has two first-class clients today: the React web client (also shipped as a PWA) and the Flutter
mobile client (`miquelrosell99/notees-flutter`, public). The owner wants a native Linux/GNOME client.
The relay protocol is the only sync path and was explicitly designed to allow non-JS clients: the
Flutter client syncs with no CRDT library at all, using the plaintext `content` mirror plus HLC
last-write-wins (`skills/notees/references/agents/mobile-sync.md`).

## Problem

Create a new public repo `miquelrosell99/notees-gtk` implementing a native GTK4/libadwaita client that
speaks Notees relay protocol v1: authentication (including 2FA), operation-log sync (batch push / paged
catch-up / snapshot restore), a local derived SQLite cache, and a usable UI — workspace and page-tree
browsing, read-only AST rendering, and basic plain-text editing — proving the full client loop
end-to-end.

## Options Considered

1. **Electron wrapper around the web client** — rejected. The web client is already a PWA
   (`vite-plugin-pwa`), so "installable desktop app" is covered; Electron adds a bundled Chromium
   (RAM, ~150 MB, larger attack surface) to a privacy-first, local-first app and yields zero native UX.
2. **Tauri wrapper** — rejected for MVP. Smaller than Electron and a fine future Win/macOS shell, but
   on Linux it renders with WebKitGTK anyway: it duplicates the PWA rather than adding a native
   experience.
3. **GTK/Adwaita native client** — chosen. Fits the self-hosted/privacy-first audience; real native UX
   (system theme, dark mode, accessibility, portals); the protocol demonstrably supports non-JS
   clients (Flutter proves it).
4. **Rust stack (gtk4-rs + yrs)** — deferred. `yrs` is the Yjs team's Rust CRDT and would keep live
   co-editing on the table, but every applier would be rewritten in Rust with slower iteration. Python
   shares the backend's language: wire models can mirror `app/relay/models.py` line-for-line, and
   `pycrdt` stays available if CRDT interop is ever wanted.

## Chosen Approach

Python 3.12+ package `notees-gtk`: PyGObject/GTK4/libadwaita UI, `httpx` + `pydantic v2` core
mirroring the backend's wire models, stdlib `sqlite3` derived cache. No CRDT: emit and consume the
plaintext `content` mirror like the Flutter client; conflicts resolve by HLC last-write-wins. HTTP-only
sync in MVP — SPEC §5's WebSocket is "an acceleration path, never a second consistency model". E2EE
(protocolVersion 2 envelopes) fails loud, like Flutter
(`mobile-sync.md` § Protocol version and E2EE stance).

## Requirements & Acceptance Criteria

| # | Requirement | Acceptance |
|---|---|---|
| R1 | Repo skeleton + tooling | `uv sync`, then `uv run ruff check`, `uv run mypy src`, `uv run pytest` all green on Python 3.12; GitHub Actions CI runs the same three |
| R2 | Protocol core | All 6 fixtures from `protocol/fixtures/` round-trip through client models; HLC merge semantics mirror `app/core/clock.py`; negative HLC, unknown `opType`, >1 MB payload rejected; snake_case envelopes accepted |
| R3 | API client | Mock-transport tests: login (bearer + 2FA preauth), `GET /api/workspaces/` trailing-slash + `items` unwrap, relay batch/catch-up/snapshot shapes, error taxonomy for 401/403/4xx/429/5xx/network |
| R4 | Store + sync engine | Fake-relay tests: outbox chunks of 100 with whole-chunk ack, 4xx quarantine, network/5xx backoff schedule, paged catch-up with per-page cursor + op-id dedupe, snapshot restore when newer, `restore_epoch` change wipes state, `node_content_hlc` LWW skip, idempotent migrations |
| R5 | UI | Adwaita app: login page, workspace switcher, page-tree sidebar, read-only rendering of AST subset (paragraph/heading/todo/code/math + inline marks, `node_link` pill), plain-text edit mode emitting `node.updateContent` with string `content` |
| R6 | Docs + release | README with dev setup against the compose.dev backend (`http://localhost:8001`), AGPL-3.0 license, `notees-gtk` entry point; `PKGBUILD` (Arch) + `release.yml` CI that builds sdist/wheel and the Arch package in an `archlinux` container — no local builds; artifacts on CI runs, release assets on `v*` tags; repo public on GitHub |

## Out of Scope

CRDT/Yjs collaborative editing; WebSocket + presence; whiteboard/query block editing; E2EE (v2
envelopes rejected loudly, like Flutter); plugins; asset upload UI; Flatpak/Flathub packaging (README
mention only); Windows/macOS targets; token refresh (re-login on expiry); offline editing conflict UI
(beyond LWW semantics).

## Open Questions

- **Repo name** — assumed `notees-gtk` (parallel to `notees-flutter`); trivially renameable before
  first release.
- **UI runtime verification** — this dev box has no GTK libraries and only Python 3.11; the core is
  fully headless-testable (R2–R4), UI acceptance is lint/type-clean plus manual run on a GTK machine
  (tracked as follow-up, not blocking MVP).
- **2FA verify endpoint path** — confirm from `app/features/auth/router.py` during the API-client task
  (login returns `TwoFactorRequiredResponse{preauth_token, purpose}` when `totp_enabled`).
- **Snapshot blob format** — a snapshot is a serialized derived-state SQLite database (SPEC §4.3) whose
  schema is the *server's* derived schema; the restore path copies the column intersection with the
  client cache schema and sets the cursor to `up_to_seq`.

## Reading List (implementer)

- `protocol/SPEC.md` — whole file; §1–3 envelope/op model, §4 HTTP, §6 limits
- `skills/notees/references/agents/mobile-sync.md` — the proven non-CRDT client pattern (outbox,
  quarantine, watermark, LWW, gotchas)
- `app/core/clock.py` — HLC semantics to port
- `app/relay/models.py` — pydantic wire models to mirror
- `app/features/auth/router.py` — login / 2FA / refresh shapes
- `app/core/derived/node.py` (`apply_node_update_content`) — server-side content semantics
- `frontend/src/types/ast.ts` — AST block/inline type union
- `frontend/src/lib/astBuilder.ts:525-578` — `unwrapCrdtContentAst` to port
- `frontend/src/core/types/operation.ts` — payload shapes for the op subset
- `docs/plans/2026-09-14-gtk-adwaita-client/tasks.md` — task breakdown (execution contract)

## Outcome (2026-09-15)

Shipped as `miquelrosell99/notees-gtk` (public, AGPL-3.0): 29 commits, 189 tests, CI + Release
workflows green; CI builds sdist/wheel + Arch package (`notees-gtk-git`) per the no-local-builds
directive; final whole-branch review passed after one fix wave (real-schema snapshot restore,
protocol-version fail-loud, HLC clock merge). Mid-flight owner directives folded into the plan:
`uuid7` dependency replaced with an in-repo RFC 9562 generator, and CI-as-builder. Deferred
follow-ups (GTK-host manual run, tag-release path untested, accepted Minor roll-up) live in
`.superpowers/sdd/progress.md` and the final review reports.
