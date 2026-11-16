# Manual smoke checklist — host-only behavior

The parts of the Notees-for-Word add-in that vitest cannot cover: real Word
hosts, real sideloading, real field rendering. Run every item against a real
build (`pnpm build:localhost`, served by `notees word serve` at `http://localhost:8471`) before calling a
lane done. Check items off here only by hand.

Pairing for all items below: `notees serve --origin http://localhost:8471` on the same machine,
pane settings → port + token → Connect.

## Host lifecycle & pairing

- [ ] **1. Shared-folder sideload (Windows desktop).** Sideload via the
  shared-folder catalog (registry trusted-catalog entry, Insert → My Add-ins →
  SHARED FOLDER). The pane loads from `http://localhost:8471/index.html`, pairs
  with the bridge, and settings (port + token) persist across a Word restart.
- [ ] **2. Bridge offline / reconnect.** Stop `notees serve` → open the pane:
  it shows "bridge offline"; field text already in the document is untouched.
  Restart the bridge → **Connect** succeeds without reloading the pane.
- [ ] **3. Word for the web (admin-center sideload).** Deploy via the admin
  center, open the pane in Word for the web: the pane loads, the badge counts
  fields, and refresh shows the read-only-host message instead of failing when
  the WordApi 1.5 field APIs are unavailable.
- [ ] **4. Portability.** Save a document with notees citations as `.docx`,
  reopen it in LibreOffice: citations still show their rendered text (the
  `ADDIN notees.Citation` field carries its display text; documents stay
  portable).

## Insert & fields

- [ ] **5. Insert citation.** Insert a citation from a search result → a field
  appears with the rendered citation text; toggling field codes (Alt+F9) shows
  `ADDIN notees.Citation {…}` with the embed JSON.
- [ ] **6. Search box.** Type a query in the pane's search box → after the
  debounce the search fires and results render. (The stable-searchFn fix —
  searching the re-paired bridge, not the first-render one — only shows on a
  real re-pair: connect, change the port/token, connect again, and search —
  the second bridge must answer, not the first.)

## Refresh

- [ ] **7. Refresh after an edit.** Edit the source's year in Notees →
  Refresh in the pane: the citation text updates. Save, close, reopen the
  document → Refresh still works.
- [ ] **8. Two citations.** Insert two citations → Refresh → both texts
  rewrite in place and both remain fields (toggle field codes to confirm the
  `ADDIN notees.Citation` codes survived).
- [ ] **9. Foreign and corrupted fields.** Open a document containing Zotero
  `ADDIN ZOTERO_ITEM` fields plus one hand-corrupted notees field → Refresh
  leaves both untouched and reports them as "skipped".
- [ ] **10. Hand-corrupted notees field.** Corrupt the embed JSON inside a
  notees field's field code by hand (delete a brace) → Refresh leaves that
  field's text exactly as-is; it is reported skipped, never rewritten or
  deleted.

## Bibliography

- [ ] **11. Insert & replace.** Insert a bibliography → the paragraph appears.
  Insert a second citation, re-run → the SAME paragraph is replaced, not
  duplicated.
- [ ] **12. Field index → paragraph mapping.** Place several citation fields
  BEFORE the bibliography in the document → Refresh and re-insert the
  bibliography: the bibliography paragraph is the one replaced (the field
  index → paragraph mapping must not be thrown off by preceding fields).
- [ ] **13. Duplicated bibliography.** Duplicate the bibliography paragraph by
  hand (copy/paste) → re-run Insert/Replace bibliography: the FIRST
  bibliography is replaced and the extras are reported (count in the outcome),
  never silently left in place.

## Paragraph semantics (recorded behavior, confirm it reads right)

- [ ] **14. Whole-paragraph replace.** Put sibling content in the bibliography
  paragraph (text before/after the bibliography field) → re-run Insert/Replace:
  the whole paragraph is replaced, so that sibling content is replaced too.
  This is the shipped, documented behavior — confirm it is acceptable in
  practice, not a silent surprise.
- [ ] **15. Style picker.** Switch the style picker → new insertions use the
  new style; existing citations stay unchanged until "Refresh all with this
  style", which rewrites every notees citation's code and text to the new
  style.
