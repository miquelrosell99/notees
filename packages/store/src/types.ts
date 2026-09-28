/**
 * Shared statement surface for the helper modules (appliers, edges, stats,
 * search, content). Structural type so the helpers do not depend on any
 * concrete driver (better-sqlite3 or sql.js). Alias of the adapter interface
 * in `./db.js` — every SqliteDB is a valid StoreDatabase.
 */

import type { SqliteDB } from "./db.js";

export type { SqliteStatement } from "./db.js";

export type StoreDatabase = SqliteDB;
