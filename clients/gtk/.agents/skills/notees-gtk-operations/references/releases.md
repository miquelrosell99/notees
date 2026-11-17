# Releases — notees-gtk

The full release/packaging picture for this tree (`clients/gtk`). Source of
truth for job definitions is `.github/workflows/` at the monorepo root; this
file explains how the pieces fit.

## Pipelines

### CI — `.github/workflows/ci-gtk.yml` (monorepo root)

Runs on every PR touching `clients/gtk/**`, on a nightly schedule
(`23 3 * * *`, covering `main`'s head), and on manual `workflow_dispatch`,
on pinned `ubuntu-22.04` runners with a per-ref concurrency group:

1. `actions/checkout` (SHA-pinned v7), `astral-sh/setup-uv` (SHA-pinned), `uv python install 3.12`
2. `uv sync`
3. `uv run pytest` — the full suite (e2e self-skips headless)
4. `uv run ruff check`
5. `uv run mypy src`

### Release — `.github/workflows/release-gtk.yml` (monorepo root)

Runs on `gtk-v*` tag pushes AND on manual `workflow_dispatch` (dispatch
builds artifacts only — the `release` job stays gated on
`refs/tags/gtk-v*`). A guard step fails a tag that touches no files under
`clients/gtk/`.

- **`python-dist` job** (ubuntu-latest): `uv run python -m build` → sdist +
  wheel uploaded as the `python-dist` artifact (`dist/`).
- **`archpkg` job** (`archlinux:latest` container): installs the build chain
  (`git base-devel python-build python-installer python-wheel python-hatchling
  python-httpx python-pydantic python-gobject gtk4 libadwaita`), creates a
  non-root `builder` user, runs `su builder -c makepkg`, uploads
  `notees-gtk-*.pkg.tar.zst` as the `archpkg` artifact.
- **`release` job** (only when `github.ref` starts with `refs/tags/gtk-v*`):
  needs both build jobs, downloads and merges the artifacts, publishes them
  with `softprops/action-gh-release` (SHA-pinned). Tags are therefore the
  only source of GitHub Releases; a manual dispatch produces artifacts only.

## Packaging

### PKGBUILD (`notees-gtk-git`)

- `pkgname=notees-gtk-git`, `provides=(notees-gtk)`, `conflicts=(notees-gtk)`.
- Sources the git repo itself (`git+https://github.com/miquelrosell99/notees.git`);
  `pkgver()` runs `git describe --long --tags --match 'gtk-v*' --abbrev=7` and
  mangles the result (`gtk-v` prefix stripped, `-g` → `.g`, `-` → `.`),
  falling back to `0.r<commits>.g<sha>` when no tag exists. **Tags drive the
  package version.** The build steps `cd` into `clients/gtk/`.
- `build()` = `python -m build --wheel --no-isolation`; `package()` =
  `python -m installer --destdir="$pkgdir" dist/*.whl`.
- Runtime deps: `python python-httpx python-pydantic python-gobject gtk4
  libadwaita` (PyGObject + GTK4/libadwaita provide the `ui` extra on Arch).
- Desktop integration: `data/dev.notees.Gtk.desktop` (Name=Notees,
  Icon=`dev.notees.Gtk` — the window's `set_icon_name`) installs to
  `/usr/share/applications/` alongside the hicolor icons; without it the
  app is missing from launcher apps menus.
- **No AUR publication.** Nothing is pushed to the AUR; this PKGBUILD is
  local/CI-only — the `-git` PKGBUILD builds from any clone locally, and the
  prebuilt install is the `archpkg` CI artifact.

### End-user install paths (from README)

- Arch: download the `archpkg` artifact from a green `release-gtk.yml` run on
  a `gtk-v*` tag (or a manual dispatch; `gh run list/download`) and
  `sudo pacman -U`, or `makepkg -si` from a clone.
- Other distros: `pipx install 'git+https://github.com/miquelrosell99/notees.git#egg=notees-gtk[ui]'` or a venv
  install; both pull the `ui` extra.

## Cutting a release

1. Ensure `main` is green (CI) and `pyproject.toml`'s `project.version`
   matches the tag you are about to push.
2. `git tag gtk-vX.Y.Z && git push origin gtk-vX.Y.Z`.
3. Watch `release-gtk.yml`: all three jobs green, Release published with the
   sdist, wheel, and `.pkg.tar.zst` attached.
4. Add the `CHANGELOG.md` entry for the release slice.

## Rolling back a bad release

- **Never delete or re-point the tag.** Mark the Release as a pre-release
  (or delete the Release assets if it was never announced), fix on `main`,
  and cut the next patch tag.
- A bad tag or dispatch build only affects CI/archpkg artifacts; they are
  replaced by the next green run and are not user-facing install sources.

## Consuming side

The client talks to a Notees server deployment (relay + object API, see the
monorepo root's `docs/developers/deployment.md` and the `notees-operations`
skill). Client data stays local under
`~/.config/notees-gtk/` and `~/.local/share/notees-gtk/`; server connection
(URL, API key / session) is configured at first launch.
