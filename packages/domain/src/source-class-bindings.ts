/**
 * Per-class source field bindings (source-library slice 1 task 5; the
 * 2026-11-02 full-alignment slice emptied the skip list): each source
 * type-class → its Zotero field list, as pool property names. Derived
 * mechanically from `zotero/zotero-schema` (`itemTypes[].fields`, the
 * task-snapshot schema JSON):
 *
 * - every field of the class's Zotero item type maps to its pool key
 *   (camelCase identity; the renames are `abstractNote`→abstract,
 *   `type`→workType, `ISSN`→issn);
 * - EXCLUDED everywhere: `title` (title-is-content), `citationKey`
 *   (citekey), and the fields riding the source base via
 *   SYSTEM_PROPERTY_SPECS `bindTo: "source"` — the creator family
 *   (authors/linkedAuthors/editors), doi, isbn, publicationDate (Zotero
 *   `date`), publisher, url, attachments, pmid, pmcid — never repeated
 *   per class;
 * - NOTHING else is skipped: the 31 pool properties the full-alignment
 *   slice added (pmcid…dateDecided) bind every remaining Zotero field —
 *   including the legal-case set (caseName/court/docketNumber/reporter/
 *   reporterVolume/firstPage/dateDecided) on `document`, Zotero's `case`
 *   having no class of its own (the ZOTERO_ITEM_TYPE_TO_CLASS fallback).
 *
 * Judgment calls (kept classes without an exact Zotero counterpart):
 * - `song` ← Zotero `audioRecording` (a song is a recorded audio work:
 *   album = seriesTitle, plus label/runningTime/volume);
 * - `tv_series` ← Zotero `tvBroadcast` (a series entry carries programTitle,
 *   network, episodeNumber, runningTime);
 * - `conference` ← the UNION of `conferencePaper` + `presentation`
 *   (proceedingsTitle/eventPlace/pages/issn from the paper side,
 *   meetingName/presentationType/sessionTitle from the talk side, and
 *   conferenceName/libraryCatalog wherever the union's types carry them).
 *
 * Each list is sorted alphabetically (UTF-16 code-unit order, as
 * `Array.prototype.sort` — capital letters rank before lowercase, so
 * `archiveID` precedes `archiveLocation` and `numPages` precedes
 * `numberOfVolumes`); the class keys follow the system-class roster
 * order (audio_recording, artwork, … — NOT alphabetical), pinned
 * verbatim by the domain test. The server seed + web ensure pick it up
 * alongside SYSTEM_EXTRA_CLASS_BINDINGS.
 */

import type { SystemClassName, SystemPropertyName } from "./seeds.js";

/**
 * One source-class binding entry: a bare property name (every entry today),
 * or a ref carrying the binding row's tier flag — `pinned` (additive
 * 2026-10-27, see `SystemPropertySpec.pinned`: pinned properties render
 * first, alphabetical within each tier). Wiring only: no entry pins
 * anything yet.
 */
export type SystemSourceBindingRef = SystemPropertyName | { property: SystemPropertyName; pinned?: boolean };

/** The bound property name of one binding entry (bare name or ref). */
export function sourceBindingPropertyOf(ref: SystemSourceBindingRef): SystemPropertyName {
  return typeof ref === "string" ? ref : ref.property;
}

export const SYSTEM_SOURCE_CLASS_BINDINGS: Partial<
  Record<SystemClassName, readonly SystemSourceBindingRef[]>
