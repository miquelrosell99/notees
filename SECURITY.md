# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Notees, please report it privately
so we can investigate and fix it before disclosure.

**Please do not open a public issue for security bugs.**

Instead, send an email to the maintainers at:

**security@notees.local**

Include as much detail as you can:

- A clear description of the vulnerability
- Steps to reproduce it
- The version or commit you tested against
- Any suggested remediation (optional)

We aim to acknowledge reports within 5 business days and will coordinate a
release timeline with you before any public disclosure.

## Supported Versions

Security fixes are applied to the latest release and, when practical, the
previous minor release series. Self-hosted deployments should stay on the most
recent tagged release.

## Security Best Practices for Self-Hosters

- Set `ENVIRONMENT=production` to enable hardened security headers (HSTS,
  HTTPS redirect).
- Keep `SECRET_KEY` secret, random, and at least 32 characters long.
- Run Notees behind HTTPS in production.
- Restrict `CORS_ORIGINS` to the specific origins you serve; avoid wildcards
  when credentials are enabled.
