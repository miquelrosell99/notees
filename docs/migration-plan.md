# Notees Fleet Migration Plan

This plan brings Notees into compliance with the RosellRamos fleet skills:
`fleet-migration`, `design-system`, `ui-ux-audit`, `accessibility-primer`,
`performance-optimizer`, `security-hardening`, `codebase-organizer`,
`react-ui-patterns`, `fastapi-patterns`, and `frontend-design`.

It is intentionally phased so the app stays buildable and testable after every
step. **Do not attempt to land all phases in one commit.**

---

## Executive summary

| | |
|---|---|
| **Current state** | Strong foundations (tokens, hexagonal repo layer, documented identity) but significant drift in security, architecture, token discipline, and accessibility. |
| **Target state** | Fleet-compliant React + FastAPI self-hosted app with zero P0/P1 audit findings, accurate `AGENTS.md`, and a distinctive visual identity. |
| **Estimated effort** | 6–8 focused phases; security blockers first. |
| **Biggest risks** | SQL-injection path and global batch rate limiter are live P0s. Router-level SQL refactor touches many endpoints. |
| **Key decision** | Block bullets remain **circular** (product-owner preference); design language updated to match. |

---

## Audit snapshot

### P0 — Blockers

| # | Finding | Location |
|---|---|---|
| P0.1 | SQL injection via unvalidated QueryAST `flag_name` | `app/routers/nodes/views.py`, `app/domain/services/query_ast_sql.py`, `app/domain/entities/query_ast.py` |
| P0.2 | Batch rate limiters use a single global bucket; bulk-import header bypasses limits | `app/routers/nodes/batch.py` |
| P0.3 | Debug keystore is not tracked despite `AGENTS.md` claiming it is | `mobile/debug.keystore`, `mobile/.gitignore` |

### P1 — Critical

| # | Finding | Location |
|---|---|---|
| P1.1 | Unbounded `pages_only` list endpoint | `app/routers/nodes/crud.py`, `app/domain/repositories/postgres_node_search.py` |
| P1.2 | Auth logs include email addresses (PII) | `app/auth.py`, `app/routers/auth.py` |
| P1.3 | HSTS / HTTPS redirect gated on `reload=True` | `app/main.py` |
| P1.4 | Admin password update bypasses complexity policy | `app/models.py`, `app/routers/admin.py` |
| P1.5 | CORS credentials enabled without origin gating | `app/config.py`, `app/main.py` |
| P1.6 | Routers contain ~196 direct DB calls and bypass services | `app/routers/**/*.py` |
| P1.7 | `UndoService` executes SQL directly; no repository | `app/domain/services/undo_service.py` |
| P1.8 | Raw SQL outside repositories (`auth.py`, `workspace_manager.py`, `node_export.py`, `main.py`) | Multiple |
| P1.9 | Routers import concrete `Postgres*` repositories | Multiple |
| P1.10 | `AGENTS.md` architecture claims are inaccurate | `AGENTS.md` |
| P1.11 | `components/ui/` atoms import domain components/stores | `components/ui/Table.tsx`, `CalendarPopup.tsx`, `DatePickerPopup.tsx`, `SearchBox.tsx` |
| P1.12 | Hardcoded colors / fallback hex values | `FindReplaceWidget.css`, `NodeView.css`, `ImageModal.css`, `PresentationModal.css`, etc. |
| P1.13 | Default `:root` accent is `#404040`, not documented sage; `--color-on-accent` missing from `:root` | `frontend/src/variables.css` |
| P1.14 | Button radius scale ignores design tokens | `frontend/src/components/ui/Button.css` |
| P1.15 | Decorative glows/shadows violate “Zero Visual Noise” | `Button.css`, `BlockRow.css`, `WorkspaceManagementView.css` |
| P1.16 | Card default radius is 8 px, not 20 px | `frontend/src/components/ui/Card.css` |
| P1.17 | Icon-only touch targets below 44–48 px | `variables.css`, `Button.css`, `TabItem.css`, `TopBar.tsx` |
| P1.18 | Widespread `div role="button"` anti-patterns | `TabItem.tsx`, `PageHeader.tsx`, `NodeRef.tsx`, `KanbanCard.tsx`, `ListSortable.tsx`, `Table.tsx`, etc. |
| P1.19 | `outline: none` without visible focus replacement | `TextField.css`, `SearchField.css`, `SelectTrigger.css`, `PageHeader.css`, `GraphView.css`, etc. |
| P1.20 | Form labels not programmatically associated with inputs | `TextField.tsx`, `PropertyForm.tsx`, `WorkspaceNameModal.tsx` |
| P1.21 | Toast notifications lack `aria-live` | `NotificationToast.tsx` |
| P1.22 | Modal-like surfaces do not trap focus | `ButtonWithPanel.tsx`, mobile drawer, `Scratchpad.tsx`, `ImageModal.tsx`, `AccountMenu.tsx` |
| P1.23 | Hover-only actions hidden from keyboard/touch users | `CardItem.css`, `KanbanCard.tsx`, `TabItem.css`, `Table.tsx` |
| P1.24 | Hardcoded English strings in mobile app | `SetupActivity.kt`, `activity_setup_list.xml` |

