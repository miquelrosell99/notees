import { describe, expect, it } from "vitest";
import {
  SYSTEM_CLASS_UUIDS,
  ZOTERO_CITABLE_ITEM_TYPES,
  ZOTERO_ITEM_TYPE_TO_CLASS,
  type ZoteroItemType,
} from "../src/index.js";

// The 37 citable item types of `zotero/zotero-schema` (the schema's
// `itemTypes` minus the three internal types annotation/attachment/note).
// A future Zotero type addition must force a conscious map decision here —
// totality is asserted against this list, not against the manifest itself.
const CITABLE_TYPES = [
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

describe("ZOTERO_ITEM_TYPE_TO_CLASS", () => {
  it("covers exactly the 37 citable Zotero item types", () => {
    expect(ZOTERO_CITABLE_ITEM_TYPES).toEqual(CITABLE_TYPES);
    expect(ZOTERO_CITABLE_ITEM_TYPES).toHaveLength(37);
    const keys = Object.keys(ZOTERO_ITEM_TYPE_TO_CLASS);
    expect(keys.sort()).toEqual([...CITABLE_TYPES].sort());
  });

  it("maps every type to a seeded system class", () => {
    for (const type of CITABLE_TYPES) {
      expect(SYSTEM_CLASS_UUIDS).toHaveProperty(ZOTERO_ITEM_TYPE_TO_CLASS[type]);
    }
  });

  it("maps the source-library roster keys verbatim", () => {
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.journalArticle).toBe("journal_article");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.bookSection).toBe("book_section");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.conferencePaper).toBe("conference_paper");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.preprint).toBe("preprint");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.webpage).toBe("web_page");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.audioRecording).toBe("audio_recording");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.tvBroadcast).toBe("tv_broadcast");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.film).toBe("film");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.thesis).toBe("thesis");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.dictionaryEntry).toBe("dictionary_entry");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.encyclopediaArticle).toBe("encyclopedia_article");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.magazineArticle).toBe("magazine_article");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.newspaperArticle).toBe("newspaper_article");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.computerProgram).toBe("computer_program");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.instantMessage).toBe("instant_message");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.blogPost).toBe("blog_post");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.forumPost).toBe("forum_post");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.radioBroadcast).toBe("radio_broadcast");
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.videoRecording).toBe("video_recording");
  });

  it("falls back to `document` for `case` (no case class — owner ruling)", () => {
    expect(ZOTERO_ITEM_TYPE_TO_CLASS.case).toBe("document");
  });
});

// Compile-time totality: every citable literal is a ZoteroItemType.
const _totality: readonly ZoteroItemType[] = CITABLE_TYPES;
void _totality;
