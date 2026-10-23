/**
 * Per-class source field bindings (owner 2026-10-23, source-library slice 1
 * task 5): each source type-class → its Zotero field list, as pool property
 * names. Derived mechanically from `zotero/zotero-schema`
 * (`itemTypes[].fields`, the task-snapshot schema JSON):
 *
 * - every field of the class's Zotero item type maps to its pool key
 *   (camelCase identity; the renames are `abstractNote`→abstract,
 *   `type`→workType, `ISSN`→issn);
 * - EXCLUDED everywhere: `title` (title-is-content), `citationKey`
 *   (citekey), and the fields riding the source base via
 *   SYSTEM_PROPERTY_SPECS `bindTo: "source"` — the creator family
 *   (authors/linkedAuthors/editors), doi, isbn, publicationDate (Zotero
 *   `date`), publisher, url, attachments — never repeated per class;
 * - fields with NO pool property are dropped (the task-4 case-orphan ruling
 *   plus one-off type fields — the full skipped list is at the bottom);
 * - `case` (legal) has no class (owner ruling) and no entry; its Zotero
 *   fields are exactly the pool's case orphans, so nothing is lost.
 *
 * Judgment calls (kept classes without an exact Zotero counterpart):
 * - `song` ← Zotero `audioRecording` (a song is a recorded audio work:
 *   album = seriesTitle, plus label/runningTime/volume);
 * - `tv_series` ← Zotero `tvBroadcast` (a series entry carries programTitle,
 *   network, episodeNumber, runningTime);
 * - `conference` ← the UNION of `conferencePaper` + `presentation`
 *   (proceedingsTitle/eventPlace/pages/issn from the paper side, meetingName
 *   from the talk side) — a conference entry may cite either shape; the
 *   type-specific keys those two types don't share with a pool property
 *   (conferenceName, presentationType, sessionTitle) stay skipped.
 *
 * Each list is sorted alphabetically and the class keys are sorted for
 * determinism; the domain test pins the table verbatim. Nothing consumes
 * this yet — the server seed + web ensure pick it up in slice 1 task 6
 * (alongside SYSTEM_EXTRA_CLASS_BINDINGS).
 */

import type { SystemClassName, SystemPropertyName } from "./seeds.js";

export const SYSTEM_SOURCE_CLASS_BINDINGS: Partial<
  Record<SystemClassName, readonly SystemPropertyName[]>