### P2 — Warnings and P3 — Polish

Captured inside each phase below.

---

## Guiding principles for this migration

1. **Security first.** Close P0 findings before any visual or architectural polish.
2. **Keep it buildable.** Every phase ends with passing lint and the relevant test subset.
3. **Preserve user data and behaviour.** No schema migrations that destroy data unless explicitly required and backed up.
4. **Fix root causes.** Do not add frontend/backend compatibility code for bad data; fix the data/schema instead.
5. **Document deviations.** Any intentional fleet-skill deviation is recorded in `AGENTS.md` and this plan.

---

## Phase 1 — Security blockers (P0)

**Goal:** Eliminate live security risks and the mobile keystore discrepancy.

### 1.1 Whitelist QueryAST `flag_name` and validate before execution

**Why:** `POST /api/nodes/execute` accepts a raw `query_ast` dict and executes SQL
without validation. `_generate_flag_condition()` interpolates `flag_name` directly.

**Changes:**
- `app/domain/services/query_ast_sql.py`
  - Define `ALLOWED_FLAG_NAMES = {"is_page", "is_class", "is_day", "is_month",
    "is_year", "is_asset", "is_template", "is_comment", "is_private",
    "is_favorite", "active"}`.
  - In `_generate_flag_condition()`, return `None` or raise `DomainError` if
    `condition.flag_name` is not in the whitelist.
- `app/routers/nodes/views.py`
  - In `execute_query()`, call `validate_query_ast(ast)` before
    `executor.execute_query()`. Return HTTP 400 with a clear error if invalid.
- `tests/`
  - Add a test that submits a malicious `flag_name` like
    `"is_page; DROP TABLE node; --"` and asserts 400 / no data returned.
  - Add a test that a valid flag still works.

**Validation:**
- `ruff check app/`
- `docker exec … pytest tests/test_query_ast.py tests/test_nodes_views.py -v`

### 1.2 Fix batch rate limiters

**Why:** Current limiters use a single global bucket, so one IP can exhaust the
budget for all users. The `_skip_bulk_import` header also bypasses limits.

**Changes:**
- `app/routers/nodes/batch.py`
  - Replace custom limiters with `per_ip_limiter(60, Duration.MINUTE)`,
    `per_ip_limiter(120, Duration.MINUTE)`, etc.
  - Remove `_SkippableRateLimiter` and the `X-Bulk-Import` bypass, **or**
    gate it behind admin/API-key scope with explicit logging.
- Update any tests that relied on the bypass.

**Validation:**
- Run batch-operation tests at `tests/test_batch_operations.py`.

### 1.3 Track the debug keystore

**Why:** `AGENTS.md` states the debug keystore is checked in, but it is currently
untracked because `mobile/.gitignore` ignores `*.keystore`.

**Changes:**
- `mobile/.gitignore`
  - Remove or narrow `*.keystore`. Keep ignoring release keystores explicitly:
    ```gitignore
    /app/release
    *.apk
    notees-release.keystore
    keystore.properties
    ```
- Run `git add -f mobile/debug.keystore` and commit.

**Validation:**
- `git ls-files mobile/debug.keystore` returns the file.
- `mobile/build-apk.sh` still produces a debug APK.

---

## Phase 2 — Backend hardening (remaining P1 security)

**Goal:** Close all remaining P1 security gaps before architecture refactoring.

### 2.1 Bound `pages_only` list endpoint

**Changes:**
- `app/domain/repositories/postgres_node_search.py`
  - Change `get_all_pages(limit=None)` to `get_all_pages(limit: int = 1000)` and
    cap `limit` at e.g. 5000.
- `app/routers/nodes/crud.py`
  - Honor `page` / `page_size` for `pages_only=true` the same way the default
    branch does.

**Validation:**
- Add/update test for pagination on `pages_only`.

