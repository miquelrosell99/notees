# Configuration

Notees reads configuration from environment variables or a `.env` file in the project root. Copy `.env.example` to `.env` and fill in the required values before starting the app.

---

## Required variables

These must be set or the app will not start correctly.

| Variable | Example | Description |
|----------|---------|-------------|
| `SECRET_KEY` | `Xk9...` | JWT signing key, minimum 32 characters. |
| `ADMIN_PASSWORD` | `MyStr0ng!Pass` | Initial admin password for first-boot registration. Must be at least 12 characters with uppercase, lowercase, digit, and special character. |
| `POSTGRES_PASSWORD` | `dbpass` | PostgreSQL password. |

### `SECRET_KEY`

`SECRET_KEY` is mandatory and must be at least 32 characters long. It is used to sign JWT access and refresh tokens.

Generate a secure key with:

```bash
python scripts/generate_secret_key.py
```

Or manually:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Add the generated value to `.env`:

```bash
SECRET_KEY=your-generated-secret-key-here
```

### `ADMIN_PASSWORD`

If no admin user exists on startup, the first registration is allowed **only** when `ADMIN_PASSWORD` is set to a strong password meeting these requirements:

- At least 12 characters
- Contains uppercase, lowercase, digit, and special character

The registrant must provide the exact `ADMIN_PASSWORD` during registration. The first admin account is created with `ADMIN_PASSWORD`, not with the registrant's chosen password.

If `ADMIN_PASSWORD` is unset, empty, or too weak, first-boot registration is rejected and the instance stays locked. You can still bootstrap an admin manually:

```bash
python scripts/promote_user_to_admin.py <email>
```

---

## Database connection

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST` | `localhost` | PostgreSQL host. |
| `POSTGRES_PORT` | `5433` | PostgreSQL port. Dev stack maps container port `5432` to host port `5433`. |
| `POSTGRES_USER` | `notees` | PostgreSQL user. |
| `POSTGRES_DB` | `notees` | PostgreSQL database name. |
| `POSTGRES_PASSWORD` | (required) | PostgreSQL password. |

In `compose.dev.yaml`, the backend connects to `postgres:5432` inside the container network and the host exposes `5433`.

---

## Security variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVIRONMENT` | `development` | Set to `production` to enable HSTS/HTTPS redirect and short-lived tokens. |
| `CORS_ORIGINS` | (unset) | Comma-separated allowed origins. CORS is disabled by default. Wildcard origins with credentials are rejected. |
| `ACCESS_TOKEN_EXPIRE_HOURS` | `1` / `8` (dev) | Access token lifetime in hours. |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `7` / `30` (dev) | Refresh token lifetime in days. |
| `REFRESH_TOKEN_REMEMBER_ME_DAYS` | `90` | Refresh token lifetime when "remember me" is selected. |
| `REFRESH_TOKEN_REUSE_GRACE_SECONDS` | `30` | Reuse grace period for rotated refresh tokens. |

Token lifetimes are environment-aware:

- **Development** (`ENVIRONMENT=development`): access token defaults to 8 hours, refresh token to 30 days.
- **Production** (`ENVIRONMENT=production`): access token defaults to 15 minutes, refresh token to 7 days.

Set `ENVIRONMENT=production` to use the production defaults and security headers.

---

## Server and runtime variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8001` | Backend port for local runs. In Docker the container exposes `8000`. |
| `HOST` | `0.0.0.0` | Backend bind host. |
| `REDIS_URL` | `redis://localhost:6380/0` | Redis connection for rate limiting and real-time broadcast. In Docker Compose the backend uses `redis://redis:6379/0`. |
| `TZ` | `UTC` | Container timezone. |
| `LOG_LEVEL` | `INFO` | Logging verbosity. |
| `PUID` / `PGID` | `1000` | Host user/group IDs mapped into containers for file permissions. |

---

## Feature toggles

| Variable | Default | Description |
|----------|---------|-------------|
| `REGISTRATION_ENABLED` | `false` | Allow open user registration. First-boot admin registration still requires `ADMIN_PASSWORD`. |
| `BACKUP_INTERVAL_SECONDS` | `3600` | Automatic backup interval. |
| `MAX_BACKUPS` | `50` | Maximum number of automatic backups to keep. |

---

## Data retention

Workspace settings override these defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_TRASH_RETENTION_DAYS` | `30` | Days items remain in trash before hard deletion. |
| `ACTIVITY_LOG_RETENTION_ENABLED` | `true` | Enable activity log retention. |
| `ACTIVITY_LOG_RETENTION_DAYS` | `90` | Days to keep activity log entries. |
| `TASK_COMPLETION_RETENTION_ENABLED` | `true` | Enable task completion retention. |
| `TASK_COMPLETION_RETENTION_DAYS` | `365` | Days to keep task completion records. |

---

## Email (optional)

Email settings are required only if you send invitations from Notees.

| Variable | Example | Description |
|----------|---------|-------------|
| `SMTP_HOST` | `smtp.example.com` | SMTP server host. |
| `SMTP_PORT` | `587` | SMTP server port. |
| `SMTP_USER` | `notees@example.com` | SMTP username. |
| `SMTP_PASSWORD` | `...` | SMTP password. |
| `SMTP_TLS` | `true` | Use TLS for SMTP. |
| `SMTP_FROM` | `notees@example.com` | From address for outgoing email. |
| `PUBLIC_URL` | `https://notees.example.com` | Public URL used in invitation links. |

---

## Frontend development variables

These apply only to the Vite development server inside `compose.dev.yaml`.

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_ALLOWED_HOSTS` | `localhost,atlas,atlas.ts.net` | Comma-separated hostnames allowed by the Vite dev server. Add your local hostname or Tailscale MagicDNS name if accessing from a remote host. |
| `VITE_WS_URL` | (unset) | Direct WebSocket URL for live sync. When unset, the app uses the current page host. |

After changing `VITE_ALLOWED_HOSTS`, recreate the frontend container:

```bash
docker compose -f compose.dev.yaml up -d --force-recreate frontend
```

---

## Push notifications (optional)

| Variable | Description |
|----------|-------------|
| `FCM_SERVER_KEY` | Firebase legacy server key for mobile push delivery. For FCM HTTP v1, replace the adapter in `app/infrastructure/push/fcm.py`. |

---

## Security checklist

Before deploying to production:

- [ ] Set a strong `SECRET_KEY` (minimum 32 characters).
- [ ] Set a strong `ADMIN_PASSWORD` before first startup.
- [ ] Set `ENVIRONMENT=production`.
- [ ] Enable HTTPS with valid certificates.
- [ ] Set `CORS_ORIGINS` explicitly; do not rely on defaults.
- [ ] Set up database backups (`data/backups/`).
- [ ] Review rate limiting settings.
- [ ] Regularly update dependencies.
- [ ] Monitor application logs for security issues.

See [SECURITY.md](SECURITY.md) for the security policy, reporting process, and known limitations.
