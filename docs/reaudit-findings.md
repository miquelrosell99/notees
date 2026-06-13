# Notees Fleet-Skill Re-audit Findings

> Generated: 2026-06-12
>
> Scope: Re-audit the Notees codebase against the fleet migration skill and frontend development skill after the initial migration was declared complete.

## Verdict

The app is **not yet fully aligned** with the fleet skills. The first migration closed the original P0/P1 blockers and the test suite passes, but a re-audit reveals significant remaining drift — especially direct SQL inside FastAPI routers, decorative visual effects on the frontend, and mobile hardcoded strings.

## Backend — still misaligned

### P0 — Direct SQL remains in routers

`AGENTS.md` states that router-level SQL was removed, but there are still **~135 direct `await conn.` calls across 20 router files**. Routers bypass the repository layer by calling `acquire_connection()` or `get_connection()` directly. Affected areas include:

- `app/routers/admin.py`
- `app/routers/auth.py`
- `app/routers/nodes/search.py`
- `app/routers/properties/crud.py`
- `app/routers/public.py`
- and 15 additional router modules

This is the largest remaining architectural gap and violates the hexagonal-architecture rule that routers must depend on domain services and repository interfaces, not asyncpg.

### P1 — Security hardening gaps

- **Global default rate limit is 5,000 req/min/IP** — far too permissive for a self-hosted notes app.
- **Auth rate limits are per-IP only**; there is no per-account or per-username rate limiting, leaving credential-stuffing workflows under-protected.
- **`POST /api/nodes/views/execute`** accepts unbounded `limit`/`offset` from the client.
- **`app/utils/email.py` logs recipient email addresses and message bodies** — PII in logs.

### P2 — Architecture drift

- `NodeService` and `NodeViewService` still hold direct `pool` references.
- `app/main.py` lifespan handlers contain direct SQL.
- `app/db/benchmark_cte.py` calls `pool.acquire()` directly.
- Some repository files still use `acquire_connection(self._pool)` instead of `get_connection()` / `get_transaction()`.

## Frontend — partially aligned

### ✅ Passing

- `npm run lint` and `npx tsc -b --noEmit` pass with 0 warnings/errors.
- Design-system validator passes with 0 violations.
- Hardcoded colors removed; accent tokens correct; custom accent picker works.
- `components/ui/` import boundaries are clean.
- Visual identity matches `docs/design-language.md`.

### ❌ Still failing

- **Decorative glows/shadows remain**: `--glow-primary-*` tokens in `variables.css`, editing-trail glows in `BlockRow.css`, enrollment dot halos in `EnrollmentView.css`.
- **~65 `div role="button"` anti-patterns** remain across modals, context menus, pills, block rows, etc.
- **Icon-only touch targets**: `Button` is good, but many custom `role="button"` elements are below 44×44 px.
- **Token gaming**: several files stuff magic pixel values into component-scoped CSS custom-property names to bypass the validator.

## Mobile — nearly aligned

### ✅ Passing

- Debug keystore tracked.
- WebView hardened (no third-party cookies, no mixed content, origin-locked navigation).
- Strings externalized.

### ❌ Remaining

- One hardcoded user-facing string in `ServerPreferences.kt:72` (`"Default Server"`).
- Recommended: set `android:allowBackup="false"` to match the privacy promise.

## Bottom Line

The migration is **functionally complete and test-green**, but full fleet-skill alignment requires another pass. The two highest-impact remaining items are:

1. Cleaning the **~135 remaining router SQL calls** and moving them behind services/repositories.
2. Removing the **decorative glows and fake-button `div role="button"` patterns** from the frontend.
