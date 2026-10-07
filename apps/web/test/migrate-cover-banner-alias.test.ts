/**
 * scripts/migrate-cover-banner-alias.mts tests — the retired cover/banner/
 * aliasOf property assertions converge onto the `coverAssetId` /
 * `bannerAssetId` / `aliasedNodeId` wire node fields by appended envelopes
 * (the migrate-system-names precedent; dry-run default at the CLI).
 *
 * The plan reads the visible-set property rows (PG5-suppressed) for the
 * three retired schemas; the field takes the LATEST visible row's target
 * ({nodeId} canonical, bare-uuid defensive, v1 {hash} resolved through the
 * CAS node_asset table); every visible row rides its own unset — an element
 * remove for element-authored rows, a slot unset for legacy positional rows
 * (the deterministic `node:schema:idx` row id is not a uuid). Unresolvable
 * values are skipped untouched so a fixed re-run picks them up.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import {
  buildEnvelopes,
  planMoves,
  validateEnvelopes,
} from "../../../scripts/migrate-cover-banner-alias.mts";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const COVER = "00000000-0000-0000-0000-000000000005";
const BANNER = "00000000-0000-0000-0000-000000000006";
const ALIAS = "00000000-0000-0000-0000-000000000029";
const PAGE = "0192a000-0000-7000-8000-0000000000a1";
const PAGE2 = "0192a000-0000-7000-8000-0000000000a2";
const ASSET = "0192a000-0000-7000-8000-0000000000b1";
const MAIN = "0192a000-0000-7000-8000-0000000000c1";
const HASH =
  "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

function env(opType: string, payload: Record<string, unknown>, physical: number): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-migrate-wire-fields",
    hlc: { physical, logical: 0 },
    opType,
    payload,
  });
}

function makeStore(): Store {
  const store = Store.open(sqljsBackend(sqlModule));
  stores.push(store);
  return store;
}

/**
 * The migration world: a canonical {nodeId} cover + aliasOf on PAGE, a v1
 * {hash} banner on PAGE2 (the hash resolves to ASSET through node_asset),
 * and a garbage cover value on PAGE2 that must be skipped untouched.
 */
function migrateWorld(): Store {
  const store = makeStore();
  store.applyMany([
    env("object.create", { objectId: PAGE, presentAsMain: true }, 1000),
    env("object.create", { objectId: PAGE2, presentAsMain: true }, 1001),
    env("object.create", { objectId: ASSET, presentAsMain: true }, 1002),
    env("object.create", { objectId: MAIN, presentAsMain: true }, 1003),
    env("property.set", { objectId: PAGE, propertySchemaId: COVER, value: { nodeId: ASSET } }, 1004),
    env("property.set", { objectId: PAGE, propertySchemaId: ALIAS, value: { nodeId: MAIN } }, 1005),
    env(
      "asset.attach",
      {
        objectId: ASSET,
        assetId: ASSET,
        hash: HASH,
        mimeType: "image/png",
        size: 3,
        originalName: "x.png",
      },
      1006,
    ),
    env(
      "property.set",
      { objectId: PAGE2, propertySchemaId: BANNER, value: { hash: HASH, filename: "x.png" } },
      1007,
    ),
    env("property.set", { objectId: PAGE2, propertySchemaId: COVER, value: { wat: 1 } }, 1008),
  ]);
  return store;
}

