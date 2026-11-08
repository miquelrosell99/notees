/**
 * The tab-relay capture path's graph side: a captured web page becomes a
 * `web_page`-classed node (title + `url` + `accessDate`), stamped through
 * the SAME classed-create pipeline the add-source dialog runs
 * (stagedEntriesOfValues + flushClassedCreate — citation self-heal,
 * auto-citekey, one undo batch, the normal outbox push sealed by the sync
 * engine when the workspace is keyed). Idempotent by URL: an existing
 * `web_page` carrying the same `url` value is reused, never duplicated
 * (the duplicate re-capture answers the FIRST node). Readlater mode adds
 * the node to the workspace's "Read later" collection — created on first
 * use (a `collection`-classed node, op-log state like everything else).
 *
 * Cache-coherent find-or-create: every decision read below rides the
 * clients' *Fresh (uncached) read surface, never the WorkerClient's
 * eventually-consistent render cache — a cold or dirty cache key answers
 * the empty default synchronously, which through the cached reads used to
 * duplicate web_page nodes for URLs already in the store, mint a second
 * "Read later" collection, and re-stamp the seed deploy's envelopes on a
 * cold boot (then journaled, so undoing a capture could invert no-op
 * deploy ops). And the captures serialize through a per-client
 * single-flight queue: two interleaved same-URL captures both pass a
 * find-or-create read taken before either writes, so the dedupe alone
 * cannot race — the second capture's reads land after the first's writes.
 *
 * Fresh-workspace self-heal: the flush's staged pipeline derives a staged
 * row's kind from the schema registry (accessDate must stage as a DATE or
 * the datetime write is lawless — the flush's kind re-derivation reads the
 * registry fresh for the same reason), and the citation self-heal inside
 * the flush only runs for a class whose lineage reaches `source`. A
 * workspace that never received the server seed (offline-first device,
 * pre-seed workspace) has neither — so the capture deploys the `web_page`
 * seed class first (deploySystemClass: ancestors, the class node, the
 * extends edge, the property family — the offline-first twin of the server
 * seed, idempotent by construction, a complete no-op on a seeded
 * workspace, every guard read fresh).
 */

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { AnyClient } from "../../features/sidebar/FavoritesRecents.js";
import { deploySystemClass } from "../classview/systemClassDeploy.js";
import {
  flushClassedCreate,
  stagedEntriesOfValues,
} from "../modals/quickCreate.js";

export interface CapturePayload {
  url: string;
  title: string;
  mode: "source" | "readlater";
  note?: string | undefined;
}

/** The "Read later" collection's find-or-create title. */
export const READ_LATER_TITLE = "Read later";

/** Trim + lowercase — the duplicate-URL comparison (host/scheme tolerant enough for v1). */
function normalizeUrl(url: string): string {
  return url.trim().toLowerCase();
}

/**
 * Local `YYYY-MM-DD` for a moment — the journal-day law (the
 * todayIsoLocal idiom in calendarViewUtils: always LOCAL midnight, never
 * a UTC `.slice`): a capture near midnight must stamp the day the USER
 * accessed the page, and ensureDateChain journals that local day.
 */
function localIsoDateOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * The URL-dedupe lookup, over FRESH reads: every `web_page` member's url
 * row straight from the store. Never the render cache — a cold key's []
 * here mints a duplicate for a URL the store already carries (synced down
 * or captured in another tab).
 */
async function existingWebPageForUrl(
  client: AnyClient,
  url: string,
): Promise<string | undefined> {
  const wanted = normalizeUrl(url);
  for (const member of await client.getClassMembersFresh(SYSTEM_CLASS_UUIDS.web_page)) {
    const row = (await client.getEffectivePropertiesFresh(member.id)).find(
      (p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url,
    );
    if (row !== undefined && typeof row.value === "string" && normalizeUrl(row.value) === wanted) {
      return member.id;
    }
  }
  return undefined;
}

/** The "Read later" find-or-create lookup, over FRESH reads (same law). */
async function findReadLaterCollection(client: AnyClient): Promise<string | undefined> {
  for (const member of await client.getClassMembersFresh(SYSTEM_CLASS_UUIDS.collection)) {
    const title = (await client.getDisplayNameFresh(member.id)) ?? member.name ?? "";
    if (title.trim().toLowerCase() === READ_LATER_TITLE.toLowerCase()) return member.id;
  }
  return undefined;
}

/**
 * The per-client single-flight queue: every capture runs chained behind
 * the previous one, so a find-or-create read inside one capture can never
 * race another capture's writes (two interleaved same-URL captures both
 * pass a dedupe read taken before either writes — serialization is what
 * makes the dedupe sound). Keyed on nothing on purpose: one queue per
 * client, the simplest lawful form; a rejected capture must not strand
 * the queue, so the next one runs regardless.
 */
const captureChains = new WeakMap<AnyClient, Promise<unknown>>();

/**
 * Capture one web page into the workspace graph; resolves to the node's id
 * (existing on a URL re-capture, else freshly created).
 */
export async function captureWebPage(
  client: AnyClient,
  payload: CapturePayload,
  now: Date = new Date(),
): Promise<string> {
  const previous = captureChains.get(client) ?? Promise.resolve();
  const queued = previous.then(() => captureOnce(client, payload, now), () => captureOnce(client, payload, now));
  captureChains.set(client, queued);
  return queued;
}

async function captureOnce(
  client: AnyClient,
  payload: CapturePayload,
  now: Date,
): Promise<string> {
  const existing = await existingWebPageForUrl(client, payload.url);
  const id =
    existing ??
    (await (async () => {
      // The fresh/offline-workspace self-heal (no-op once seeded): the
      // staged pipeline below derives the accessDate row as a DATE from
      // the schema registry, which the deploy authors at the seed id.
      await deploySystemClass(client, "web_page");
      const result = await flushClassedCreate(client, {
        classId: SYSTEM_CLASS_UUIDS.web_page,
        title: payload.title.trim() === "" ? payload.url : payload.title.trim(),
        entries: stagedEntriesOfValues(client, {
          [SYSTEM_PROPERTY_UUIDS.url]: payload.url.trim(),
          // Day precision (YYYY-MM-DD) — the parse the staged-date expander accepts.
          [SYSTEM_PROPERTY_UUIDS.accessDate]: localIsoDateOf(now),
        }),
      });
      if (!result.ok) throw new Error(`capture failed: ${result.error}`);
      return result.id;
    })());

  if (payload.note !== undefined && payload.note.trim() !== "" && existing === undefined) {
    await client.createObject({
      isEmbedded: false,
      parentId: id,
      contentAst: [{ type: "text", text: payload.note.trim() }],
    });
  }

  if (payload.mode === "readlater") {
    let collection = await findReadLaterCollection(client);
    if (collection === undefined) {
      collection = await client.createObject({
        isEmbedded: false,
        name: READ_LATER_TITLE,
        classIds: [SYSTEM_CLASS_UUIDS.collection],
      });
    }
    // OR-Set add-wins: a redundant re-add converges to "member".
    await client.addCollectionMember(collection, id);
  }

  return id;
}
