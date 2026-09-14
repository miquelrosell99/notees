# Task Breakdown — notees-gtk MVP

Execution contract for the plan in `prd.md`. Six tasks, strictly ordered (each consumes only the
interfaces of earlier tasks). Each task ends with a literal acceptance check; implementers run the
check before committing.

## Global Constraints

- Python `>=3.12` (dev box has 3.11 + `uv`; use `uv python install 3.12` / `uv venv --python 3.12`).
- Ruff: line length 120, select `E,W,F,I,N,UP,B,C4,SIM`, ignore `E501`; Google docstrings.
- mypy: `disallow_untyped_defs = true`, `ignore_missing_imports = true`.
- Dependencies: `httpx`, `pydantic>=2`, `uuid7>=0.1.0`; PyGObject only under the `[ui]` extra. Stdlib
  everywhere else (`sqlite3`, `json`, `datetime`). No other third-party deps.
- License AGPL-3.0; Conventional Commits; stage only task-owned files.
- Copied fixtures under `tests/fixtures/` stay byte-identical to `protocol/fixtures/` in this repo
  (`/etc/periphery/stacks/notees/protocol/fixtures/`).
- Local repo path: `/etc/periphery/stacks/notees-gtk` (sibling of this repo, fleet convention).
- GitHub remote: create as **public** under `miquelrosell99` via `gh` (already authenticated).

## Task 1 — Repo skeleton + tooling

- **Files**: owns everything at the new repo root: `pyproject.toml`, `.gitignore`, `LICENSE`,
  `README.md` (stub), `.github/workflows/ci.yml`, `src/notees_gtk/__init__.py`,
  `src/notees_gtk/config.py`, `src/notees_gtk/main.py` (placeholder `run()`), `tests/conftest.py`.
- **Consumes**: nothing (greenfield).
- **Produces**:
  - Installable package `notees-gtk` (src layout, hatchling), console script `notees-gtk =
    notees_gtk.main:run`.
  - `config.py`: `@dataclass(frozen=True) class ClientConfig` with `server_url: str`,
    `data_dir: Path`, `token: str | None = None`.
  - Commands that must work: `uv sync`, `uv run pytest`, `uv run ruff check`, `uv run mypy src`.
  - CI (`.github/workflows/ci.yml`, ubuntu-latest): setup Python 3.12 + uv, run the same three
    commands on push/PR to `main`.
  - GitHub repo created and pushed: `gh repo create miquelrosell99/notees-gtk --public --source .
    --push --description "First-class GTK/Adwaita desktop client for Notees"`.
- **Acceptance**: the three commands exit 0 on a fresh clone-less dir; `gh repo view
  miquelrosell99/notees-gtk --json visibility` prints `PUBLIC`.

## Task 2 — Protocol core (fixtures-validated)

- **Files**: owns `src/notees_gtk/core/__init__.py`, `src/notees_gtk/core/protocol/{__init__.py,
  clock.py,models.py,op_types.py}`; `tests/fixtures/*.json` (6 files copied from
  `/etc/periphery/stacks/notees/protocol/fixtures/`); `tests/{test_fixtures.py,test_clock.py,
  test_envelope.py}`.
- **Consumes**: SPEC §1–3; `app/core/clock.py`; fixture JSONs.
- **Produces**:
  - `clock.py`: frozen pydantic `Hlc(BaseModel)` (`physical: int = Field(ge=0)`, `logical: int =
    Field(ge=0)`); `compare_hlc(a, b) -> int`; `max_hlc(a, b) -> Hlc`; `class Clock` with
    `advance(physical_time: int) -> Hlc` and `update(received: Hlc, physical_time: int) -> Hlc` —
    semantics ported line-for-line from `app/core/clock.py` (advance resets logical when physical
    moves forward; update takes max and increments the right logical branch).
  - `op_types.py`: `KNOWN_OP_TYPES: frozenset[str]` — the full §3 list.
  - `models.py` (pydantic v2, `populate_by_name=True`, camelCase aliases, UTC timestamps serialize as
    `...Z` like the backend): `RelayEnvelope` (`id` default uuid7 string; `protocol_version: int = 1`;
    `workspace_id`; `actor_id`; `hlc: Hlc`; `affected_node_ids: list[str] = []`; `op_type`;
    `timestamp: datetime | None`; `payload: dict[str, Any]`), `BatchRequest`, `CatchUpRequest`
    (snake_case wire — fixture round-trips *without* aliases), `CatchUpPaginatedResponse`,
    `WsHelloMessage`, `WsOpsMessage`. Validation: `op_type` must be in `KNOWN_OP_TYPES`; HLC fields
    `ge=0`; `MAX_ENVELOPE_SIZE_BYTES = 1_000_000` exported.
  - `new_envelope(*, workspace_id, actor_id, op_type, payload, clock: Clock,
    affected_node_ids: Sequence[str] = (), now_ms: Callable[[], int]) -> RelayEnvelope` — stamps uuid7
    id, `clock.advance(now_ms())`, UTC timestamp.