> = {
  audio_recording: ["abstract", "accessDate", "archive", "archiveLocation", "audioRecordingFormat", "callNumber", "extra", "label", "language", "libraryCatalog", "numberOfVolumes", "place", "rights", "runningTime", "seriesTitle", "shortTitle", "volume"],
  artwork: ["abstract", "accessDate", "archive", "archiveLocation", "artworkMedium", "artworkSize", "callNumber", "eventPlace", "extra", "language", "libraryCatalog", "rights", "shortTitle"],
  bill: ["abstract", "accessDate", "billNumber", "code", "codePages", "codeVolume", "extra", "history", "language", "legislativeBody", "rights", "section", "session", "shortTitle"],
  blog_post: ["abstract", "accessDate", "blogTitle", "extra", "issn", "language", "rights", "shortTitle", "websiteType"],
  book: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "extra", "format", "issn", "language", "libraryCatalog", "numPages", "numberOfVolumes", "originalDate", "originalPlace", "originalPublisher", "place", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  book_section: ["abstract", "accessDate", "archive", "archiveLocation", "bookTitle", "callNumber", "edition", "extra", "format", "issn", "language", "libraryCatalog", "numberOfVolumes", "originalDate", "originalPlace", "originalPublisher", "pages", "place", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  computer_program: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "company", "extra", "libraryCatalog", "place", "programmingLanguage", "rights", "seriesTitle", "shortTitle", "system", "versionNumber"],
  // ← conferencePaper + presentation union (see the header note).
  conference: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "conferenceName", "eventPlace", "extra", "issn", "issue", "language", "libraryCatalog", "meetingName", "numberOfVolumes", "pages", "place", "presentationType", "proceedingsTitle", "rights", "series", "seriesNumber", "sessionTitle", "shortTitle", "volume"],
  conference_paper: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "conferenceName", "eventPlace", "extra", "issn", "issue", "language", "libraryCatalog", "numberOfVolumes", "pages", "place", "proceedingsTitle", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  dataset: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "format", "identifier", "language", "libraryCatalog", "repository", "repositoryLocation", "rights", "shortTitle", "versionNumber", "workType"],
  dictionary_entry: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "dictionaryTitle", "edition", "extra", "language", "libraryCatalog", "numberOfVolumes", "pages", "place", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  // ← Zotero `case` rides the document fallback (the legal-case set).
  document: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "caseName", "court", "dateDecided", "docketNumber", "extra", "firstPage", "language", "libraryCatalog", "place", "reporter", "reporterVolume", "rights", "shortTitle", "workType"],
  email: ["abstract", "accessDate", "extra", "language", "rights", "shortTitle", "subject"],
  encyclopedia_article: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "encyclopediaTitle", "extra", "language", "libraryCatalog", "numberOfVolumes", "pages", "place", "rights", "series", "seriesNumber", "shortTitle", "volume"],
  film: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "distributor", "extra", "genre", "language", "libraryCatalog", "place", "rights", "runningTime", "shortTitle", "videoRecordingFormat"],
  forum_post: ["abstract", "accessDate", "extra", "forumTitle", "language", "postType", "rights", "shortTitle"],
  hearing: ["abstract", "accessDate", "committee", "documentNumber", "extra", "history", "language", "legislativeBody", "numberOfVolumes", "pages", "place", "rights", "session", "shortTitle"],
  instant_message: ["abstract", "accessDate", "extra", "language", "rights", "shortTitle"],
  interview: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "interviewMedium", "language", "libraryCatalog", "place", "rights", "shortTitle"],
  journal_article: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "issn", "issue", "journalAbbreviation", "language", "libraryCatalog", "pages", "partNumber", "partTitle", "place", "publicationTitle", "rights", "section", "series", "seriesText", "seriesTitle", "shortTitle", "volume"],
  letter: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "eventPlace", "extra", "language", "letterType", "libraryCatalog", "rights", "shortTitle"],
  magazine_article: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "issn", "issue", "language", "libraryCatalog", "pages", "place", "publicationTitle", "rights", "shortTitle", "volume"],
  manuscript: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "institution", "language", "libraryCatalog", "manuscriptType", "numPages", "number", "place", "rights", "shortTitle"],
  map: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "extra", "language", "libraryCatalog", "mapType", "place", "rights", "scale", "seriesTitle", "shortTitle"],
  newspaper_article: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "edition", "extra", "issn", "issue", "language", "libraryCatalog", "pages", "place", "publicationTitle", "rights", "section", "shortTitle", "volume"],
  patent: ["abstract", "accessDate", "applicationNumber", "assignee", "country", "extra", "filingDate", "issueDate", "issuingAuthority", "language", "legalStatus", "pages", "patentNumber", "place", "priorityDate", "priorityNumbers", "references", "rights", "shortTitle"],
  podcast: ["abstract", "accessDate", "audioFileType", "episodeNumber", "extra", "language", "place", "rights", "runningTime", "seriesTitle", "shortTitle"],
  preprint: ["abstract", "accessDate", "archive", "archiveID", "archiveLocation", "callNumber", "extra", "genre", "language", "libraryCatalog", "place", "repository", "rights", "series", "seriesNumber", "shortTitle"],
  presentation: ["abstract", "accessDate", "extra", "language", "meetingName", "place", "presentationType", "rights", "series", "sessionTitle", "shortTitle"],
  radio_broadcast: ["abstract", "accessDate", "archive", "archiveLocation", "audioRecordingFormat", "callNumber", "episodeNumber", "extra", "language", "libraryCatalog", "network", "place", "programTitle", "rights", "runningTime", "shortTitle"],
  report: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "institution", "issn", "language", "libraryCatalog", "pages", "place", "reportNumber", "reportType", "rights", "seriesNumber", "seriesTitle", "shortTitle"],
  // ← audioRecording (see the header note).
  song: ["abstract", "accessDate", "archive", "archiveLocation", "audioRecordingFormat", "callNumber", "extra", "label", "language", "libraryCatalog", "numberOfVolumes", "place", "rights", "runningTime", "seriesTitle", "shortTitle", "volume"],
  standard: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "committee", "edition", "extra", "language", "libraryCatalog", "numPages", "number", "organization", "partNumber", "partTitle", "place", "rights", "shortTitle", "status", "versionNumber", "workType"],
  statute: ["abstract", "accessDate", "code", "codeNumber", "dateEnacted", "extra", "history", "language", "nameOfAct", "pages", "publicLawNumber", "rights", "section", "session", "shortTitle"],
  thesis: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "issn", "language", "libraryCatalog", "numPages", "place", "rights", "series", "seriesNumber", "shortTitle", "thesisType", "university"],
  tv_broadcast: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "episodeNumber", "extra", "language", "libraryCatalog", "network", "place", "programTitle", "rights", "runningTime", "shortTitle", "videoRecordingFormat"],
  // ← tvBroadcast (see the header note).
  tv_series: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "episodeNumber", "extra", "language", "libraryCatalog", "network", "place", "programTitle", "rights", "runningTime", "shortTitle", "videoRecordingFormat"],
  video_recording: ["abstract", "accessDate", "archive", "archiveLocation", "callNumber", "extra", "language", "libraryCatalog", "numberOfVolumes", "place", "rights", "runningTime", "seriesTitle", "shortTitle", "studio", "videoRecordingFormat", "volume"],
  web_page: ["abstract", "accessDate", "extra", "language", "place", "rights", "shortTitle", "websiteTitle", "websiteType"],
};
