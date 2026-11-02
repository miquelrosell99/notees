# Resolver: PMID + ADS bibcodes, Unpaywall OA PDF, two-step Add Source dialog

Date: 2026-11-02 · Status: approved by owner, implementing · Slice: source-library resolver extension

## What ships

- **PMID provider** (server): NCBI E-utilities `esummary.fcgi?db=pubmed&id=…&retmode=json`
  (one GET, JSON). Title/authors ("Derks J" → "Derks, J")/journal/year/volume/issue/pages,
  DOI from `articleids`. Class `journal_article` via ZOTERO_ITEM_TYPE_TO_CLASS.
- **ADS bibcode provider** (server): `api.adsabs.harvard.edu/v1/search/query?q=bibcode:…`.
  Bearer token from the calling USER's prefs (`adsApiToken`, new per-user pref, user-level
  per owner decision). No token → 422 honest error pointing at Settings → Account.
- **Unpaywall enrichment** (server): after a DOI/PMID/ADS resolve with a DOI, one GET
  `api.unpaywall.org/v2/{doi}?email=notees-resolver@notees.local` (generic constant);
  `best_oa_location.url_for_pdf` → `record.pdf.url`. Failure never fails the resolve.
- **New seed property `pmid`** (domain): pool slot `…0006-000000000056`, text, bindTo
  source, PINNED (amends the 2026-10-27 roster), display name "PMID". Live workspaces
  converge by `scripts/migrate-pmid-property.mts` (Path A). GTK/Flutter manifests checked:
  neither carries the bibliographic pool slice (GTK task-family only; Flutter base+task+
  card+project) — no client code change; converges through the log.
- **Two-step Add Source dialog** (web): footer Cancel · Fetch · Next (Next disabled until
  a fetch succeeds in the session); inline preview card (title/authors/year/venue/
  identifiers/OA-PDF note); PDF drop zone gains a fetched-link chip (url intent; picked
  file wins; link-only lands on the source `url` property at create — existing semantics).
- **Classifier** (web): pmid (`PMID: …`, pubmed URLs, bare ≤8 digits — never ISBN-shaped)
  and ads (bare 19-char bibcode, adsabs abs URLs).
- **Duplicate warning** gains PMID (citationDraftOf/findSourceByIdentifier).
- **Settings → Account**: ADS API token field (password-style) writing per-user prefs.

## Key files

- `packages/domain/src/seeds.ts` (UUID map + SPECS + DISPLAY_NAMES + pin roster comments)
- `apps/server/src/resolve-source.ts`, `routes-objects.ts` (/resolve), `auth.ts`
  (user_prefs.ads_api_token additive column), `routes-prefs.ts`, `openapi.ts`
- `apps/web/src/features/sources/resolver.ts`, `AddSourceDialog.tsx`
- `apps/web/src/features/modals/quickCreate.ts` (ensure/draft/duplicate), `QuickCreateModal.tsx`
- `apps/web/src/core/workspace-client/prefs.ts`, `client-server.ts`
- `apps/web/src/features/settings/SettingsPage.tsx` (Account section)
- `scripts/migrate-pmid-property.mts`
- Docs: `docs/api.md`, sources feature doc, `CHANGELOG.md`

## Out of scope

Batch multi-identifier paste (Zotero magic-wand parity), block-context "link to source"
command, pending-task helper. Server never downloads publisher PDFs (link-only intent).

## Verification

Scoped gates (domain → server → web), then the full root gate. Redeploy notees-sync +
notees-web, verify-min smoke.
