# Architecture — Notees

## Core Invariant: Operation Log as Source of Truth

Notees is local-first. The authoritative data model is an immutable operation log. PostgreSQL persists the encrypted relay log, snapshots/compaction segments, users, workspace membership, share metadata; the client-side SQLite database is a derived view.

## Layers

- **Operation log** (`app/core/operation.py`): immutable, ordered by Hybrid Logical Clock (HLC). All mutations append operations; last-write-wins ordering makes new operations authoritative on next sync.
- **Relay** (`app/relay/`): encrypted operation relay server; the only sync path between clients.
- **Backend** (`app/`): FastAPI feature-first hexagonal architecture. Domain services depend on repository ports, not framework or driver details.
- **Frontend runtime** (`frontend/src/core/`): sql.js/IndexedDB SQLite + core hooks + sync engine; the sole data path for the web client.
- **Derived stores**: client-side SQLite materializes nodes, hierarchy (adjacency list via `parent_id`), links, and QueryAST collections from the operation log.

## Data Model

Everything is a `node` (pages, blocks, classes) with class assignments and relational property schemas. Hierarchy is an adjacency list materialized in the derived store.

## Sync Contract

- All state changes travel through the operation log.
- Migrations fix bad data by appending new operations, not by editing existing envelopes or adding client-side backward-compatibility shims.
- The relay is the only sync path; no direct PostgreSQL-derived-table mutation reaches clients.

## Read More

- Backend patterns: `references/agents/backend.md`
- Data model: `references/agents/data-model.md`
- Relay / sync: `references/agents/mobile-sync.md`
- Plugin system: `references/agents/plugin-system.md`
