/**
 * System relation schemas — fixed seed UUIDs (RELATIONS.md §0).
 *
 * These ids are HARD CODED and must never be generated or renamed: relation
 * rows, canonical fixtures, and the old-data migration script all bake them
 * in. Precedent: SYSTEM_CLASS_UUIDS in app/domain/entities/constants.py.
 */

export interface RelationSchemaSeed {
  readonly id: string;
  readonly name: string;
  readonly inverseName: string;
  /** Class filter for the source side; "any" disables filtering. */
  readonly sourceFilter: string;
  readonly targetFilter: string;
}

export const RELATION_SCHEMA_SEEDS = [
  {
    id: "00000000-0000-0000-0004-000000000001",
    name: "authored-by",
    inverseName: "author-of",
    sourceFilter: "any",
    targetFilter: "agent",
  },
  {
    id: "00000000-0000-0000-0004-000000000002",
    name: "published-by",
    inverseName: "publisher-of",
    sourceFilter: "source",
    targetFilter: "organization",
  },
  {
    id: "00000000-0000-0000-0004-000000000003",
    name: "edition-of",
    inverseName: "has-edition",
    sourceFilter: "any",
    targetFilter: "any",
  },
  {
    id: "00000000-0000-0000-0004-000000000004",
    name: "cites",
    inverseName: "cited-by",
    sourceFilter: "any",
    targetFilter: "source",
  },
  {
    id: "00000000-0000-0000-0004-000000000005",
    name: "related-to",
    inverseName: "related-to",
    sourceFilter: "any",
    targetFilter: "any",
  },
  {
    id: "00000000-0000-0000-0004-000000000006",
    name: "has-asset",
    inverseName: "asset-of",
    sourceFilter: "any",
    targetFilter: "asset",
  },
  {
    id: "00000000-0000-0000-0004-000000000007",
    name: "annotates",
    inverseName: "annotated-by",
    sourceFilter: "annotation",
    targetFilter: "asset",
  },
  {
    id: "00000000-0000-0000-0004-000000000008",
    name: "member-of",
    inverseName: "has-member",
    sourceFilter: "any",
    targetFilter: "collection",
  },
  {
    id: "00000000-0000-0000-0004-000000000009",
    name: "about",
    inverseName: "has-note",
    sourceFilter: "note",
    targetFilter: "any",
  },
  {
    id: "00000000-0000-0000-0004-00000000000a",
    name: "mentions",
    inverseName: "mentioned-in",
    sourceFilter: "any",
    targetFilter: "any",
  },
] as const satisfies readonly RelationSchemaSeed[];

export type RelationSchemaSeedName = (typeof RELATION_SCHEMA_SEEDS)[number]["name"];

const BY_NAME = new Map<string, RelationSchemaSeed>(
  RELATION_SCHEMA_SEEDS.map((s) => [s.name, s]),
);

const BY_ID = new Map<string, RelationSchemaSeed>(
  RELATION_SCHEMA_SEEDS.map((s) => [s.id, s]),
);

export function relationSchemaByName(name: string): RelationSchemaSeed | undefined {
  return BY_NAME.get(name);
}

export function relationSchemaById(id: string): RelationSchemaSeed | undefined {
  return BY_ID.get(id);
}

export function isSeedRelationSchemaId(id: string): boolean {
  return BY_ID.has(id);
}
