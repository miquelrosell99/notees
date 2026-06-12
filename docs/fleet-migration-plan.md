# Fleet Migration Plan — Notees

This document consolidates the fleet-alignment audit and serves as the implementation reference for all migration phases.

**Scope:** Bring Notees into alignment with the RosellRamos fleet standards (`react-ui-patterns`, `fastapi-patterns`, `security-hardening`, `design-system`, `frontend-design`, `accessibility-primer`).

**Policy:**
- Implement phases sequentially (A → F).
- Inform the user at every phase boundary.
- Lint and type checks must pass before a phase is considered done.
- Full test suites run only at the end, with user approval.
- No test runs without explicit user approval.

---

## Phase A — Foundation & Security Hotfixes

**Goal:** Eliminate all P0 security blockers and harden auth boundaries.

| # | Finding | Location | Fix |
|---|---|---|---|
| A1 | Validation errors log raw request input including plaintext passwords | `app/main.py:318-326` | Sanitize `exc.errors()`; drop `input` field before logging |
| A2 | Auth endpoints use a **global** rate-limit bucket | `app/routers/auth.py:34-35,176,211` | Use `PerKeyBucketFactory` keyed by IP (or username for login) |
| A3 | JWT signing algorithm is configurable without allow-list | `app/config.py:17`, `app/auth.py:57,64` | Pydantic validator allowing only `HS256/384/512` |
| A4 | API-key auth full-scans active keys and bcrypt-verifies each | `app/auth.py:402-436` | Add indexed key prefix/identifier lookup |
| A5 | `ADMIN_PASSWORD` documented but unused; first registrant becomes admin | `.env.example`, `app/main.py:104-112` | Update docs to match current first-user-admin behavior |
| A6 | In-memory user cache stores password hashes | `app/auth.py:24-109` | Exclude `hashed_password` from cached dict |
| A7 | `SECURITY.md` uses placeholder contact | `SECURITY.md` | Replace with real contact/process or generic guidance |
| A8 | CORS wildcard only warned, not rejected | `app/main.py` | Tighten wildcard handling (log/reject) |

**Completion criteria:**
- `ruff check app/` passes.
- `npx tsc -b --noEmit` (frontend) still passes (no frontend changes).
- No new errors introduced.

---

## Phase B — Structural Boundaries

**Goal:** Enforce hexagonal architecture on the backend.

| # | Finding | Location | Fix |
|---|---|---|---|
| B1 | Domain services import `asyncpg` and execute raw SQL | `undo_service.py`, `node_service.py`, `permissions.py` | Move SQL behind repository interfaces |
| B2 | Domain service imports FastAPI router | `asset_service.py` | Extract shared utilities out of routers |
| B3 | Routers execute raw SQL directly | ~15 router files | Move SQL into repositories/services |
| B4 | Routers access domain service `.pool` | `nodes/links.py`, `nodes/crud.py`, etc. | Remove `.pool` leakage; call service methods |
| B5 | Routers import concrete Postgres repositories | `assets.py`, `nodes/helpers.py`, `public.py`, etc. | Depend on abstract interfaces |
| B6 | `app/infrastructure/repositories/` is redundant | `app/infrastructure/repositories/` | Move or delete; consolidate repository surface |
| B7 | Oversized backend files | `nodes/crud.py`, `node_service.py`, etc. | Split incrementally without behavior changes |
| B8 | Most endpoints lack `response_model` | ~180 routes | Add explicit Pydantic response models |
| B9 | Raw `dict` request bodies bypass validation | `links.py`, `admin.py`, `classes.py` | Replace with Pydantic models |
| B10 | WebSocket holds request-scoped connection for lifetime | `app/main.py` middleware + `live_sync_ws.py` | Exclude WS from request-connection middleware |
| B11 | DB connection settings read via `os.getenv`, not `config.py` | `app/db/connection.py` | Centralize in `Settings` |

**Completion criteria:**
- `ruff check app/` passes.
- Backend compiles / imports resolve.
- No behavior changes intended.

---

## Phase C — Frontend Boundaries & State

**Goal:** Clean component boundaries, break circular deps, and move server state to TanStack Query.

| # | Finding | Location | Fix |
|---|---|---|---|
| C1 | Frontend circular dependencies | `NodeRef↔NodeContextMenu`, SGE engine, `QueryBlockBuilder↔QueryBlockList` | Extract types/components to break cycles |
| C2 | `components/ui/` imports domain features | `ImageModal.tsx`, `Table.tsx`, `PresentationModal.tsx` | Move domain-aware wrappers to `features/` |
| C3 | `features/content/` (171 files) has no public barrel | `frontend/src/features/content/` | Add `index.ts`; enforce public surfaces |
| C4 | `useFavoritesStore` owns server data + API calls | `frontend/src/stores/favoritesStore.ts` | Convert to TanStack Query hooks |
| C5 | `useQuery` called inside `.map()` loop | `frontend/src/components/ui/SearchBox.tsx:81-89` | Restructure to stable hook count |
| C6 | `navigationStore` caches full server node objects | `frontend/src/stores/navigationStore.ts` | Store IDs only; resolve via query cache |
| C7 | Widespread hardcoded `queryKey` arrays | ~20 files | Introduce/extend query-key factories |
| C8 | Remaining relative `../` imports | 48 imports | Convert to path aliases |
| C9 | Cross-feature imports bypass public barrels | various | Route imports through feature barrels |

