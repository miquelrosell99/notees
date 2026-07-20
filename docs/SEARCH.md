# Search in Notees

Notees keeps its search index inside the client-side SQLite database. This makes search instant and available offline.

## How search works

1. **Derived plaintext** — whenever a node's content changes, the core store extracts plain text from the inline AST and writes it to the `search_index` table.
2. **Virtual table** — `search_index` is an SQLite [FTS4](https://www.sqlite.org/fts3.html) virtual table, created as:
   ```sql
   CREATE VIRTUAL TABLE search_index USING fts4(
     node_id,
     content,
     notindexed=node_id,
     tokenize=unicode61
   );
   ```
3. **QueryAST integration** — the `fts` QueryAST operator compiles to a `MATCH` against `search_index.content`.
4. **Ranking** — results are scored with a hand-rolled TF-IDF function that reads `matchinfo(search_index, 'pcx')`.

## Why FTS4 instead of FTS5

The `sql.js` build that ships on npm only enables FTS3/FTS4. Building FTS5 into the WASM bundle requires a custom Emscripten build of SQLite, which is not part of the current release pipeline. FTS4 covers the product's current needs:

- tokenisation with `unicode61` (diacritics, case folding),
- prefix matching (`term*`),
- indexed search over the full workspace,
- ranked result lists.

## Current limitations

- **No built-in BM25 / phrase-proximity ranking.** TF-IDF over FTS4 `matchinfo` is good enough for most cases but not as sophisticated as FTS5's `bm25()`.
- **Query syntax is sanitised.** User input is escaped to prevent FTS4 query-syntax injection. This disables power-user operators such as `OR`, `NEAR`, and phrase queries.
- **CJK text is tokenised by `unicode61` without word segmentation.** Chinese, Japanese, and Korean phrases are matched character-by-character rather than by word.

## Upgrading to FTS5

If the limitations above become blocking, the upgrade path is:

1. Build a custom `sql-wasm.wasm` with `-DSQLITE_ENABLE_FTS5` (fork the `sql.js` Makefile or use an alternative package such as `@sqlite.org/sqlite-wasm` / `wa-sqlite`).
2. Update the derived schema in both frontend and backend:
   ```sql
   CREATE VIRTUAL TABLE search_index USING fts5(
     node_id UNINDEXED,
     content,
     tokenize=unicode61
   );
   ```
3. Switch insert/reindex statements from `docid` to `rowid`.
4. Replace the TF-IDF ranker with `rank` or `bm25(search_index)`.
5. Update user-input sanitisation to allow FTS5-safe operators such as `NEAR` and phrase quotes.

This is a build-pipeline change, not a data-model change, so it can be done without migrating user data.
