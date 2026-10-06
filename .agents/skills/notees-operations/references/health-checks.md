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