### 2.2 Redact PII from auth logs

**Changes:**
- `app/auth.py` and `app/routers/auth.py`
  - Replace email addresses in log messages with opaque `user_id` or a hash.
  - Example:
    ```python
    # Before
    logger.warning(f"Login failed for '{credentials.email}': user not found")
    # After
    logger.warning("Login failed: user not found")
    ```

**Validation:**
- Search for `f".*{credentials.email}.*"` patterns and confirm none remain.

### 2.3 Make HSTS / HTTPS redirect strictly environment-driven

**Changes:**
- `app/main.py`
  - Change `_is_production()` to:
    ```python
    def _is_production() -> bool:
        return settings.environment.lower() == "production"
    ```
  - Document in `AGENTS.md` that `ENVIRONMENT=production` is required for
    hardened headers.

**Validation:**
- Start backend with `ENVIRONMENT=production` and verify `Strict-Transport-Security`
  header is present.

### 2.4 Enforce password complexity on admin updates

**Changes:**
- `app/models.py`
  - Add a `@field_validator("password")` to `AdminUserUpdate` reusing the rules
    from `UserCreate`.

**Validation:**
- Add test that weak admin password update is rejected.

### 2.5 Review CORS credentials configuration

**Changes:**
- `app/config.py` / `app/main.py`
  - Add a runtime warning when CORS is enabled with `allow_credentials=True`.
  - Consider defaulting `allow_credentials=False` unless explicitly opted in.

**Validation:**
- Confirm no wildcard origins in production config.

### 2.6 Add a `SECURITY.md` / security.txt route

**Changes:**
- Add `SECURITY.md` at repo root explaining how to report vulnerabilities.
- Optionally add `/.well-known/security.txt` route in `app/main.py`.

---

## Phase 3 — Backend architecture boundaries

**Goal:** Move SQL out of routers and services into repositories; make routers thin.

### 3.1 Extract `UndoRepository`

**Changes:**
- `app/domain/repositories/interfaces.py`
  - Add `UndoRepository` interface with methods: `record`, `get_undo`, `get_redo`,
    `clear`, `clear_for_node`, etc.
- `app/domain/repositories/postgres_undo.py` (new)
  - Implement `PostgresUndoRepository` with all SQL currently in `UndoService`.
- `app/domain/services/undo_service.py`
  - Replace `asyncpg` and direct SQL with `UndoRepository` dependency.
- Update dependency wiring (`app/dependencies.py`, router helpers).

**Validation:**
- All undo tests pass.
- `grep -R "import asyncpg" app/domain/services/` returns nothing.

### 3.2 Move router SQL into services

**Priority order (worst offenders first):**
1. `app/routers/nodes/links.py` — tag links, backlinks, alias links.
2. `app/routers/nodes/crud.py` — hierarchy, undo, mentions, templates.
3. `app/routers/nodes/views.py` — QueryAST execution, view rendering.
4. `app/routers/properties/values.py` and `crud.py`.
5. `app/routers/assets.py`.
6. `app/routers/workspaces.py`.
7. `app/routers/auth.py` — move user persistence to `UserRepository`.

**For each endpoint:**
- Replace `async with acquire_connection(service.pool)` with a service method call.
- Remove existence checks and mutation logic from the router.
- Add the required method to the domain service.
- If the service method needs new repository capability, extend the repository
  interface first, then implement in Postgres.

**Validation:**
- `grep -R "await conn\." app/routers/ | wc -l` should trend toward 0.
- Run affected router test files.

### 3.3 Replace concrete repository imports with interfaces

**Changes:**
- In routers and services, change `from ...domain.repositories import PostgresNodeRepository`
  to `from ...domain.repositories.interfaces import NodeRepository`.
- Update `app/dependencies.py` to yield interfaces while still constructing
  concrete implementations.

**Validation:**
- `grep -R "PostgresNodeRepository\|PostgresLinkRepository\|PostgresPropertyRepository" app/routers/`
  returns nothing except in dependency wiring.

### 3.4 Move auth persistence to `UserRepository`

**Changes:**
- `app/auth.py`
  - Replace direct `get_connection()` calls with `UserRepository` methods.
- Note: `User` entity has `username` but schema uses `email`; reconcile naming
  in entity or repository mapper.

**Validation:**
- Auth tests pass.

### 3.5 Move workspace/export SQL into domain services

**Changes:**
- `app/workspace_manager.py` → `app/domain/services/workspace_service.py` backed by
  repositories.
