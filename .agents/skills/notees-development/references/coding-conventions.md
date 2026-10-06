# Coding conventions

Canonical: `docs/developers/development.md` and
`docs/developers/ui-primitives.md`. Package-level TypeScript conventions:
the fleet `typescript-conventions` skill.

## Language + module rules

- TS 5.6 **strict** (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), ES2022, bundler module resolution, ESM only
  with explicit `.js` suffixes on relative imports.
- Packages export raw TS (`"exports": { ".": "./src/index.ts" }`,
  dev condition) — only deployables (server/web Docker images) bundle. This is
  why vitest reads `src` but `tsc` reads `dist` (rebuild dist before
  typechecking dependents after an API change).
- zod strict everywhere (wire envelopes, API bodies, QueryAST).
- Naming: camelCase on the wire, snake_case in DB columns/tables.
- SQL: positional `?` params only; no AUTOINCREMENT in the derived schema —
  derived ids are content hashes (determinism: wipe → replay → identical).
- Comments point at the spec they implement (e.g. `// see SCHEMA.md`).

## Commits

Conventional Commits: `feat(web): …`, `fix(server): …` style.
Never re-tag a release; same-day correction = next patch tag.

## Web UI primitives law (binding for any apps/web change)

Full catalog and drift classes: `docs/developers/ui-primitives.md`.

1. All chrome composes from `apps/web/src/ui/components/ui/` — one element
   per file, co-located CSS, barrel-exported. No ad-hoc styled controls in
   feature code.
2. Token-only CSS from `src/ui/variables.css` — no hex/rgba literals.
3. Values that track type metrics or layout take the adaptive form
   (`1lh`/`em`/`ch`/`%`, `clamp()`, spacing/radius/motion tokens); hard-coded
   px only where genuinely constant (hairlines, tap-target floors).
4. Popups compose `usePopupDismissal` (Escape + pointer-down-outside seam).
5. Never mention legacy version names in files/comments/classes.
6. The drift gate `css-token-drift.test.ts` enforces the font-size slice —
   run the web suite after touching CSS; a failure in your blast radius is
   yours to fix before claiming done.

## Anti-hallucination register

`docs/developers/development.md` lists the designed-not-built items
(typed-link resolution, citations + MD export, asset annotations,
property-schema CRUD UX, `notees shell` REPL, computed properties, E2EE,
plugins, multi-user auth, outliner editor program, TreeCrdt port). Do not
document, export, or test them as existing. `docs/developers/architecture.md`
reconciles code-vs-design discrepancies — code wins.
