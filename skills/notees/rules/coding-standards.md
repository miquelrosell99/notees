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