- **Acceptance**: `uv run pytest tests/test_fixtures.py` — every fixture round-trips
  (`model_validate` → `model_dump(mode="json", by_alias=...)` equals raw bytes parsed), every fixture
  file is covered, `protocolVersion` defaults to 1, snake_case envelope accepted and re-serializes to
  the camelCase fixture; `test_clock.py` ports the advance/update matrix from `app/core/clock.py`;
  unknown `opType` and negative HLC raise `ValidationError`; oversized payload (>1 MB) rejected by the
  size helper.

## Task 3 — REST API client

- **Files**: owns `src/notees_gtk/core/api/{__init__.py,errors.py,client.py}`;
  `tests/test_api_client.py`. Shares (read-only): `config.py`, protocol models.
- **Consumes**: Task 2 models; SPEC §4; `app/features/auth/router.py` (login + 2FA + refresh shapes).
- **Produces**:
  - `errors.py`: `ApiError(Exception)` (`.status: int | None`, `.detail: str`); subclasses
    `AuthenticationError` (401), `ForbiddenError` (403), `QuarantinedError` (other 4xx),
    `RateLimitedError` (429, `.retry_after: float | None`), `ServerError` (5xx), `NetworkError`
    (no response). `classify_response(resp) -> None` raising the right subclass.
  - `client.py`: `AuthResult(BaseModel)` (`access_token`, `token_type`, `user: dict[str, Any]`);
    `TwoFactorRequired(Exception)` (`.preauth_token`, `.purpose`); `WorkspaceRef(BaseModel)`
    (`uuid`, `name`, `is_active`).
  - `class NoteesClient:` — `__init__(base_url: str, *, token: str | None = None, transport:
    httpx.BaseTransport | None = None, timeout: float = 30.0)`; methods:
    - `login(email, password, *, remember_me=True, totp: str | None = None) -> AuthResult` —
      `POST /api/auth/login`; when the response carries `preauth_token`+`purpose`, raise
      `TwoFactorRequired` (or, if `totp` was supplied, first `POST` the 2FA verify endpoint — confirm
      exact path/body from `app/features/auth/router.py`). Success sets the bearer header.
    - `list_workspaces() -> list[WorkspaceRef]` — `GET /api/workspaces/` **with trailing slash**;
      unwrap `PaginatedResponse.items` (gotcha: no-slash 404s via SPA fallback).
    - `submit_batch(envelopes: list[RelayEnvelope]) -> list[str]` — `POST /api/relay/batch` →
      `saved_ids`; client-side pre-check: ≤1000 envelopes, each payload ≤1 MB.
    - `catch_up(workspace_id, after_seq=0, limit=1000) -> CatchUpPaginatedResponse` —
      `POST /api/relay/catch-up`.
    - `snapshot_probe(workspace_id) -> SnapshotMeta` (`snapshot_id`, `workspace_id`, `hlc`, 
      `has_snapshot`, `restore_epoch`, `up_to_seq: int | None`).
    - `snapshot_data(workspace_id) -> bytes`; `stats(workspace_id) -> dict[str, Any]`.
- **Acceptance**: `tests/test_api_client.py` with `httpx.MockTransport`: asserts exact request paths
  (incl. `/api/workspaces/` trailing slash) and bodies matching fixture shapes; login stores bearer;
  2FA gate raises `TwoFactorRequired`; workspaces `items` unwrapped; 401→AuthenticationError,
  403→ForbiddenError, 422→QuarantinedError, 429→RateLimitedError, 500→ServerError,
  `httpx.TransportError`→NetworkError; 1001-envelope batch rejected client-side.

## Task 4 — Local store + sync engine

- **Files**: owns `src/notees_gtk/data/{__init__.py,store.py}`, `src/notees_gtk/core/sync/
  {__init__.py,engine.py}`; `tests/{test_store.py,test_sync_engine.py}`. Shares (read-only): Tasks 2–3.
