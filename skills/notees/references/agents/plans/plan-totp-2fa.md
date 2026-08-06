# Plan — TOTP Two-Factor Authentication (2FA)

Status: design agreed, not yet implemented. This document is the durable reference for
the feature. It should be updated if the approach changes during implementation.

## Goal

Add standards-based TOTP (RFC 6238) 2FA to Notees. Works with any compliant
authenticator (Bitwarden paid, Aegis, Ente Auth, Google Authenticator, Authy,
1Password, 2FAS, …). Requires **no public domain, no third-party service, no
internet, no open ports** — code generation/verification is fully offline from a
shared secret + current time. The only operational requirement is sane clocks on
server and phone (verify with a ±1-step window). The TOTP secret and QR are never written to disk or logs; the secret is shown once during enrollment and is never returned by the API afterwards.

## Policy (enforcement)

- **Per-user opt-in only.** Each user enables TOTP in Settings → Security. No role is
  forced to enroll — admins are treated like any other user.
- **Optional later:** instance-level policy toggle in System Settings:
  `off / optional / admins-required / all-required`. Out of scope for v1.

Recovery is a first-class requirement (self-hosted lockout is catastrophic):
- One-time **backup codes** shown once at enrollment (≈10), hashed at rest, single use.
- Host-level escape hatch: `scripts/reset_user_2fa.py <email>` disables 2FA for a user
  (requires server shell — correct trust boundary, not an in-app bypass).

## Data model (one migration)

On `user`:
- `totp_secret` — TEXT, **encrypted at rest** (Fernet key derived from `SECRET_KEY`).
  Null until enrollment starts.
- `totp_enabled` — BOOLEAN NOT NULL DEFAULT FALSE.
- `totp_enabled_at` — TIMESTAMPTZ NULL.

New table `user_backup_code`:
- `id` PK, `user_id` FK → user(id) ON DELETE CASCADE,
- `code_hash` TEXT, `used_at` TIMESTAMPTZ NULL, `created_at` TIMESTAMPTZ.
- Index on `(user_id)`. One row per code; `used_at` set on consumption.

## Backend (`app/features/auth/`)

Dependencies to add (verify none already present in `pyproject.toml`):
- `pyotp` — secret generation + verification (tiny, pure-Python).
- `cryptography` — Fernet for secret-at-rest encryption (likely already transitive; confirm).
- `qrcode` — only if QR is rendered server-side (see open question).

Endpoints (all reuse existing per-account rate limiters; strict limits on verify/enable):
- `POST /auth/2fa/setup` — authenticated full session. Generates a pending secret,
  stores it (encrypted, not yet enabled), returns `{ otpauth_uri, qr }`. Label:
  issuer `Notees`, account = user email.
- `POST /auth/2fa/enable` — body `{ code }`. Verifies against the pending secret;
  on success sets `totp_enabled=true`, generates backup codes, returns them **once**.
- `POST /auth/2fa/disable` — body `{ current_password }` or `{ code }`. Clears secret,
  sets `totp_enabled=false`, deletes backup codes.
- `POST /auth/2fa/backup-codes/regenerate` — requires a fresh code; returns new set once.
- `POST /auth/2fa/verify` — body `{ preauth_token, code }` (code may be a TOTP code or a
  backup code). On success issues real access+refresh tokens and sets the cookies
  (same path login uses today).

Login change (`router.py` `login`):
- After password OK: if `user.totp_enabled`, do **not** issue tokens. Return
  `200 { "requires_2fa": true, "preauth_token": "<jwt>" }` instead.
- Otherwise unchanged (full tokens + cookies).

Pre-auth token (the main security seam):
- Short-lived (~5 min) HS256 JWT with a distinct claim, e.g. `scope: "2fa-pending"`,
  carrying `user_id`. Signed with `SECRET_KEY`.
- Accepted **only** by `/auth/2fa/verify`. All other endpoints (including refresh and
  `/auth/me`) must reject it — enforce in `get_current_user` / token decode so a
  pre-auth token can never act as a session.
- Must not trigger the client silent-refresh path as if it were a real session.

API keys: creating/revoking keys requires a recent full (2FA-completed) session.
Existing API keys keep working (document that keys bypass 2FA — standard behavior).

## Frontend

- `frontend/src/features/auth/` — new `SecuritySettings` panel (per-user): enable /
  disable / regenerate-backup-codes. QR + grouped manual key + confirm-code field
  (reuse `TextField`, `Button`, `Spinner`, modal atoms).
- `pages/LoginView.tsx` — after password submit, if response has `requires_2fa`,
  render a second step: 6-digit code input + "use a backup code" toggle → POST
  `/auth/2fa/verify` with `preauth_token`. Keep the generic 401 handling added earlier.
- `api/client.ts` — ensure the 2FA-pending state never triggers silent refresh or an
  `handleAuthFailure()` redirect; the pre-auth token is held only in memory for the
  verify call.

Works in the Flutter mobile app: QR is just an image/SVG on screen; scanning is done by the
external authenticator app, so no in-app camera is needed.

## Scripts

- `scripts/reset_user_2fa.py <email>` — host-level: clear `totp_secret`,
  set `totp_enabled=false`, delete backup codes. Mirrors `promote_user_to_admin.py`.

## Tests

- Unit (no DB): TOTP verify valid/invalid/window; backup-code hash + single-use;
  secret encryption round-trip; pre-auth token rejected by normal endpoints.
- Integration: enroll → confirm enable → login two-step → login with backup code →
  disable.

## Open questions to confirm before coding

1. QR rendering: server-side (return SVG/PNG data URI) vs client-side from `otpauth_uri`.
   Leaning client-side (smaller response, secret already returned once during setup).
2. ~~Admins-required enforcement timing~~ — **decided: no enforcement**; 2FA is per-user opt-in only.
3. Backup code count (≈10) and format (e.g. 8-char groups).
4. Confirm `cryptography` is available; if not, add it (or rely on a simpler at-rest scheme).

## Out of scope (v1)

Passkeys/WebAuthn, SMS, email OTP, instance-wide "all-required" policy toggle.