> = {
  audio_recording: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "label", "language", "numberOfVolumes", "place", "rights", "runningTime", "seriesTitle", "shortTitle", "volume"],
  artwork: ["abstract", "accessDate", "archive", "archiveLocation", "artworkMedium", "artworkSize", "callNumber", "eventPlace", "extra", "language", "rights", "shortTitle"],
  bill: ["abstract", "accessDate", "code", "codePages", "codeVolume", "extra", "history", "language", "legislativeBody", "rights", "section", "session", "shortTitle"],
  blog_post: ["abstract", "accessDate", "blogTitle", "extra", "issn", "language", "rights", "shortTitle", "websiteType"],
  book: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "extra", "format", "issn", "language", "numPages", "numberOfVolumes", "place", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  book_section: ["abstract", "accessDate", "archive", "archiveLocation", "bookTitle", "callNumber", "edition", "extra", "format", "issn", "language", "numberOfVolumes", "pages", "place", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  computer_program: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "company", "extra", "place", "programmingLanguage", "rights", "seriesTitle", "shortTitle", "system", "versionNumber"],
  // ← conferencePaper + presentation union (see the header note).
  conference: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "eventPlace", "extra", "issn", "issue", "language", "meetingName", "numberOfVolumes", "pages", "place", "proceedingsTitle", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  conference_paper: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "eventPlace", "extra", "issn", "issue", "language", "numberOfVolumes", "pages", "place", "proceedingsTitle", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  dataset: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "format", "identifier", "language", "repository", "repositoryLocation", "rights", "shortTitle", "versionNumber", "workType"],
  dictionary_entry: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "extra", "language", "numberOfVolumes", "pages", "place", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  document: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "language", "place", "rights", "shortTitle", "workType"],
  email: ["abstract", "accessDate", "extra", "language", "rights", "shortTitle"],
  encyclopedia_article: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "extra", "language", "numberOfVolumes", "pages", "place", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  film: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "distributor", "extra", "genre", "language", "place", "rights", "runningTime", "shortTitle"],
  forum_post: ["abstract", "accessDate", "extra", "forumTitle", "language", "postType", "rights", "shortTitle"],
  hearing: ["abstract", "accessDate", "committee", "documentNumber", "extra", "history", "language", "legislativeBody", "numberOfVolumes", "pages", "place", "rights", "session", "shortTitle"],
  instant_message: ["abstract", "accessDate", "extra", "language", "rights", "shortTitle"],
  interview: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "interviewMedium", "language", "place", "rights", "shortTitle"],
  journal_article: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "issn", "issue", "language", "pages", "place", "publicationTitle", "rights", "section", "series", "seriesTitle", "shortTitle", "volume"],
  letter: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "eventPlace", "extra", "language", "letterType", "rights", "shortTitle"],
  magazine_article: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "issn", "issue", "language", "pages", "place", "publicationTitle", "rights", "shortTitle", "volume"],
  manuscript: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "institution", "language", "numPages", "number", "place", "rights", "shortTitle"],
  map: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "extra", "language", "place", "rights", "scale", "seriesTitle", "shortTitle"],
  newspaper_article: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "extra", "issn", "issue", "language", "pages", "place", "publicationTitle", "rights", "section", "shortTitle", "volume"],
  patent: ["abstract", "accessDate", "applicationNumber", "assignee", "extra", "filingDate", "issueDate", "issuingAuthority", "language", "legalStatus", "pages", "patentNumber", "place", "priorityDate", "priorityNumbers", "references", "rights", "shortTitle"],
  podcast: ["abstract", "accessDate", "episodeNumber", "extra", "language", "place", "rights", "runningTime", "seriesTitle", "shortTitle"],
  preprint: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "genre", "language", "place", "repository", "rights", "series", "seriesNumber", "shortTitle"],
  presentation: ["abstract", "accessDate", "extra", "language", "meetingName", "place", "rights", "series", "shortTitle"],
  radio_broadcast: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "episodeNumber", "extra", "language", "network", "place", "programTitle", "rights", "runningTime", "shortTitle"],
  report: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "institution", "issn", "language", "pages", "place", "reportNumber", "reportType", "rights", "seriesNumber", "seriesTitle", "shortTitle"],
  // ← audioRecording (see the header note).
  song: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "label", "language", "numberOfVolumes", "place", "rights", "runningTime", "seriesTitle", "shortTitle", "volume"],
  standard: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "committee", "edition", "extra", "language", "numPages", "number", "place", "rights", "shortTitle", "status", "versionNumber", "workType"],
  statute: ["abstract", "accessDate", "code", "codeNumber", "dateEnacted", "extra", "history", "language", "nameOfAct", "pages", "publicLawNumber", "rights", "section", "session", "shortTitle"],
  thesis: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "issn", "language", "numPages", "place", "rights", "series", "seriesNumber", "shortTitle", "thesisType", "university"],
  tv_broadcast: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "episodeNumber", "extra", "language", "network", "place", "programTitle", "rights", "runningTime", "shortTitle"],
  // ← tvBroadcast (see the header note).
  tv_series: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "episodeNumber", "extra", "language", "network", "place", "programTitle", "rights", "runningTime", "shortTitle"],
  video_recording: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "language", "numberOfVolumes", "place", "rights", "runningTime", "seriesTitle", "shortTitle", "studio", "volume"],
  web_page: ["abstract", "accessDate", "extra", "language", "place", "rights", "shortTitle", "websiteTitle", "websiteType"],
};

/**
 * Zotero fields with NO pool property, skipped at derivation (owner ruling —
 * property drift is never answered with reserved-schema machinery):
 * `libraryCatalog` (26 types), `audioRecordingFormat` (audio_recording,
 * radio_broadcast, song — the pool's `medium` stays unmatched in this schema
 * snapshot, the recorded task-4 deviation), `videoRecordingFormat` (film,
 * tv_broadcast, tv_series, video_recording), `originalDate`/
 * `originalPublisher`/`originalPlace` (book, book_section), `conferenceName`
 * (conference, conference_paper), `presentationType`/`sessionTitle`
 * (conference, presentation), `dictionaryTitle` (dictionary_entry),
 * `encyclopediaTitle` (encyclopedia_article), `manuscriptType` (manuscript),
 * `mapType` (map), `organization` (standard), `billNumber` (bill),
 * `subject` (email — Zotero's subject IS the title), `country` (patent),
 * `audioFileType` (podcast), `archiveID` (preprint), `partNumber`/
 * `partTitle` (journal_article, standard), `seriesText`/
 * `journalAbbreviation`/`PMID`/`PMCID` (journal_article), and the case-type
 * orphans (`caseName`/`court`/`docketNumber`/`reporter`/`reporterVolume`/
 * `firstPage`/`dateDecided` — `case` has no class, owner ruling).
 */