- `app/node_export.py` → `app/domain/services/export_service.py` or keep as
  infrastructure adapter, but move SQL into repositories.
- `app/workspace_io.py` stays infrastructure but should not contain business rules.

**Validation:**
- Workspace import/export tests pass.

### 3.6 Slim barrel files

**Changes:**
- `app/domain/__init__.py`
  - Replace `from .entities import *` etc. with an explicit `__all__`.
- `app/routers/__init__.py`
  - Move `get_current_user` to `app/dependencies.py` and import it from there.

**Validation:**
- `ruff check app/`
- No circular import errors on startup.

---

## Phase 4 — Frontend design-system discipline

**Goal:** Replace hardcoded values with tokens, remove visual noise, and fix token defaults.

### 4.1 Fix accent tokens

**Changes:**
- `frontend/src/variables.css`
  - Set `:root { --color-accent: #5B7D5B; --color-on-accent: #ffffff; }`.
  - Add `--color-on-accent` to every accent block.
  - Add dark-mode accent overrides:
    ```css
    [data-theme="dark"][data-accent="sage"] {
      --color-accent: #7FB285;
      --color-on-accent: #000000;
    }
    [data-theme="dark"][data-accent="teal"] { … }
    [data-theme="dark"][data-accent="rose"] { … }
    [data-theme="dark"][data-accent="navy"] { … }
    ```
  - Add OLED accent verification.

**Validation:**
- Start app in light/dark/OLED with each accent; confirm primary buttons are readable.

### 4.2 Align button radius scale

**Changes:**
- `frontend/src/components/ui/Button.css`
  - Map sizes to tokens:
    - xs/sm → `--shape-button-small` (12 px)
    - md/lg → `--shape-button-large` (16 px)
    - compact → `--shape-button-compact` (10 px)
  - Remove `btn--glow-static` and `btn--glow-breathe` or restrict to one signature use.

**Validation:**
- Visual regression: buttons render with correct radii in all sizes.

### 4.3 Fix card radius default

**Changes:**
- `frontend/src/components/ui/Card.css`
  - Change default `radius="md"` mapping from 8 px to `--shape-card` (20 px).
  - If 8 px is intentionally for floating panels, introduce a separate
    `--shape-floating-panel` token and document it.

### 4.4 Remove decorative glows and shadows

**Changes:**
- `frontend/src/components/ui/Button.css` — remove glow variants (or repurpose as
  focused focus-ring only).
- `frontend/src/features/content/components/blocks/BlockRow.css` — replace glows
  with accent outline or high-contrast selected state.
- `frontend/src/features/workspace/pages/WorkspaceManagementView.css` — remove
  primary-action hover glow and delete-confirm pulse shadow.
- `frontend/src/components/ui/ImageModal.css` and `PresentationModal.css` — use
  `--color-scrim` instead of `color-mix(in srgb, black …)`.

**Validation:**
- `grep -R "box-shadow" frontend/src/components/ui/ frontend/src/features/content/components/blocks/`
  returns only focus rings or explicit elevation tokens.

### 4.5 Replace hardcoded colors with tokens

**Changes:**
- `frontend/src/features/content/editor/plugins/FindReplaceWidget.css`
- `frontend/src/features/content/pages/NodeView.css`
- `frontend/src/features/content/components/PresentationModal.css`
- `frontend/src/features/content/components/blocks/BlockUI.tsx`
- `frontend/src/features/content/components/nodes/views/WhiteboardCanvas.tsx`

For each hardcoded hex/rgb/rgba fallback, map to the closest semantic token
(`--color-surface`, `--color-outline-variant`, `--color-on-surface-variant`,
`--color-scrim`, etc.).

### 4.6 Typography discipline

**Changes:**
- `frontend/src/features/workspace/pages/WorkspaceManagementView.css`
  - Replace `font-size: var(--spacing-*)` with `--font-title-*`, `--font-headline-*`, etc.
- `frontend/src/components/ui/SelectionButton.css`
  - Replace raw `font-size: 0.875rem` etc. with `--font-size-*` or `--font-*` tokens.
- `frontend/src/features/content/editor/InlineEditor.css`
  - Map heading sizes to `--font-headline-small`, `--font-title-large`, etc.
- `frontend/src/features/content/components/blocks/BlockRow.css`
  - Use `--font-body-medium` (`line-height: 1.5`) instead of `line-height: 1.6`.

### 4.7 Tighten design-system validator

