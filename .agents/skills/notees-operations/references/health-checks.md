# Health checks

Canonical: `docs/developers/deployment.md`.

## Endpoints (on notees-sync, default 8377)

- `GET /healthz` — auth-free liveness; body OK ⇒ process up.
- `GET /api/version` — auth-free; image/version probe.
- `GET /meta` — authenticated meta.
- The container healthcheck is `wget -qO- http://127.0.0.1:8377/healthz ||
  exit 1`, interval 30 s, timeout 5 s, retries 3, start_period 15 s.
  `notees-web` starts via `depends_on: service_healthy` — if web never comes
  up, look at sync's health first.
- `docker compose ps` shows `(healthy)` per container.

## Post-deploy verification (the smoke)

```sh
cd scripts/screenshots
NOTEES_ADMIN_PASSWORD=$(cat ../../config/notees/.admin_password) node verify-min.mjs
```

End-to-end through the real web UI: boots the production stack window, logs
in via `/api/auth/login`, seeds localStorage, asserts no sync error in the
footer + a known search hit renders + no raw JSON in the body. Prints
`VERIFY-PASS` / `VERIFY-FAIL`; exit 1 on fail.

## Headless UI probes (playwright)

- **Sign in through the bootstrap's API-key tab** with the operator key
  (`config/notees/sync/api_key.txt`) when the admin password is not at hand —
  no password needed, and no lockout risk.
- **Never brute-force the sign-in**: repeated bad passwords return 401 and
  trip a per-email rate limit (429, "try again in 15 minutes"). A lockout
  only affects the attacked email, but it still costs a quarter hour.
- **Origin pinning:** the live stack's `NOTEES_CORS_ORIGIN` is pinned to
  `http://localhost:8378` — probes must browse `http://localhost:8378`, not
  `http://127.0.0.1:8378` (different origin, CORS-preflight fails with
  opaque network errors).
- **Throwaway probe stack** (`scripts/screenshots/run.sh` pattern): the web
  image's nginx config hardcodes the sync upstream host name `notees-sync`,
  so the throwaway pair must share a user-defined network with the sync
  container carrying `--network-alias notees-sync` — the default bridge does
  not resolve container names. Rendering probes are read-only (recents write
  browser-local storage only); keep them off the production stack unless
  reading live layout, and never run write probes against it.

## Quick manual matrix

```sh
curl -fsS http://127.0.0.1:8377/healthz          # liveness
curl -fsS http://127.0.0.1:8377/api/version      # version drift check
curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8378/   # web nginx
docker compose ps                                # (healthy) on both
```

When checking through Tailscale serve, use the `https://<host>.<tailnet>.ts.net`
name — the bare hostname has no TLS identity. If the host runs
`accept-dns=false`, verify with
`curl --resolve <host>.<tailnet>.ts.net:443:127.0.0.1 https://<host>.<tailnet>.ts.net/healthz`.