- **Consumes**: Task 2 envelopes/clock, Task 3 client+errors; `mobile-sync.md` (outbox, quarantine,
  watermark, LWW, idempotent migrations, gotchas); SPEC §4.2–4.3; `app/core/derived/node.py`.
- **Produces**:
  - `store.py`: `class LocalStore` — sqlite3, WAL, `PRAGMA user_version` migrations where every
    schema change is idempotent (`_add_column_if_missing`-style guards, mirroring the mobile gotcha).
    Tables: `relay_outbox(id INTEGER PK AUTOINCREMENT, envelope_json TEXT NOT NULL, workspace_id TEXT
    NOT NULL, state TEXT NOT NULL DEFAULT 'pending', quarantine_reason TEXT, created_at TEXT NOT
    NULL)`; `relay_operations(op_id TEXT PK, workspace_id TEXT NOT NULL, seq INTEGER,
    applied_at TEXT NOT NULL)` (op-id dedupe); `sync_watermark(workspace_id TEXT PK, cursor_seq
    INTEGER NOT NULL DEFAULT 0, restore_epoch INTEGER NOT NULL DEFAULT 0)`; `nodes(workspace_id TEXT
    NOT NULL, id TEXT NOT NULL, parent_id TEXT, node_type TEXT NOT NULL, name TEXT NOT NULL DEFAULT
    '', icon TEXT, color TEXT, archived INTEGER NOT NULL DEFAULT 0, content TEXT, updated_at TEXT NOT
    NULL, PRIMARY KEY (workspace_id, id))`; `node_content_hlc(node_id TEXT PK, physical INTEGER NOT
    NULL, logical INTEGER NOT NULL)`.
  - `NodeRow` (frozen dataclass): `id: str`, `workspace_id: str`, `parent_id: str | None`,
    `node_type: str`, `name: str`, `icon: str | None`, `color: str | None`, `archived: bool`,
    `content: str | None` (raw mirror string; unwrapped on render in Task 5).
  - Methods: `enqueue(env) -> None`; `pending_outbox(workspace_id, limit=100) ->
    list[RelayEnvelope]`; `mark_outbox_sent(ids) -> None`; `quarantine_outbox(ids, reason) -> None`;
    `apply_remote(env) -> bool` (dedupe by op id → applier → True if applied); `cursor(workspace_id)
    -> int`; `set_cursor(workspace_id, seq) -> None`; `stored_restore_epoch(workspace_id) -> int`;
    `set_restore_epoch(workspace_id, epoch) -> None`; `wipe(workspace_id) -> None` (all tables);
    `nodes(workspace_id, parent_id: str | None = None, include_archived=False) -> list[NodeRow]`;
    `node(workspace_id, node_id) -> NodeRow | None`; `close() -> None`.
  - Applier subset (payload field names copied from `frontend/src/core/types/operation.ts`):
    `node.create`, `node.delete`, `node.move`, `node.updateContent`, `node.updateIcon`,
    `node.updateColor`, `node.archive`, `node.restore`. Unknown op types: logged and skipped (Flutter
    rule). `node.updateContent`: LWW via `node_content_hlc` — skip when incoming HLC ≤ stored; payload
    `content` accepted as JSON string, AST list, or `None` (store string form verbatim, like the
    server mirror).
  - `engine.py`: `class SyncEngine` — `__init__(client: NoteesClient, store: LocalStore, *,
    actor_id: str, workspace_id: str)`:
    - `push() -> PushResult(sent: int, quarantined: int)`: drain outbox in chunks of 100;
      whole-chunk ack semantics (HTTP 200 → remove the whole chunk from the outbox, even though
      `saved_ids` may omit duplicate ids — server dedupes); 401/403 → re-raise as
      `AuthenticationError`; other 4xx → quarantine chunk; network/5xx/429 → exponential backoff
      `[5, 15, 60, 300, 1800]` s (429 honors `Retry-After` when present), give up this round.
    - `pull() -> PullResult(applied: int, cursor: int)`: paged `catch_up` from stored cursor;
      `apply_remote` each envelope (dedupe makes catch-up/live overlap harmless); persist cursor after
      every page (mid-page crash re-fetches only the tail); adopt final `next_after_seq`.
    - `sync() -> None`: `push()` then `pull()`.
    - `maybe_restore_snapshot() -> bool`: probe — if server `restore_epoch` ≠ stored → `wipe`, reset
      cursor to 0; if `has_snapshot` and `up_to_seq` > cursor → download blob, copy the column
      intersection into `nodes` (snapshot is a serialized derived SQLite DB — ATTACH the blob, guarded
      `INSERT OR REPLACE` selecting only columns that exist in the client table; unreadable/foreign
      schema → log and return False without touching state), set cursor = `up_to_seq`, persist
      `restore_epoch`.