**Changes:**
- `frontend/scripts/validate-design-system.js`
  - Add checks for:
    - `min-width`, `max-width`, `min-height`, `max-height`
    - `top`, `right`, `bottom`, `left`
    - hardcoded colors inside `color-mix()`
    - `rgba()` / `rgb()` fallbacks
  - Remove `6px`, `10px`, `14px` from allowed literals unless explicitly whitelisted
    for one-off hairlines.
  - Add `--spacing-micro: 2px` token for true 1–2 px hairlines.

**Validation:**
- `cd frontend && node scripts/validate-design-system.js` passes after fixes.

### 4.8 Motion cleanup

**Changes:**
- Across ~50 files, replace `transition: all …` with explicit property lists
  (`background-color, border-color, transform, opacity`).
- Replace raw `0.15s` / `0.2s` durations with `--motion-duration-short`,
  `--motion-duration-shorter`, etc.
- Remove or gate infinite animations (`delete-confirm-pulse`, `btn-breathe-halo`)
  behind a transient state.

**Validation:**
- No `transition: all` remains in `frontend/src/components/ui/` or
  `frontend/src/features/layout/`.

---

## Phase 5 — Frontend accessibility

**Goal:** Make the app keyboard/touch/screen-reader friendly.

### 5.1 Increase touch targets

**Changes:**
- `frontend/src/variables.css`
  - Increase icon-only button sizes:
    ```css
    --button-icon-only-xs: 44px;
    --button-icon-only-sm: 44px;
    --button-icon-only-md: 48px;
    --button-icon-only-lg: 48px;
    ```
  - Or keep visible icon smaller and add an invisible hit-area pseudo-element.
- `frontend/src/features/layout/components/TabItem.css` — close button must be
  at least 44×44 px.
- `frontend/src/features/layout/components/TopBar.tsx` — audit every toolbar
  icon-only button.
- `frontend/src/features/content/components/nodes/views/WhiteboardToolbar/index.tsx`
  — undo/redo/zoom/grid/minimap buttons.

**Validation:**
- Chrome DevTools accessibility overlay shows no targets below 44×44 px.

### 5.2 Convert `div role="button"` to real `<button>` elements

**Priority conversions:**
- `frontend/src/features/layout/components/TabItem.tsx`
- `frontend/src/features/content/components/nodes/PageHeader.tsx`
- `frontend/src/features/content/components/nodes/NodeRef.tsx`
- `frontend/src/features/content/components/nodes/views/KanbanCard.tsx`
- `frontend/src/components/ui/ListSortable.tsx`
- `frontend/src/components/ui/Table.tsx` drag handle
- `frontend/src/features/layout/components/Sidebar/SidebarFavorites.tsx`
- `frontend/src/features/layout/components/Sidebar/SidebarRecents.tsx`
- `frontend/src/components/ui/ButtonWithPanel.tsx` custom trigger
- `frontend/src/components/ui/Dropdown.tsx` custom trigger
- `frontend/src/components/ui/FileDropZone.tsx`

**For each:**
- Replace `<div role="button" tabIndex={0}>` with `<button type="button">`.
- Remove manual keyboard handlers unless needed for composite widgets.
- Add `aria-label` to icon-only variants.

### 5.3 Restore visible focus rings

**Changes:**
- Where `outline: none` is used on interactive elements, add a
  `:focus-visible` ring:
  ```css
  .interactive:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--color-accent);
  }
  ```
- Files to audit:
  - `TextField.css`, `SearchField.css`, `SelectTrigger.css`, `Dropdown.css`
  - `PageHeader.css`, `GraphView.css`, `WhiteboardView.css`, `InlineEditor.css`,
    `CardItem.css`

### 5.4 Fix form label association

**Changes:**
- `frontend/src/components/ui/TextField.tsx`
  - Generate an id with `useId()` if `props.id` is absent; wire `<label htmlFor={id}>`.
- `frontend/src/components/ui/SearchField.tsx`
  - Add label prop / `aria-label` support.
- `frontend/src/features/content/components/properties/PropertyForm.tsx`
  - Add `htmlFor` to labels.
- `frontend/src/features/workspace/components/WorkspaceNameModal.tsx`
  - Pass explicit `id` or rely on generated id.

### 5.5 Add `aria-live` to toasts

**Changes:**
- `frontend/src/components/ui/NotificationToast.tsx`
  - Wrap container in `<div role="status" aria-live="polite" aria-atomic="false">`.

### 5.6 Add focus traps to modal-like surfaces

