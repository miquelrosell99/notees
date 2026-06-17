# Security Policy

## Supported Versions

Only the latest commit on the main branch is actively supported with security updates. Because Notees is self-hosted, administrators should pull the latest image/source and redeploy to receive fixes.

## Reporting a Vulnerability

Please report security issues by emailing the maintainers directly. Do not open a public issue for undisclosed vulnerabilities.

When reporting, include:
- A clear description of the issue
- Steps to reproduce (or a minimal proof of concept)
- Affected version / commit
- Suggested remediation, if any

## Security Practices

- **Secrets**: `SECRET_KEY` must be at least 32 characters and stored in the environment, never in source control.
- **Auth**: JWT access and refresh tokens are issued as `SameSite=Strict`, `HttpOnly` cookies.
- **CORS**: Keep disabled unless frontend and backend are intentionally served from different origins.
- **HTTPS**: Set `ENVIRONMENT=production` to enable HSTS and HTTP→HTTPS redirects.
- **Backups**: Backup credentials are passed through environment variables, not command-line arguments.
- **Mobile**: Cleartext traffic is scoped to private/self-hosted hostnames in release builds; debug builds are permissive for local development only.

## Dependency Updates

Run `npm audit` in `frontend/` and review Python dependency advisories before deploying. The project aims to keep dependencies up to date; high/critical vulnerabilities should be patched before release.
