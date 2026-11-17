---
name: notees-cli-operations
description: Release and package the Notees CLI (`clients/cli` in the Notees monorepo). Use when cutting a CLI release, bumping CLI_VERSION, or deciding how the CLI is distributed/installed. Covers the `cli-v*` git-tag release mechanism, the version train, and the never-re-tag law.
---

# Notees CLI operations

The CLI ships as source + git tags — there is no npm publication and no
docker image. A release = a `cli-vX.Y.Z` tag whose version matches
`CLI_VERSION` in `src/cli.ts`; `.github/workflows/release-cli.yml` at the
monorepo root builds the bundle on the tag push and attaches it (`cli.mjs` +
sha256 sidecar) to the tag's GitHub Release, which `scripts/install.sh`
fetches, verifies, and links. Releases ride the server's release train:
`CLI_VERSION` tracks the monorepo's server version, and the `doctor`
command warns when the server is ahead of the CLI.

Canonical detail: `references/releases.md`; the deployment it talks to is
the monorepo's `notees-sync` + `notees-web` docker compose stack (see the
root `docs/developers/deployment.md`).

## Non-negotiable laws

1. **Git tags are the release mechanism.** A release = a `cli-vX.Y.Z` tag
   whose version matches `CLI_VERSION` in `src/cli.ts`, cut after the gate
   is green (`pnpm typecheck && pnpm test`, plus `pnpm build`). The version
   is informational — consumers install from the release bundle at a tag.
2. **Never re-tag a release.** Same-day correction = next patch tag
   (the law extends to the `cli-v*` prefix).
3. **A core-package change is not a release by itself.** When `packages/*`
   ships protocol/store changes the CLI needs, they land in the same
   workspace and CI's `ci-cli.yml` re-gates the CLI against them; tag when a
   user-visible CLI slice ships.
4. **The CLI never pins the server.** It talks to whatever `notees-sync`
   endpoint the user points it at; version drift is surfaced by `doctor`,
   not enforced.
5. **Fleet-agnostic artifacts** — never hardcode host names, IPs, or tailnet
   names in code, docs, or release notes; write `<host>`, `<tailnet>`, "the
   fleet host".

## Read by topic

- **Releases & packaging** (tag mechanics, version train, install paths,
  fleet-host consumption) → `references/releases.md`