**Changes:**
- Reuse `frontend/src/hooks/useFocusTrap.ts` in:
  - `ButtonWithPanel.tsx`
  - Mobile drawer (`MobileLayout.tsx`)
  - `Scratchpad.tsx`
  - `ImageModal.tsx`
  - `AccountMenu.tsx`
- Ensure focus returns to the trigger on close.

### 5.7 Make hover-only actions discoverable

**Changes:**
- For every `.hover-reveal` pattern, also show on `:focus-within` and
  `:focus-visible`:
  ```css
  .card:hover .actions,
  .card:focus-within .actions,
  .card .actions:focus-visible {
    opacity: 1;
  }
  ```
- Audit `CardItem.css`, `KanbanCard.tsx`, `TabItem.css`, `Table.tsx`.

### 5.8 Default `Button` to `type="button"`

**Changes:**
- `frontend/src/components/ui/Button.tsx`
  - Set `type = 'button'` as default prop to prevent accidental form submission.

### 5.9 Respect `prefers-reduced-motion` in JS

**Changes:**
- `frontend/src/features/auth/pages/EnrollmentView.tsx`
  - Read `window.matchMedia('(prefers-reduced-motion: reduce)')` and set
    transition duration to 0 when reduced motion is preferred.
- `frontend/src/features/content/components/nodes/views/GraphView.tsx`
  - Disable or slow physics simulation when reduced motion is preferred.
- `frontend/src/features/content/components/nodes/views/WhiteboardToolbar/index.tsx`
  - Skip animated pan/zoom transitions when reduced motion is preferred.

### 5.10 Improve labels and alt text

**Changes:**
- `frontend/src/components/ui/ImageModal.tsx` — default `alt` should describe
  the image or be empty for decorative images; avoid generic `"Image"`.
- `frontend/src/features/content/components/nodes/views/GraphView.tsx` — add
  `aria-label="Graph view of your pages and links" role="img"` to `<canvas>`.
- `frontend/src/features/content/components/nodes/views/WhiteboardCanvas.tsx` —
  add canvas accessible name.
- `frontend/src/features/layout/components/MobileLayout.tsx` — drawer should be
  `<aside aria-label="Sidebar">`.

---

## Phase 6 — Frontend component boundaries & polish

**Goal:** Enforce `components/ui/` purity and finish visual polish.

### 6.1 Move domain-aware UI components out of `components/ui/`

**Changes:**
- `frontend/src/components/ui/Table.tsx`
  - Move to `features/content/components/nodes/views/TableView.tsx`.
  - If a generic data-table shell is needed, keep a thin `ui/DataTable.tsx` that
    accepts column renderers as props.
- `frontend/src/components/ui/CalendarPopup.tsx` and `DatePickerPopup.tsx`
  - Convert to controlled components accepting `firstDayOfWeek`, `dailyPages`,
    etc. as props.
  - Create thin feature wrappers in `features/content/` or `features/workspace/`
    that read stores and pass props.
- `frontend/src/components/ui/SearchBox.tsx`
  - Decouple from `useSearch`, `useNavigationStore`, and node-name helpers.
  - Accept `results`, `onSelect`, `query`, `onQueryChange` as props.
- `frontend/src/components/ui/AddCoverButton.tsx`
  - Move drag-event helper to a generic hook or pass it as a prop.

### 6.2 Clean up management screens

**Changes:**
- `frontend/src/features/workspace/pages/WorkspaceManagementView.css`
  - Replace one-off styled elements with shared `Button`, `Card`, `TextField`,
    `Pill` components.
  - Remove magic layout sizes (`800px`, `600px`, `900px`) in favor of tokens or
    `clamp()`.
  - Remove remaining glows/shadows.

### 6.3 Add arbitrary accent picker (optional but recommended)

**Changes:**
- `frontend/src/features/layout/components/Modals/UserSettingsModal.tsx`
  - Add a hex-color input or system-accent sync option in Appearance settings.
- `frontend/src/variables.css`
  - Ensure custom accent updates `--color-accent` and computes
    `--color-on-accent` (black or white based on luminance).

### 6.4 Differentiate haptic feedback

**Changes:**
- Map interactions to the design-system haptic map:
  - Light (10 ms): buttons, switches, chips.
  - Medium (25 ms): delete confirm, clear.
  - Selection click: checkboxes, sliders.
- Update `Button.tsx`, `BooleanToggle.tsx`, `useTouchIndent.ts`, and destructive
  action handlers.

### 6.5 Modal / drawer polish

