# Fleet Migration Plan — Notees

Generated: 2026-06-12
Scope: React + FastAPI self-hosted note-taking app
Target: Fleet-wide standards (`react-ui-patterns`, `fastapi-patterns`, `design-system`, `security-hardening`, `accessibility-primer`, `performance-optimizer`, `codebase-organizer`, `frontend-design`)

---

## Decisions

1. **Router migration**: Adopt `react-router-dom` and remove the bespoke `useRouter.hook.ts` / `RouterSync.tsx` custom router.
2. **Docs**: Update `AGENTS.md` to reflect the new architecture, tokens, and accepted deviations.
3. **Skill alignment**: Update code to match skill recommendations where feasible.
4. **Testing**: Test only at the end unless a large change needs intermediate verification. The user must approve final testing.

---

## Phase A — Security Hotfixes

Goal: Eliminate all P0 security blockers.

- [x] Sanitize `RequestValidationError` logging in `app/main.py` (drop `input` field).
- [x] Convert auth rate limiters to `PerKeyBucketFactory` + IP identifier.
- [x] Add JWT algorithm allow-list in `app/config.py`.
- [x] Add indexed API-key prefix lookup in `app/auth.py`.
- [x] Remove password hashes from in-memory user cache.
- [x] Align admin creation with `ADMIN_PASSWORD` docs (update docs if behavior stays).
- [x] Tighten CORS wildcard handling.
- [x] Add `SECURITY.md` real contact and dependency audit workflow.

---

## Phase B — Backend Structural Boundaries

Goal: Enforce hexagonal architecture and FastAPI patterns.

- [x] Stop domain → router imports; extract asset utilities.
- [ ] Move raw SQL out of domain services (`undo_service.py`, `permissions.py`, `node_service._log_activity`).
- [ ] Move router raw SQL into repositories/services.
- [ ] Remove `.pool` access from routers.
- [ ] Routers depend on repository interfaces, not concrete Postgres classes.
- [x] Resolve redundant `app/infrastructure/repositories/`.
- [ ] Add explicit `response_model` to endpoints; replace raw `dict` bodies with Pydantic models.
- [x] Centralize DB connection settings in `app/config.py`.
- [x] Exclude WebSocket from request-scoped connection middleware.

---

## Phase C — Frontend Structural Boundaries

Goal: Clean component/state boundaries.

- [x] Break circular dependencies (`NodeRef` → `NodeContextMenu` → `NodeSelector` → `NodeRef` via `ColorPickerRow` extraction).
- [x] Move domain-aware components out of `components/ui/` (`PresentationModal` → `features/content/components/`).
- [x] Create `features/content/index.ts` public barrel.
- [x] Replace `favoritesStore` server state with TanStack Query hooks.
- [x] Store only IDs in `navigationStore` (removed `activeNode`; `nodeCollectionNodes` → `nodeCollectionNodeIds`).
- [x] Fix `SearchBox` rules-of-hooks violation.
- [x] Introduce query-key factories (`favoriteKeys`, `recentKeys`).
- [ ] Convert relative `../` imports to path aliases (deferred to Phase E/F; 40+ sibling-relative imports remain).

---

## Phase D — Router Migration

Goal: Replace bespoke router with `react-router-dom`.

- [ ] Install `react-router-dom`.
- [ ] Design route tree (workspaces, nodes, journals, tasks, shares, settings, auth).
- [ ] Create route definitions and loaders.
- [ ] Replace `useRouter.hook.ts` with `useNavigate` / `useParams` / `useLocation`.
- [ ] Update `RouterSync.tsx` to a thin route-param sync adapter.
- [ ] Update `MainContent` / layout components to use route-based rendering.
- [ ] Update query keys that depend on route state.
- [ ] Ensure workspace switching and deep links still work.

---

## Phase E — Performance & Data

Goal: Cap unbounded work and optimize rendering.

- [ ] Cap backend list queries (`list_nodes`, `get_typed_with`, `get_children`, `get_page_content`, `list_assets`).
- [ ] Enforce pagination on `/nodes/workspace/nodes`.
- [ ] Move WeasyPrint off async event loop.
- [ ] Batch N+1 class/tag/property lookups.
- [ ] Lower frontend virtualization thresholds.
- [ ] Use thumbnails for images; cache MDI sprite.
- [ ] Stabilize `NodeCollection` view props with `useMemo`.

---

## Phase F — Design System & Accessibility

Goal: Token consistency and screen-reader correctness.

- [ ] Fix accent/dark-mode source order in `variables.css`.
- [ ] Add missing light-mode graph tokens.
- [ ] Map undefined CSS variables to tokens.
- [ ] Replace colored `box-shadow` glows with tokenized outlines.
- [ ] Tokenize remaining hardcoded layout values.
- [ ] Fix literal `aria-label` strings.
- [ ] Refactor `role="button"` divs to real buttons or labeled controls.
- [ ] Resolve `Icon` `aria-hidden` + `title` conflict.
- [ ] Improve form error associations.
- [ ] Update design-system validator baseline.

---

## Phase G — Docs & Final Alignment

Goal: Document the new state and finalize alignment.

- [ ] Update `AGENTS.md` architecture, conventions, and scorecard.
- [ ] Document aesthetic recipe (e.g., `monastic-productivity` + `editorial-software`).
- [ ] Add user-facing password change endpoint + session revocation.
- [ ] Final `ruff check app/`, `npm run lint`, `npx tsc -b --noEmit`.
- [ ] Present final report; request approval for full test run.

---

## Testing Policy

- No test runs during implementation unless a large change requires intermediate verification.
- Final tests run only with user approval.
- Lint/type checks may be run at phase boundaries if needed to catch syntax errors.