describe("migrate-cover-banner-alias planning", () => {
  it("plans a move per (node, retired schema), resolving {nodeId}, v1 {hash}, and skipping garbage", () => {
    const store = migrateWorld();
    const { moves, skipped } = planMoves(store);

    const byNodeField = new Map(moves.map((move) => [`${move.nodeId}|${move.field}`, move]));
    expect(byNodeField.get(`${PAGE}|coverAssetId`)).toMatchObject({
      schemaId: COVER,
      targetId: ASSET,
      rows: 1,
      // The positional row retires via a SLOT unset (its deterministic id
      // is not a uuid).
      unsets: [{ idx: 0 }],
    });
    expect(byNodeField.get(`${PAGE}|aliasedNodeId`)).toMatchObject({
      schemaId: ALIAS,
      targetId: MAIN,
    });
    // v1-migrated banner: {hash} → the asset node through node_asset.
    expect(byNodeField.get(`${PAGE2}|bannerAssetId`)).toMatchObject({
      schemaId: BANNER,
      targetId: ASSET,
    });

    expect(skipped).toEqual([
      { nodeId: PAGE2, schemaId: COVER, reason: 'unrecognized value shape {"wat":1}' },
    ]);
    store.close();
  });

  it("plans an element remove for element-authored rows", () => {
    const store = migrateWorld();
    const elementId = "0192a000-0000-7000-8000-0000000000e1";
    store.apply(
      env(
        "property.set",
        { objectId: PAGE, propertySchemaId: COVER, value: { nodeId: MAIN }, elementId },
        1009,
      ),
    );
    const { moves } = planMoves(store);
    const cover = moves.find(
      (move) => move.nodeId === PAGE && move.field === "coverAssetId",
    )!;
    // The newer element-authored row WINS the slot; both rows retire (the
    // element remove + the positional slot unset).
    expect(cover.targetId).toBe(MAIN);
    expect(cover.unsets).toContainEqual({ elementId });
    expect(cover.unsets).toContainEqual({ idx: 0 });
    expect(cover.rows).toBe(2);
    store.close();
  });

  it("plans nothing once the assertions are retired (idempotence)", () => {
    const store = migrateWorld();
    const { moves } = planMoves(store);
    const envelopes = buildEnvelopes(WS, moves);
    validateEnvelopes(envelopes);
    for (const envelope of envelopes) store.apply(envelope);

    const second = planMoves(store);
    expect(second.moves).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    store.close();
  });
});

describe("migrate-cover-banner-alias envelopes", () => {
  it("every envelope validates through the protocol gate and converges the derived state", () => {
    const store = migrateWorld();
    const { moves, skipped } = planMoves(store);
    const envelopes = buildEnvelopes(WS, moves);
    validateEnvelopes(envelopes);

    // One object.update + one unset per visible row.
    expect(envelopes.filter((envelope) => envelope.opType === "object.update")).toHaveLength(3);
    expect(envelopes.filter((envelope) => envelope.opType === "property.unset")).toHaveLength(3);
    expect(
      envelopes.map((envelope) => [
        envelope.opType,
        envelope.hlc.logical,
      ]),
    ).toEqual(envelopes.map((envelope, index) => [envelope.opType, index]));

    for (const envelope of envelopes) store.apply(envelope);

    // The wire fields landed…
    expect(store.getNode(PAGE)).toMatchObject({
      cover_asset_id: ASSET,
      aliased_node_id: MAIN,
    });
    expect(store.getNode(PAGE2)).toMatchObject({ banner_asset_id: ASSET });
    // …and the retired assertions retired (only the skipped garbage row
    // survives, untouched).
    const remaining = store.database
      .prepare(
        "SELECT COUNT(*) AS n FROM property_value WHERE property_schema_id IN (?, ?, ?)",
      )
      .get(COVER, BANNER, ALIAS) as { n: number };
    expect(remaining.n).toBe(1);
    expect(skipped).toHaveLength(1);
    store.close();
  });

  it("the gate rejects a malformed plan before anything is written", () => {
    const store = migrateWorld();
    const { moves } = planMoves(store);
    const envelopes = buildEnvelopes(WS, moves);
    const tampered = envelopes.map((envelope) =>
      envelope.opType === "object.update"
        ? { ...envelope, payload: { ...envelope.payload, coverAssetId: "not-a-uuid" } }
        : envelope,
    );
    expect(() => validateEnvelopes(tampered)).toThrow(/refusing to insert/);
    store.close();
  });
});
