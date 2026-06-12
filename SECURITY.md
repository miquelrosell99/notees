# Security Policy

## Supported Versions

Notees is a self-hosted application. Security updates are published as patch releases on the main branch and tagged releases. Always run the latest release for your deployment.

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Older releases | ❌ (upgrade to latest) |

## Reporting a Vulnerability

If you discover a security vulnerability in Notees, please report it privately so we can address it before public disclosure.

**Please do NOT open a public issue for security vulnerabilities.**

### How to report

1. Email the maintainers at the address listed in the repository's contact information with:
   - A clear description of the vulnerability.
   - Steps to reproduce (minimal examples or configuration details).
   - The impact you believe the issue has (data exposure, privilege escalation, DoS, etc.).
   - Any suggested remediation or patches.
2. Allow up to 7 days for an initial response.
3. We will work with you to validate the issue, prepare a fix, and coordinate disclosure.

## Security Practices

- **Secrets**: `SECRET_KEY` and database credentials must be provided via environment variables or `.env`; never commit them.
- **HTTPS**: Production deployments must use HTTPS. The dev stack uses HTTP only for local development.
- **Dependencies**: Run periodic dependency audits (`pip-audit` for backend, `npm audit` for frontend).
- **Updates**: Keep the base Docker images, Python packages, and Node packages current.

## Security Hardening Checklist

- [ ] `SECRET_KEY` is at least 32 characters and generated with `python scripts/generate_secret_key.py`.
- [ ] `ADMIN_PASSWORD` is set explicitly rather than relying on a generated random password.
- [ ] Production runs behind HTTPS with HSTS enabled (`reload=False` / `ENVIRONMENT=production`).
- [ ] `CORS_ORIGINS` is empty or restricted to known origins only.
- [ ] PostgreSQL is not exposed publicly; the app connects over a private network.
- [ ] Backups are encrypted at rest and tested periodically.
