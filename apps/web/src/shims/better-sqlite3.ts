/**
 * Browser stub for `better-sqlite3`. The store's root module imports the
 * file-backed adapter unconditionally (`new Store(path)` shorthand), but the
 * web client only ever opens stores over the sql.js backend — this class is
 * never constructed in the app. The stub exists solely so the browser bundle
 * does not pull in the native better-sqlite3 binding.
 */

export default class BetterSqlite3Stub {
  constructor() {
    throw new Error(
      "better-sqlite3 is not available in the browser; use the sql.js backend (Store.open)",
    );
  }
}
