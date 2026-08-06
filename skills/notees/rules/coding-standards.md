# Coding Standards — Notees

## Python

- Target Python 3.12+.
- Linter/formatter: Ruff (config in `pyproject.toml`).
  - Line length 120.
  - Enabled: E, W, F, I, N, UP, B, C4, SIM.
  - Ignored: E501 (handled by formatter), B008 (FastAPI `Depends()` in defaults).
  - Docstring convention: Google.
- Type checker: mypy with `disallow_untyped_defs = true` and `ignore_missing_imports = true`.
- Prefer explicit typing on public functions and methods.

## TypeScript / React

- TypeScript ~6.0, strict mode.
- Linter: ESLint with React Hooks and JSX a11y plugins.
- Formatter: configured via ESLint / project defaults.
- Hooks rules: follow `eslint-plugin-react-hooks`.
- Path aliases only — no relative `../../../` imports.
- **When parsing `node.content` as an AST to resolve `node_link` pills, formatting, or other inline nodes, always run it through `unwrapCrdtContentAst()` first.** The inline editor saves content by serializing the real AST to JSON and storing that JSON string inside the node's text CRDT, so the derived SQLite `content` column can be `[{type:'text',text:'[<real AST>]'}]`. Parsing the wrapper directly makes node links render as raw JSON or "…".
- **Display helpers that cannot resolve a `node_link` must fall back to the link label or target UUID, never the "…" placeholder.** `deriveName` and `nodeNameToText` are used by many surfaces (breadcrumbs, sidebars, search, command palette, cards). Returning "…" for a link-only node makes those surfaces unusable; returning the target UUID keeps the reference identifiable until a resolver can fetch the target's display name.

## Tests

- Backend: pytest.
- Frontend: Vitest (jsdom) and Playwright for E2E.
- Every bug fix and feature should include a test that fails before and passes after the change.

## Git

- Conventional Commits.
- Stage only edited files; avoid `git add -A`.

## Documentation

- Agent reference docs live under `skills/notees/`.
- User-facing docs live under `docs/`.
- Plans and working artifacts live under `skills/notees/references/agents/plans/`.
