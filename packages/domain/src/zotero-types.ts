/**
 * Zotero item-type manifest — the typed mapping from Zotero's citable item
 * types (`zotero/zotero-schema`, `itemTypes`) to Notees source system
 * classes. Later source-library slices consume this verbatim (the slice-4
 * resolver imports it, nothing hand-maintains a second copy).
 *
 * The 37 citable types map 1:1 onto the source-library roster; Zotero's
 * three internal types (annotation, attachment, note) are NOT citable and
 * carry no entry. `case` (legal) has NO Notees class (owner ruling — dropped
 * from the roster): it maps to `document` here, documenting the fallback.
 * The class-level "a legal case should surface the `document` class"
 * resolver logic is slice 4; this manifest only records the mapping.
 */

import type { SystemClassName } from "./seeds.js";

export const ZOTERO_CITABLE_ITEM_TYPES = [
  "artwork",
  "audioRecording",
  "bill",
  "blogPost",
  "book",
  "bookSection",
  "case",
  "computerProgram",
  "conferencePaper",
  "dataset",
  "dictionaryEntry",
  "document",
  "email",
  "encyclopediaArticle",
  "film",
  "forumPost",
  "hearing",
  "instantMessage",
  "interview",
  "journalArticle",
  "letter",
  "magazineArticle",
  "manuscript",
  "map",
  "newspaperArticle",
  "patent",
  "podcast",
  "preprint",
  "presentation",
  "radioBroadcast",
  "report",
  "standard",
  "statute",
  "thesis",
  "tvBroadcast",
  "videoRecording",
  "webpage",
] as const;

export type ZoteroItemType = (typeof ZOTERO_CITABLE_ITEM_TYPES)[number];

export const ZOTERO_ITEM_TYPE_TO_CLASS: Record<ZoteroItemType, SystemClassName> = {
  artwork: "artwork",
  audioRecording: "audio_recording",
  bill: "bill",
  blogPost: "blog_post",
  book: "book",
  bookSection: "book_section",
  // No `case` class (owner ruling) — falls back to `document`.
  case: "document",
  computerProgram: "computer_program",
  conferencePaper: "conference_paper",
  dataset: "dataset",
  dictionaryEntry: "dictionary_entry",
  document: "document",
  email: "email",
  encyclopediaArticle: "encyclopedia_article",
  film: "film",
  forumPost: "forum_post",
  hearing: "hearing",
  instantMessage: "instant_message",
  interview: "interview",
  journalArticle: "journal_article",
  letter: "letter",
  magazineArticle: "magazine_article",
  manuscript: "manuscript",
  map: "map",
  newspaperArticle: "newspaper_article",
  patent: "patent",
  podcast: "podcast",
  preprint: "preprint",
  presentation: "presentation",
  radioBroadcast: "radio_broadcast",
  report: "report",
  standard: "standard",
  statute: "statute",
  thesis: "thesis",
  tvBroadcast: "tv_broadcast",
  videoRecording: "video_recording",
  webpage: "web_page",
};