**Changes:**
- Ensure every bottom sheet/modal has:
  - Drag handle (32×4, 2 px radius, muted color at 35 % opacity).
  - Top radius `--shape-sheet` (28 px).
  - Backdrop click and Escape dismissal.
  - Safe-area padding.
- Audit `Modal.tsx`, mobile drawer, and any custom sheet components.

---

## Phase 7 — Mobile hardening

**Goal:** Fix fleet-rule failures and improve mobile UX.

### 7.1 Externalize hardcoded English strings

**Changes:**
- `mobile/app/src/main/res/values/strings.xml`
  - Add all user-facing strings from `SetupActivity.kt` and
    `activity_setup_list.xml`.
- Replace hardcoded literals in Kotlin/XML with `@string/…` references.

### 7.2 Add accessible edit affordance

**Changes:**
- `mobile/app/src/main/java/com/notees/app/SetupActivity.kt`
  - Add `contentDescription` to server rows indicating long-press edits, **or**
  - Add an explicit “Edit” icon button to `item_server.xml`.

### 7.3 Harden WebView settings

**Changes:**
- `mobile/app/src/main/java/com/notees/app/MainActivity.kt`
  - Change `setAcceptThirdPartyCookies(webView, true)` to `false`.
  - Consider `MIXED_CONTENT_NEVER_ALLOW` if HTTPS-only use is expected;
    otherwise document the LAN/Tailscale trade-off.
  - Improve `shouldOverrideUrlLoading` to compare parsed origin
    (`scheme`, `host`, `port`) instead of string prefix.

### 7.4 Document cleartext trade-off

**Changes:**
- `mobile/README.md` or `mobile/AGENTS.md`
  - Explain why `cleartextTrafficPermitted="true"` is allowed and when users
    should serve Notees over HTTPS.

---

## Phase 8 — Documentation & AGENTS.md update

**Goal:** Keep project documentation accurate and useful for future agents.

### 8.1 Update `AGENTS.md`

**Changes:**
- Add a “Fleet Migration” section referencing this plan and the skills used.
- Add a “Known Drift / Resolved” subsection:
  - Document that the backend had router-level SQL and is being migrated to
    services/repositories.
  - Document that the bullet is intentionally circular (owner decision).
- Update architecture claims to match the post-migration state.
- Update design-system section with the final accent default and dark-mode
  overrides.

### 8.2 Update `docs/design-language.md`

**Changes:**
- Change signature element #3 from “small, sharp square” to “tactile circular
  bullet” (or remove shape prescription).
- Add the dark-mode sage override color if implemented.
- Document the final accent strategy and custom accent picker if added.

### 8.3 Add migration decision log

Append a decision log to this file or `AGENTS.md`:

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-12 | Block bullets remain circular | Product-owner preference; overrides earlier “sharp square” exploration. |
| 2026-06-12 | Default accent is sage `#5B7D5B` | Matches productivity domain and design-language recipe. |
| 2026-06-12 | Remove decorative glows | Violates “Zero Visual Noise” principle. |

---

## Validation checklist

Before declaring the migration complete, verify:

### Security
- [ ] Malicious QueryAST `flag_name` returns 400.
- [ ] Batch endpoints are rate-limited per IP with no bypass.
- [ ] `pages_only` endpoint returns bounded results.
- [ ] Auth logs contain no email addresses.
- [ ] HSTS header present when `ENVIRONMENT=production`.
- [ ] Admin password updates enforce complexity.
- [ ] `SECURITY.md` exists.

### Architecture
- [ ] No `import asyncpg` in `app/domain/services/`.
- [ ] No `await conn.` calls in `app/routers/`.
- [ ] Routers import repository interfaces, not concrete classes.
- [ ] `app/domain/__init__.py` uses explicit `__all__`.
- [ ] `AGENTS.md` architecture section matches the code.

### Frontend design system
- [ ] `node scripts/validate-design-system.js` passes.
- [ ] No hardcoded hex colors in component files.
- [ ] Buttons use correct radius tokens.
- [ ] Cards use `--shape-card` (20 px) by default.
- [ ] No decorative glows/shadows except focus rings.
- [ ] Accent default is sage; dark-mode accents are readable.

### Accessibility
- [ ] All icon-only buttons are ≥ 44×44 px.
- [ ] No `div role="button"` remains on primary navigation.
- [ ] All interactive elements have visible `:focus-visible` rings.
- [ ] Form inputs have associated labels.
- [ ] Toasts are announced via `aria-live`.
- [ ] Modal-like surfaces trap focus and restore it on close.
- [ ] Hover-only actions also show on `:focus-within`/`:focus-visible`.
- [ ] `prefers-reduced-motion` honored in JS-driven motion.

