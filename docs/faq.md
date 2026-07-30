# Frequently Asked Questions

---

## Is Notees really offline-first?

Yes. The authoritative workspace data lives in a client-side SQLite database inside the browser (via `sql.js`/WebAssembly). Reads and most writes work without a network connection. Local operations are queued and synced to the server when the browser is online.

---

## Is Notees self-hosted?

Yes. Notees is designed to run on your own server. The default deployment uses Docker Compose with a FastAPI backend, PostgreSQL, and Redis. No cloud service is required.

---

## Is my data end-to-end encrypted?

**Not currently.** Operation payloads are transported as plaintext JSON inside the relay envelope. Transport-layer encryption (TLS in production, Tailscale/WireGuard in dev) protects data in transit, and the server stores operation contents.

End-to-end encryption of payloads and local IndexedDB persistence is planned but not yet implemented. Do not store highly sensitive information in Notees until that work lands. See [SECURITY.md](SECURITY.md).

---

## Is there a mobile app?

Yes. The Flutter mobile app is a native companion focused on the workflows most useful on phones. It lives in a separate repository: [miquelrosell99/notees-flutter](https://github.com/miquelrosell99/notees-flutter).

The web app remains the full-featured desktop editing surface. See the feature matrix in [Usage](usage.md#web-vs-mobile-app).

---

## How is data backed up?

Notees keeps automatic backups in `data/backups/`. You can also export individual pages or workspaces to Markdown, HTML, PDF, or OPML.

Backups created by the application are **not encrypted by the application**. Store them on encrypted volumes or encrypt them outside the app.

---

## Can I migrate from another tool?

Notees has a plugin-based importer system. A built-in Logseq Markdown-folder importer is available in `frontend/src/plugins/builtin/logseq_importer/`. Additional importers can be added as plugins.

---

## How do I update Notees?

Pull the latest source, rebuild the production image, and restart the containers:

```bash
git pull
docker build -t notees .
docker compose up -d
```

Always back up your data before updating.

---

## What happened to the legacy `/api/nodes/*` endpoints?

They were removed in Notees 2.0. The frontend now reads and writes through the local SQLite store and syncs via `/api/relay/*`. See [API Reference](api.md).

---

## Can I run Notees without Docker?

Yes, but it is not the recommended path. See [Installation](installation.md#local-development-alternative) for the local-development alternative. You must manage PostgreSQL, Redis, and `pg_dump` yourself.

---

## Where is the full technical architecture documented?

See [architecture.md](architecture.md) for the data model, query layer, rendering pipeline, sync protocol, and key source files.
