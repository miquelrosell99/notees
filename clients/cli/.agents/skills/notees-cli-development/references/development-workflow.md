# Development workflow

Canonical: `README.md` in this repo + the monorepo root's
`docs/developers/development.md`. Commands assume the monorepo root is the
pnpm workspace (Node 22 or 26 + pnpm 9 via corepack); running them from
`clients/cli` resolves the same workspace.

## Commands

```sh
corepack enable && corepack prepare pnpm@9.0.0 --activate
pnpm install                                # setup from the monorepo root (CI uses --frozen-lockfile)
pnpm -r --filter "@notees/*" build          # rebuild the core packages' dists (after changing a packages/* public API)
pnpm build                                  # tsup bundle → dist/cli.js (the `notees` bin)
pnpm typecheck                              # tsc --noEmit
pnpm test                                   # vitest run — the blocking gate
pnpm dev -- --help                          # run the CLI from source via tsx
```

**better-sqlite3 on node 26:** the core packages declare `better-sqlite3`
^11, whose native build fails on node 26's V8. The CLI carries its own
`^12.11.1` pin (node 20–26) in `package.json`. Do not widen it to v13
without checking the store/server adapter API.

CI-equivalent gate (run before claiming done on anything non-trivial):
`pnpm typecheck && pnpm test`. CI itself (`ci-cli.yml` at the monorepo
root) additionally runs the workspace build on every push/PR touching
`clients/cli/**` or `packages/**`.

**Dev-condition exports:** vitest resolves `src`, tsc resolves `dist`. After
changing a core package's public API, rebuild its dist first, then
typecheck and test.

## The workspace lockstep law (blocking)

`packages/*` is the lockstep boundary — there is no vendor pin:

- **Never edit fixture bytes anywhere.** A wire change / new op / strict
  payload change is not done in the monorepo until its fixture gate
  converges — byte-identical fixture files in `packages/protocol/fixtures/`,
  sha256-checked across the TS reference, GTK (`clients/gtk/tests/fixtures/wire/`),
  and Flutter (`clients/flutter/test/fixtures/wire/`) appliers. The root
  `fixture-drift` workflow enforces the sha256 identity on every push/PR
  that touches the corpus — one commit updates every copy.
- **Core changes land in `packages/*` here; the CLI converges in the same
  tree.** There is no submodule bump recipe anymore — after a core change,
  rebuild the packages' dists and run the gate:

  ```sh
  pnpm -r --filter "@notees/*" build   # rebuild the core dists
  pnpm build && pnpm test
  ```

  CI installs with `--frozen-lockfile`, so run `pnpm install` once locally
  to refresh `pnpm-lock.yaml` when dependencies changed, and commit that
  too.

## Test-suite shape

- One file, `test/cli.test.ts`; `vitest.config.ts` includes only
  `test/**/*.test.ts` so the core packages' own suites never leak into
  this run.
- The suite boots a **real** server (`buildServer` from `@notees/server`) on
  an ephemeral port with a temp workspace — no mocks of the object API. One
  server per file (per-test boots accumulated handles and flaked; generous
  30 s hooks are a bounded safety margin).
- Tests drive the CLI through `run()` with a captured `CliIo` (stdout/stderr
  captured, exit code asserted) — plus a few direct `ApiClient` calls where
  the CLI has no write path.
- Test data ids/names are arbitrary strings (`t1-cli-page-v2`, `expm-fp-a`);
  they are data, not version labels — do not "scrub" them.

## Coding conventions

- TypeScript ESM (`"type": "module"`, `.js` import specifiers), strict tsconfig.
- Commander program built in `buildProgram()` (`src/cli.ts`); every command
  action resolves its `CommandContext` via `ctxOf(command)`.
- Output goes through `emit(ctx, humanText, machine)` — `--json` prints the
  machine object; human text is free to change.
- Errors: throw `CliError` with an `EXIT` code (`src/exit-codes.ts`: 0 ok,
  1 domain, 2 usage, 3 auth, 4 conflict, 5 network). Fetch-level failures
  are exit 5; wire errors map via `exitCodeForWireError`.
- No client-side credential-shape checks — the credential is sent verbatim;
  only the server's 401 maps to exit 3.
- System ids (class/property UUIDs, date-chain ids) come from
  `@notees/domain` (`SYSTEM_CLASS_UUIDS`, `SYSTEM_PROPERTY_UUIDS`) — never
  re-hardcode a second copy.
- Dates are local-midnight (`todayIsoLocal`), never UTC.