### Build & tests
- [ ] `ruff check app/` passes.
- [ ] Backend tests pass inside Docker.
- [ ] `cd frontend && npm run lint` passes.
- [ ] `cd frontend && npx tsc -b --noEmit` passes.
- [ ] `cd frontend && npm run test:run` passes.
- [ ] Mobile debug APK builds successfully.

---

## Appendix — Files that need the most attention

### Frontend
- `frontend/src/variables.css`
- `frontend/src/components/ui/Button.css`
- `frontend/src/components/ui/Card.css`
- `frontend/src/components/ui/TextField.tsx`
- `frontend/src/components/ui/SearchField.tsx`
- `frontend/src/components/ui/Table.tsx`
- `frontend/src/components/ui/CalendarPopup.tsx`
- `frontend/src/components/ui/DatePickerPopup.tsx`
- `frontend/src/components/ui/SearchBox.tsx`
- `frontend/src/components/ui/ButtonWithPanel.tsx`
- `frontend/src/components/ui/ImageModal.tsx`
- `frontend/src/components/ui/NotificationToast.tsx`
- `frontend/src/features/layout/components/TabItem.tsx`
- `frontend/src/features/layout/components/TopBar.tsx`
- `frontend/src/features/layout/components/MobileLayout.tsx`
- `frontend/src/features/layout/components/Scratchpad.tsx`
- `frontend/src/features/layout/components/AccountMenu.tsx`
- `frontend/src/features/content/components/nodes/PageHeader.tsx`
- `frontend/src/features/content/components/nodes/NodeRef.tsx`
- `frontend/src/features/content/components/nodes/views/KanbanCard.tsx`
- `frontend/src/features/content/components/nodes/views/CardItem.css`
- `frontend/src/features/content/components/nodes/views/GraphView.tsx`
- `frontend/src/features/content/components/nodes/views/WhiteboardCanvas.tsx`
- `frontend/src/features/content/components/nodes/views/WhiteboardToolbar/index.tsx`
- `frontend/src/features/content/components/blocks/BlockRow.css`
- `frontend/src/features/content/components/blocks/BlockUI.tsx`
- `frontend/src/features/content/editor/InlineEditor.css`
- `frontend/src/features/content/editor/plugins/FindReplaceWidget.css`
- `frontend/src/features/content/pages/NodeView.css`
- `frontend/src/features/content/components/PresentationModal.css`
- `frontend/src/features/workspace/pages/WorkspaceManagementView.css`
- `frontend/src/features/workspace/components/WorkspaceNameModal.tsx`
- `frontend/src/features/content/components/properties/PropertyForm.tsx`
- `frontend/src/index.css`
- `frontend/scripts/validate-design-system.js`

### Backend
- `app/routers/nodes/views.py`
- `app/routers/nodes/batch.py`
- `app/routers/nodes/crud.py`
- `app/routers/nodes/links.py`
- `app/routers/properties/values.py`
- `app/routers/properties/crud.py`
- `app/routers/assets.py`
- `app/routers/workspaces.py`
- `app/routers/auth.py`
- `app/routers/admin.py`
- `app/domain/services/undo_service.py`
- `app/domain/repositories/interfaces.py`
- `app/domain/repositories/postgres_node_search.py`
- `app/auth.py`
- `app/workspace_manager.py`
- `app/node_export.py`
- `app/main.py`
- `app/config.py`
- `app/models.py`
- `app/dependencies.py`
- `app/domain/__init__.py`
- `app/routers/__init__.py`

### Mobile
- `mobile/debug.keystore`
- `mobile/.gitignore`
- `mobile/app/src/main/java/com/notees/app/SetupActivity.kt`
- `mobile/app/src/main/java/com/notees/app/MainActivity.kt`
- `mobile/app/src/main/res/values/strings.xml`
- `mobile/app/src/main/res/layout/activity_setup_list.xml`
- `mobile/app/src/main/res/xml/network_security_config.xml`
- `mobile/AGENTS.md`

### Documentation
- `AGENTS.md`
- `docs/design-language.md`
- `docs/migration-plan.md` (this file)
- `SECURITY.md` (new)

---

## Next step

This plan is ready for review. The recommended first action is **Phase 1**:
whitelist QueryAST `flag_name`, fix batch rate limiters, and track the debug
keystore. These are live blockers.