**Completion criteria:**
- `npm run lint` passes (0 errors; warnings may remain if pre-existing).
- `npx tsc -b --noEmit` passes.

---

## Phase D — Performance & Data

**Goal:** Cap unbounded queries, reduce N+1, and improve frontend performance.

| # | Finding | Location | Fix |
|---|---|---|---|
| D1 | Unbounded list endpoints can OOM backend | `search.py`, `postgres_node.py`, `assets.py` | Push LIMIT/OFFSET into SQL; cap page size |
| D2 | `/nodes/workspace/nodes` can return every page | `search.py` | Remove `page_size=None`; enforce max |
| D3 | WeasyPrint blocks async event loop | `app/routers/export.py` | Run in executor or background job |
| D4 | N+1 class/tag/property resolution | node create/update/list helpers | Batch lookups |
| D5 | In-memory pagination/sorting | `Table.tsx`, `list_nodes()`, `list_assets()` | Push to backend where possible |
| D6 | Frontend virtualization thresholds too high | `BlockList`, `Table` | Lower thresholds |
| D7 | Image assets fetch originals | asset components | Use thumbnails |
| D8 | `mdi-sprite.svg` not runtime-cached | service worker | Cache SVG sprite |

**Completion criteria:**
- `ruff check app/` passes.
- `npm run lint` passes.
- No new type errors.

---

## Phase E — Design System & Accessibility

**Goal:** Align visuals with the design system and fix accessibility blockers.

| # | Finding | Location | Fix |
|---|---|---|---|
| E1 | Accent colors overridden by dark mode due to source order | `frontend/src/variables.css` | Reorder or use `:where()` |
| E2 | Graph semantic tokens undefined in light mode | `frontend/src/variables.css` | Add light-mode `--graph-*` defaults |
| E3 | Undefined/legacy CSS variables | `PresentationModal.css`, etc. | Map to tokens or add missing tokens |
| E4 | Literal `aria-label` strings containing ternary expressions | `TabBarNarrow.tsx`, `NodeContextMenu.tsx`, etc. | Wrap in JSX expressions `{}` |
| E5 | `role="button"` divs, unlabeled controls | `CalendarView.tsx`, `SidebarFavorites.tsx`, `ImageNode.tsx` | Prefer real `<button>`; add labels |
| E6 | `Icon.tsx` hard-codes `aria-hidden="true"` | `frontend/src/components/ui/Icon.tsx` | Expose title when provided |
| E7 | Login form errors not linked to fields | `LoginView.tsx` | Use `aria-describedby` / `role="alert"` |
| E8 | Colored `box-shadow` glows | `Button`, `BlockRow`, `Bullet` | Replace with tokenized outlines/borders |
| E9 | Hardcoded pixel values in graph/layout/whiteboard | various | Tokenize |

**Completion criteria:**
- `npm run lint` passes.
- `npx tsc -b --noEmit` passes.
- Design-system validator passes (no new violations).

---

## Phase F — Distinctive Design & Final Router Cleanup

**Goal:** Document visual language, finish router migration, and close remaining gaps.

| # | Finding | Location | Fix |
|---|---|---|---|
| F1 | No documented aesthetic recipe | docs | Add aesthetic recipe to `AGENTS.md` or design doc |
| F2 | Bespoke router migration | (already started) | Complete migration to `react-router-dom`; remove remaining router surface |
| F3 | Oversized components/hooks | many | Split into focused files |
| F4 | Async state handling | various | Standardize on `DataStateView` where appropriate |
| F5 | Password changes do not invalidate sessions/API keys | auth | Add session/API-key revocation |
| F6 | `registration_enabled` defaults to `True` in code | `app/config.py` | Default to `False` for production safety |

**Completion criteria:**
- All prior phase completion criteria still hold.
- `AGENTS.md` updated with new structure, tokens, accepted tech debt.

---

## Final Verification Gate

Run only after user approval:

1. Backend: `ruff check app/`
2. Backend tests inside Docker container
3. Frontend: `npm run lint`
4. Frontend tests: `npm run test:run`
5. Dependency audit check (manual or workflow)
6. Accessibility scan (if tooling available)

---

## Decisions Log

| Decision | Choice |
|---|---|
| Router migration | Adopt `react-router-dom` (already in progress) |
| Admin creation | Update docs to match first-user-admin behavior |
| Legacy hash support | Update code/docs to match actual `bcrypt`-only behavior |
| Tailwind vs custom CSS | Keep custom CSS; enforce stricter token usage |

---

*Last updated:* 2026-06-12
