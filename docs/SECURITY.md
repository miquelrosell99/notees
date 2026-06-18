# Security Policy

This document describes the security policy for **Notees**, a self-hosted note-taking application.

## Supported Versions

Only the latest commit on the default branch receives security updates. Because Notees is self-hosted, operators are expected to deploy from the latest source or released Docker image.

## Reporting a Vulnerability

If you discover a security vulnerability in Notees, please report it responsibly:

1. **Do not open a public issue.** Public disclosure can put existing deployments at risk before a fix is available.
2. Email the maintainers at **miquelroselltarrago@gmail.com** with:
   - A clear description of the vulnerability.
   - Steps to reproduce the issue.
   - The potential impact (e.g., data exposure, authentication bypass).
   - Any suggested mitigation or fix.
3. Allow reasonable time for assessment and remediation before any public disclosure.

You will receive an acknowledgment within 5 business days. We aim to provide a resolution or mitigation plan within 30 days for critical issues.

## Security Measures

Notees implements the following security controls:

- Mandatory `SECRET_KEY` validation (min 32 characters).
- `bcrypt` password hashing with legacy-hash migration.
- Short-lived JWT access tokens (15 minutes by default) with refresh-token rotation and reuse detection.
- Rate limiting on authentication and API endpoints.
- Restrictive default CORS; wildcard origins with credentials are rejected.
- Security headers including HSTS (production-only), CSP, X-Frame-Options, and COOP/COEP/CORP.
- Request body size limits (55 MB) and content-type sniffing protection.
- Encrypted mobile storage via AndroidX Security `EncryptedSharedPreferences`.

## Dependency Auditing

Dependencies are audited automatically:

- Backend: `pip-audit --requirement requirements.txt`
- Frontend: `npm audit`
- Dead code / unused exports: `npx knip`

See `.github/workflows/security-audit.yml` for the CI schedule and commands.

## Operational Security Notes

- Backups and workspace exports are **not encrypted by the application**. Store `data/backups/` and export directories on encrypted volumes, or encrypt files outside the app.
- Production deployments must use HTTPS with valid certificates and set `ENVIRONMENT=production`.
- Use strong, unique values for `SECRET_KEY`, `ADMIN_PASSWORD`, and `POSTGRES_PASSWORD`.