- **Acceptance**: fake-`NoteesClient` tests (hand-rolled fake, not a mocking framework): full
  push→pull loop converges a fake relay; duplicate envelope ids never double-apply; stale
  `updateContent` skipped by LWW while newer applies; 422 chunk lands in quarantine and is not retried;
  server `restore_epoch` change wipes cursor + cache; newer snapshot restores nodes and sets cursor;
  migrations run idempotently (open a fresh DB twice; simulate a version bump on an existing DB).

## Task 5 — GTK/Adwaita UI

- **Files**: owns `src/notees_gtk/main.py` (real `run()`), `src/notees_gtk/ui/{__init__.py,app.py,
  login.py,window.py,tree.py,page_view.py,ast_render.py,editor.py}`; modifies `pyproject.toml` (add
  `[ui]` extra: `PyGObject>=3.50`); `tests/test_ast_render.py`. Shares (read-only): Tasks 2–4.
- **Consumes**: `LocalStore`, `SyncEngine`, `NoteesClient`, `new_envelope`, protocol models.
- **Produces**:
  - `ast_render.py`: **pure** `ast_to_view(ast_json: str | list | None) -> PageView` (headless-
    testable): unwraps the CRDT wrapper (port of `unwrapCrdtContentAst`,
    `frontend/src/lib/astBuilder.ts:561`), maps blocks to view records — heading (level), paragraph
    (inline runs: text + marks strong/em/strikethrough/highlight/code + `node_link` pill resolved via
    store lookup, fallback label → target UUID, never "…" per `rules/coding-standards.md`), todo
    (checked + text), code (literal), math (latex source), whiteboard/query → placeholder block.
  - `app.py`: `NoteesApp(Adw.Application)`; `login.py`: server URL (default `http://localhost:8001`),
    email, password, TOTP field, `Adw.Toast` errors; `window.py`: `Adw.ApplicationWindow` with
    `Adw.NavigationSplitView` — sidebar (`tree.py`: workspace switcher + flat-indented node list from
    `LocalStore.nodes()`, expand/collapse, archived hidden) + content (`page_view.py`: title, rendered
    blocks read-only); `editor.py`: edit toggle → `Gtk.TextView` seeded with `ast_to_plaintext`,
    save → rebuild `[{type:"paragraph",children:[{type:"text",text:...}]}]` AST →
    `store.enqueue(new_envelope(op_type="node.updateContent", payload={"nodeId": id, "content":
    json.dumps(ast)}))` → `SyncEngine.sync()`; sync-on-open and sync-on-interval (30 s) wired in
    `window.py`.
  - GTK imports confined to `ui/` modules (`import gi; gi.require_version(...)` at module top); a
    `pytest.importorskip("gi")` smoke test that only imports `ast_render` (skipped on this box).
- **Acceptance**: `uv run ruff check && uv run mypy src` clean; `uv run pytest` green (logic tests for
  `ast_render` including unwrap + node_link fallback); GTK runtime check explicitly deferred (no GTK on
  this machine — README documents `pip install .[ui]` + `notees-gtk` to run on a GTK host).

## Task 6 — Docs + release

- **Files**: owns `README.md` (complete), `pyproject.toml` metadata (project urls), CI badge/README
  final check. Shares (read-only): everything.
- **Consumes**: Tasks 1–5.
- **Produces**: README — what it is, screenshot placeholder, features (sync model, 2FA, offline
  outbox), dev setup (`uv python install 3.12 && uv sync`, run against the notees compose.dev backend
  at `http://localhost:8001`, `notees-gtk` to launch, tests/lint/typecheck commands), GTK system
  dependency note (libadwaita), AGPL-3.0 license, "not yet on Flathub" note.
- **Acceptance**: `uv sync && uv run pytest && uv run ruff check && uv run mypy src` all exit 0 from a
  clean checkout; commits follow Conventional Commits; `git push origin main` succeeds;
  `gh repo view miquelrosell99/notees-gtk --json visibility` prints `PUBLIC`; README renders
  (no broken anchors).
