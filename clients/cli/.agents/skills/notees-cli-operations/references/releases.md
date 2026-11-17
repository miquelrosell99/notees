# Releases & packaging

Canonical: `README.md` here ("Versioning") + the monorepo root's
`docs/developers/deployment.md`. The deployment the CLI talks to is the
monorepo's compose stack (`notees-sync` :8377 + `notees-web` :8378);
operate that stack with the root `notees-operations` skill, not this one.

## Release mechanism: `cli-v*` git tags + an attached bundle

- There is **no** npm publication and **no** docker image; the monorepo
  root's `ci-cli.yml` remains build+test only. Tags additionally carry a
  **release bundle**: `.github/workflows/release-cli.yml` runs on `cli-v*`
  tag pushes, a `guard` job fails the run unless the tagged commit touches
  `clients/cli/`, then the gate re-runs (workspace build, typecheck, test),
  `dist/cli.js` is built and attached to the tag's GitHub Release as
  `cli.mjs` + `cli.mjs.sha256` (named `.mjs` so the standalone ESM bundle
  keeps its module type without a package.json).
- `CLI_VERSION` (in `src/cli.ts`) rides the monorepo's server release train
  (e.g. tag `cli-v3.2.0` ↔ `CLI_VERSION = "3.2.0"`). The `doctor` command
  compares the server's version against `CLI_VERSION` and warns when the
  server is ahead ("rebuild the CLI — response shapes may be stale").
- A release is a `cli-vX.Y.Z` git tag on `main`, cut after the gate is
  green: `pnpm typecheck && pnpm test` (plus `pnpm build`). The tag is the
  reference point for source installs; the attached bundle is the
  no-toolchain install path (see below).
- The same release feeds the **pacman package**: `packaging/arch/PKGBUILD`
  builds from the `cli-v$pkgver` release assets of the
  `miquelrosell99/notees` repo, with pacman-side checksum verification. The
  workflow greps the staged bundle's sha256 into the PKGBUILD before
  publishing (a stale checksum fails the release), and a `pacman-smoke`
  job build-installs the package on an Arch container and runs the packaged
  `notees`. AUR publication is deliberately deferred — the in-repo PKGBUILD
  is the supported way to build it.

## Cutting a release

1. Land the change on `main` with its `CHANGELOG.md` entry and a green gate.
2. Bump `CLI_VERSION` in `src/cli.ts` to match the server train version.
3. Rebuild and update `packaging/arch/PKGBUILD` — `pkgver` and
   `sha256sums[0]` must match the new tag's assets (the build is
   deterministic: `pnpm build && sha256sum dist/cli.js` at the final tree
   gives the value; the workflow re-verifies it before publishing).
4. `pnpm typecheck && pnpm test && pnpm build`.
5. `git tag cli-vX.Y.Z && git push origin cli-vX.Y.Z` — the release
   workflow gates, checks the PKGBUILD checksum, creates the GitHub Release
   with the assets, and runs the pacman smoke; no manual `gh release
   create` step.

**Never re-tag.** Same-day correction = next patch tag. Tags are the only
release coordinate; moving one breaks "which source is this install".

## Installing / consuming

- **From a release bundle** (no toolchain): `scripts/install.sh` resolves
  the newest GitHub Release whose tag matches `^cli-v[0-9]`, downloads its
  `cli.mjs` + checksum, verifies it, and links `notees` into
  `~/.local/bin` (override `NOTEES_INSTALL_DIR`):
  `curl -fsSL https://raw.githubusercontent.com/miquelrosell99/notees/main/clients/cli/scripts/install.sh | bash`
  (append a version to pin: `| bash -s -- 4.6.0` — `4.6.0`, `v4.6.0`, and
  `cli-v4.6.0` all resolve). Requires bash, curl, node ≥ 22.
- **On Arch**: `packaging/arch/PKGBUILD` — `makepkg -si` from a tag
  checkout (see the README). AUR publication is deferred; this file is the
  supported build.
- **From source**: clone the monorepo, `pnpm install` from the repo root,
  `pnpm --filter @notees/cli build`, put `clients/cli/dist/cli.js` (the
  `notees` bin) on PATH — or run via `pnpm --filter @notees/cli dev`.
- On the fleet host the CLI is installed against the local `notees-sync`
  deployment; point it with `--server` / `NOTEES_SERVER` and a credential
  (`--key` / `NOTEES_API_KEY`, or `notees auth login`). Never hardcode the
  host's name/IP in docs or scripts — `<host>` / `<tailnet>`.

## Core-package changes vs releases

- A `packages/*` change (protocol/store) lands in the monorepo's own gate;
  it does not require a CLI tag. `ci-cli.yml` re-gates the CLI whenever
  `clients/cli/**` or `packages/**` moves, so lockstep drift surfaces as a
  red CI, not a stale pin.
- Tag when a user-visible CLI slice ships (new/changed commands, flags,
  output contracts) or when the version train moves.
