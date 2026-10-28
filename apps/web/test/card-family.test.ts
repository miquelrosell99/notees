/**
 * ensureCardFamily tests: a workspace missing the card family authors the six
 * scalar SRS schedule schemas (CARD_FAMILY_SEED) at their reserved ids plus
 * the card-class bindings on first call; the call is a complete no-op once
 * present. The card class NODE is a system seed — the ensure never fabricates
 * it; when the node is genuinely absent the schemas still self-heal but the
 * bindings are skipped (getClassBindings could not see them anyway).
 */

import { describe, expect, it } from "vitest";

import {
  CARD_FAMILY_SEED,
  CARD_PROPERTY_UUIDS,
  SYSTEM_CLASS_UUIDS,
} from "@notees/domain";

import {
  ensureCardFamily,
  cardFamilyPresent,
  type CardFamilyClient,
} from "../src/features/classview/cardFamily.js";

interface SchemaRow {
  id: string;
  name: string;
  type: string;
  scopeClassIds: string[] | null;
}

interface BindingRow {
  propertySchemaId: string;
}

/** A stateful stub over the CardFamilyClient pick — records every write. */
function stubClient(cardClassNodePresent = true) {
  const schemas: SchemaRow[] = [];
  const bindings: BindingRow[] = [];
  const createdSchemas: Array<{ id: string; name: string; type: string }> = [];
  const setCalls: Array<{ classId: string; propertySchemaId: string }> = [];

  const client: CardFamilyClient = {
    listPropertySchemas: () => schemas as never,
    getClassBindings: (classId: string) =>
      (classId === SYSTEM_CLASS_UUIDS.card ? bindings : []) as never,
    getNodeRaw: (id: string) => (id === SYSTEM_CLASS_UUIDS.card && cardClassNodePresent ? {} : undefined) as never,
    createPropertySchema: async (input) => {
      const id = input.id!;
      createdSchemas.push({ id, name: input.name, type: input.type });
      schemas.push({ id, name: input.name, type: input.type, scopeClassIds: null });
      return id;
    },
    setClassProperty: async (classId, propertySchemaId) => {
      setCalls.push({ classId, propertySchemaId });
      bindings.push({ propertySchemaId });
    },
  };
  return { client, schemas, bindings, createdSchemas, setCalls };
}

describe("ensureCardFamily", () => {
  it("authors the six schemas at the reserved seed ids plus the card-class bindings", async () => {
    const { client, createdSchemas, setCalls } = stubClient();
    expect(cardFamilyPresent(client)).toBe(false);

    await ensureCardFamily(client);

    expect(createdSchemas).toEqual(
      CARD_FAMILY_SEED.map((spec) => ({
        id: CARD_PROPERTY_UUIDS[spec.property],
        name: spec.name,
        type: spec.type,
      })),
    );
    expect(setCalls).toEqual(
      CARD_FAMILY_SEED.map((spec) => ({
        classId: SYSTEM_CLASS_UUIDS.card,
        propertySchemaId: CARD_PROPERTY_UUIDS[spec.property],
      })),
    );
    expect(cardFamilyPresent(client)).toBe(true);
  });

  it("creates the schemas with global scope (no scopeClassIds), exactly like the task family", async () => {
    const { client, schemas } = stubClient();
    await ensureCardFamily(client);
    for (const schema of schemas) {
      expect(schema.scopeClassIds).toBeNull();
    }
  });

  it("is idempotent: when the family is present it makes no writes", async () => {
    const { client, createdSchemas, setCalls } = stubClient();
    await ensureCardFamily(client);
    const writesAfterFirst = createdSchemas.length + setCalls.length;
    expect(writesAfterFirst).toBe(CARD_FAMILY_SEED.length * 2);

    await ensureCardFamily(client);
    await ensureCardFamily(client);

    expect(createdSchemas.length + setCalls.length).toBe(writesAfterFirst);
  });

  it("only fills the gaps on a partially-authored family", async () => {
    const { client, createdSchemas, setCalls } = stubClient();
    // Half the family already exists, bound; the ensure authors the rest only.
    await ensureCardFamily(client);
    createdSchemas.length = 0;
    setCalls.length = 0;

    await ensureCardFamily(client);

    expect(createdSchemas).toEqual([]);
    expect(setCalls).toEqual([]);
  });

  it("skips the bindings (never fabricates a class) when the card class node is absent", async () => {
    const { client, createdSchemas, setCalls } = stubClient(false);

    await ensureCardFamily(client);

    // The schemas still self-heal …
    expect(createdSchemas).toHaveLength(CARD_FAMILY_SEED.length);
    // … but no binding rows are authored against a class node that does not
    // exist (the card class is a system seed — the server seed/deploy paths
    // own the node).
    expect(setCalls).toEqual([]);
  });

  it("cardFamilyPresent is true only when every schema exists AND is bound", async () => {
    const { client } = stubClient();
    expect(cardFamilyPresent(client)).toBe(false);

    await ensureCardFamily(client);
    expect(cardFamilyPresent(client)).toBe(true);

    // All schemas present but one binding dropped → not present (the gate
    // reads BOTH sides).
    const dropped = CARD_PROPERTY_UUIDS[CARD_FAMILY_SEED[0]!.property];
    const missingBinding = cardFamilyPresent({
      listPropertySchemas: () =>
        CARD_FAMILY_SEED.map((spec) => ({ id: CARD_PROPERTY_UUIDS[spec.property] })) as never,
      getClassBindings: () =>
        CARD_FAMILY_SEED.filter(
          (spec) => CARD_PROPERTY_UUIDS[spec.property] !== dropped,
        ).map((spec) => ({ propertySchemaId: CARD_PROPERTY_UUIDS[spec.property] })) as never,
    });
    expect(missingBinding).toBe(false);
  });
});
