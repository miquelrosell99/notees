# SDK publishing — `@notees/*` v2 packages

The four shared packages under `packages/` (`protocol`, `domain`, `store`, `sync`)
are npm-publishable. They build with tsup (`dist/index.js` ESM + `dist/index.d.ts`)
and carry full publish metadata (version `0.1.0-m1`, `exports`, `files`, `publishConfig`,
`repository`, `license: AGPL-3.0`).

## Exports arrangement (dev → src, publish → dist)

Each package's `exports` map has three conditions:

```json
".": {
  "types": "./dist/index.d.ts",
  "development": "./src/index.ts",
  "default": "./dist/index.js"
}
```

- **Workspace dev** (vite/vitest, anything running with the `development` condition)
  resolves to the TS source — unchanged from before.
- **`tsc`** does not set the `development` condition, so typechecking resolves to
  `dist/index.d.ts`. Run `pnpm build` before `pnpm typecheck` on a fresh clone.
- **Node/tsx production** resolves to `dist/index.js` — so `pnpm -r build` must run
  before `pnpm dev` / `pnpm start` if `dist/` was cleaned.
- Published tarballs ship `dist/` only (`files: ["dist"]`). The `development`
  condition still points at `./src/index.ts`, which is not in the tarball — harmless
  because consumers would have to opt into the `development` condition explicitly,
  but do not add `src` back to `files` without revisiting this.

## Release flow (one-shot)

```sh
pnpm release   # = pnpm -r --filter "./packages/*" build && pnpm -r --filter "./packages/*" publish
```

- Recursive runs go in topological order (protocol → domain → store → sync).
- Each package also has `"prepack": "pnpm build"`, so `pnpm publish` / `pnpm pack`
  rebuilds `dist/` even when run per-package.
- **Always publish with pnpm.** Only pnpm rewrites `workspace:*` dependencies to
  real versions (`0.1.0-m1`, verified via `pnpm pack`). Publishing the package
  directory with bare `npm publish` would upload the literal `workspace:*`
  specifier and produce a broken install.

## Auth setup (GitHub Packages)

```sh
npm config set //npm.pkg.github.com/:_authToken $(gh auth token)
```

`publishConfig.registry` is `https://npm.pkg.github.com` with `access: "restricted"`
on every package, so no extra flags are needed.

### Scope-mapping caveat (IMPORTANT)

The packages are scoped `@notees/*`, but **GitHub Packages requires the npm scope to
match the GitHub owner/org** — i.e. only `@miquelrosell99/*` can be published to
`miquelrosell99`'s GitHub Packages registry. As-is, `pnpm release` will be rejected
by the registry for a scope/owner mismatch. Options, in order of preference:

1. **Rename the scope to `@miquelrosell99/notees-*`** before the first real publish
   (mechanical rename across `packages/*`, `apps/*`, and imports).
2. Publish to npmjs instead (see TODO below) — npmjs has no scope/owner restriction.

## TODO: public npmjs registry

Publishing to public npm (`https://registry.npmjs.org`) needs an npm token owned by
the `miquelrosell99` npm account (GitHub tokens do not work there). Once available:

```sh
npm config set //registry.npmjs.org/:_authToken <npmjs-token>
# then either flip publishConfig.registry in the four package.json files, or:
pnpm -r --filter "./packages/*" publish --registry https://registry.npmjs.org \
  --access public   # AGPL: decide public vs restricted deliberately
```

## Verification performed (2026-09-26)

- `pnpm install` — clean; single tsup version (8.5.1) hoisted to the workspace root.
- `pnpm -r build` — all 4 packages emit `dist/` (ESM + DTS); apps (cli, server, web)
  still build. Required `removeNodeProtocol: false` in tsup configs: tsup's default
  strips `node:` prefixes, which broke the web app's `node:crypto`/`node:fs`/…
  aliases against the built `dist` output.
- `pnpm test` — 204 tests green across packages + apps; `pnpm typecheck` green.
- `npm publish --dry-run` in each package — tarball contains only `dist/` +
  `package.json`; registry and `restricted` access picked up from `publishConfig`.
- `pnpm pack` on `@notees/store` — confirmed `workspace:*` → `0.1.0-m1` rewrite.
