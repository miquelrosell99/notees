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
 * Fresh-workspace self-heal: the flush's staged pipeline derives a staged
 * row's kind from the schema registry (accessDate must stage as a DATE or
 * the datetime write is lawless), and the citation self-heal inside the
 * flush only runs for a class whose lineage reaches `source`. A workspace
 * that never received the server seed (offline-first device, pre-seed
 * workspace) has neither — so the capture deploys the `web_page` seed
 * class first (deploySystemClass: ancestors, the class node, the extends
 * edge, the property family — the offline-first twin of the server seed,
 * idempotent by construction, a complete no-op on a seeded workspace).
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

function existingWebPageForUrl(client: AnyClient, url: string): string | undefined {
  const wanted = normalizeUrl(url);
  for (const member of client.getClassMembers(SYSTEM_CLASS_UUIDS.web_page)) {
    const row = client
      .getEffectiveProperties(member.id)
      .find((p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url);
    if (row !== undefined && typeof row.value === "string" && normalizeUrl(row.value) === wanted) {
      return member.id;
    }
  }
  return undefined;
}

function findReadLaterCollection(client: AnyClient): string | undefined {
  for (const member of client.getClassMembers(SYSTEM_CLASS_UUIDS.collection)) {
    const title =
      client.getDisplayName(member.id) ?? member.name ?? "";
    if (title.trim().toLowerCase() === READ_LATER_TITLE.toLowerCase()) return member.id;
  }
  return undefined;
}

/**
 * Capture one web page into the workspace graph; resolves to the node's id
 * (existing on a URL re-capture, else freshly created).
 */
export async function captureWebPage(
  client: AnyClient,
  payload: CapturePayload,
  now: Date = new Date(),
): Promise<string> {
  const existing = existingWebPageForUrl(client, payload.url);
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
    let collection = findReadLaterCollection(client);
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
