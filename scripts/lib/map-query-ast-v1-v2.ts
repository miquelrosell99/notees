/**
 * Pure v1→v2 query-AST mapping — the mechanical half of the query-AST v2
 * migration (`scripts/migrate-query-ast-v2.mts` is the driver).
 *
 * `mapQueryAstV1ToV2` walks a v1 AST (Group / Not / nested-query trees) and
 * returns its v2 image: every v1 condition variant lands on exactly one v2
 * shape per the mapping table — the v1 family hats (`descendantOf` /
 * `descendantOfAny` / `descendantOfQuery` / `descendantOfSelf` /
 * `descendantSet`) become `member` conditions with the family/op/target
 * axes made explicit; `contentSet`, `propertyBetween`, `propertyWithin`,
 * the ten `created*`/`updated*` types, and `isClass`/`isEmbedded` fold into
 * their parameterized v2 types. `not` wrappers, group logic, scope, sort,
 * and aggregation pass through unchanged.
 *
 * Pure data-in/data-out by design: this module imports NOTHING (certainly
 * not the v2 zod schema — the migration feeds it v1 data, and the built
 * protocol dist validates the rewritten envelopes separately). Unknown
 * shapes FAIL LOUD with the offending type and the tree path; the function
 * is total over the v1 grammar and throws on everything else.
 *
 * `isQueryAstV1` is the structural guard the device-side migrations use to
 * decide whether a stored AST needs the one-time rewrite.
 */

export class QueryAstV1MapError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = "QueryAstV1MapError";
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new QueryAstV1MapError(message, path);
}

function expectObject(value: unknown, path: string): Json {
  if (!isObject(value)) fail(path, `expected an object, got ${JSON.stringify(value)}`);
  return value;
}

function expectString(value: unknown, path: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, `expected a non-empty string for ${what}`);
  }
  return value;
}

function expectStringArray(value: unknown, path: string, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string")) {
    fail(path, `expected a non-empty string array for ${what}`);
  }
  return [...value];
}

function expectGroup(value: unknown, path: string): unknown {
  const group = expectObject(value, path);
  if (group.type !== "group") {
    fail(path, `expected a group, got type ${JSON.stringify(group.type)}`);
  }
  return mapGroup(group, path);
}

// --- member family mapping ------------------------------------------------------------
// The v1 variants per family: ONE id (`class`/`tag`/`linkedTo`/`descendantOf`),
// ANY-of ids (`*Any` + the explicit `pageOf`/`ancestorIn`/`rootIn`/`parentOf`/
// `childOf`/`referencePathOf`), `*Query`, `*Self`, and the `*Set` emptiness bit
// (`classSet`/`tagSet`/`linkSet`/`parentSet`/`childSet`/`descendantSet`/`pageSet`).

type MemberShape =
  | { kind: "one"; family: string; idKey: string }
  | { kind: "many"; family: string; idsKey: string }
  | { kind: "query"; family: string }
  | { kind: "self"; family: string }
  | { kind: "set"; family: string }
  | { kind: "exact" };

/** Every v1 condition `type` → its mapping spec. The table IS the contract. */
const V1_MEMBER_SPECS: Record<string, MemberShape> = {
  class: { kind: "one", family: "class", idKey: "classId" },
  classAny: { kind: "many", family: "class", idsKey: "classIds" },
  classAnyQuery: { kind: "query", family: "class" },
  classSelf: { kind: "self", family: "class" },
  classSet: { kind: "set", family: "class" },
  classExact: { kind: "exact" },
  tag: { kind: "one", family: "tags", idKey: "tagId" },
  tagAny: { kind: "many", family: "tags", idsKey: "tagIds" },
  tagAnyQuery: { kind: "query", family: "tags" },
  tagSelf: { kind: "self", family: "tags" },
  tagSet: { kind: "set", family: "tags" },
  linkedTo: { kind: "one", family: "links", idKey: "nodeId" },
  linkedToAny: { kind: "many", family: "links", idsKey: "nodeIds" },
  linkedToQuery: { kind: "query", family: "links" },
  linkedToSelf: { kind: "self", family: "links" },
  linkSet: { kind: "set", family: "links" },
  referencePathOf: { kind: "many", family: "referencePath", idsKey: "nodeIds" },
  referencePathOfQuery: { kind: "query", family: "referencePath" },
  referencePathOfSelf: { kind: "self", family: "referencePath" },
  parentOf: { kind: "many", family: "parent", idsKey: "nodeIds" },
  parentOfQuery: { kind: "query", family: "parent" },
  parentOfSelf: { kind: "self", family: "parent" },
  parentSet: { kind: "set", family: "parent" },
  childOf: { kind: "many", family: "child", idsKey: "nodeIds" },
  childOfQuery: { kind: "query", family: "child" },
  childOfSelf: { kind: "self", family: "child" },
  childSet: { kind: "set", family: "child" },
  descendantOf: { kind: "one", family: "childPath", idKey: "nodeId" },
  descendantOfAny: { kind: "many", family: "childPath", idsKey: "nodeIds" },
  descendantOfQuery: { kind: "query", family: "childPath" },
  descendantOfSelf: { kind: "self", family: "childPath" },
  descendantSet: { kind: "set", family: "childPath" },
  pageOf: { kind: "many", family: "page", idsKey: "nodeIds" },
  pageOfQuery: { kind: "query", family: "page" },
  pageOfSelf: { kind: "self", family: "page" },
  pageSet: { kind: "set", family: "page" },
  ancestorIn: { kind: "many", family: "parentPath", idsKey: "nodeIds" },
  ancestorInQuery: { kind: "query", family: "parentPath" },
  ancestorInSelf: { kind: "self", family: "parentPath" },
  rootIn: { kind: "many", family: "root", idsKey: "nodeIds" },
  rootInQuery: { kind: "query", family: "root" },
  rootInSelf: { kind: "self", family: "root" },
};

function mapMember(spec: MemberShape, condition: Json, path: string): Json {
  switch (spec.kind) {
    case "one": {
      const id = expectString(condition[spec.idKey], `${path}.${spec.idKey}`, spec.idKey);
      return {
        type: "member",
        family: spec.family,
        op: "in",
        target: { mode: "ids", ids: [id] },
      };
    }
    case "many": {
      const ids = expectStringArray(condition[spec.idsKey], `${path}.${spec.idsKey}`, spec.idsKey);
      return { type: "member", family: spec.family, op: "in", target: { mode: "ids", ids } };
    }
    case "query":
      return {
        type: "member",
        family: spec.family,
        op: "in",
        target: { mode: "query", root: expectGroup(condition.root, `${path}.root`) },
      };
    case "self":
      return { type: "member", family: spec.family, op: "in", target: { mode: "self" } };
    case "set":
      return { type: "member", family: spec.family, op: "exists" };
    case "exact": {
      const id = expectString(condition.classId, `${path}.classId`, "classId");
      return {
        type: "member",
        family: "class",
        op: "exact",
        target: { mode: "ids", ids: [id] },
      };
    }
  }
}

function mapCondition(condition: Json, path: string): Json {
  const type = expectString(condition.type, `${path}.type`, "condition type");
  const spec = V1_MEMBER_SPECS[type];
  if (spec) return mapMember(spec, condition, path);

  switch (type) {
    case "content":
      return { type: "content", op: condition.op, value: condition.value };
    case "contentSet":
      return { type: "content", op: "exists" };
    case "name":
      return { type: "name", op: condition.op, value: condition.value };
    case "property":
      return {
        type: "property",
        schemaId: condition.schemaId,
        op: condition.op,
        value: condition.value,
        includeDefaults: condition.includeDefaults,
      };
    case "propertyBetween":
      return {
        type: "property",
        schemaId: condition.schemaId,
        op: "between",
        from: condition.from,
        to: condition.to,
      };
    case "propertyWithin":
      return { type: "property", schemaId: condition.schemaId, op: "within", period: condition.period };
    case "isClass":
    case "isEmbedded": {
      const value = condition[type];
      if (typeof value !== "boolean") {
        fail(`${path}.${type}`, `expected a boolean for ${type}`);
      }
      return { type: "nodeField", field: type, op: "eq", value: value ? "true" : "false" };
    }
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return { type: "nodeField", field: type, op: condition.op, value: condition.value };
    default:
      fail(path, `unknown v1 condition type ${JSON.stringify(type)}`);
  }
}

/** The v1 date-condition name → [field, op]. */
const V1_DATE_TYPES: Record<string, [string, string]> = {
  createdAfter: ["created", "after"],
  createdBefore: ["created", "before"],
  createdCmp: ["created", "cmp"],
  createdBetween: ["created", "between"],
  createdWithin: ["created", "within"],
  updatedAfter: ["updated", "after"],
  updatedBefore: ["updated", "before"],
  updatedCmp: ["updated", "cmp"],
  updatedBetween: ["updated", "between"],
  updatedWithin: ["updated", "within"],
};

function mapConditionByType(condition: Json, path: string): Json {
  const type = expectString(condition.type, `${path}.type`, "condition type");
  const dateShape = V1_DATE_TYPES[type];
  if (dateShape) {
    const [field, op] = dateShape;
    const mapped: Json = { type: "date", field };
    if (op === "cmp") {
      mapped.op = condition.op;
      mapped.timestamp = condition.timestamp;
    } else {
      mapped.op = op;
      if (op === "between") {
        mapped.from = condition.from;
        mapped.to = condition.to;
      } else if (op === "within") {
        mapped.period = condition.period;
      } else {
        mapped.timestamp = condition.timestamp;
      }
    }
    return mapped;
  }
  return mapCondition(condition, path);
}

function mapChild(child: unknown, path: string): unknown {
  const node = expectObject(child, path);
  const type = expectString(node.type, `${path}.type`, "child type");
  if (type === "group") return mapGroup(node, path);
  if (type === "not") {
    const inner = expectObject(node.child, `${path}.child`);
    const innerType = expectString(inner.type, `${path}.child.type`, "not child type");
    return {
      type: "not",
      child:
        innerType === "group"
          ? mapGroup(inner, `${path}.child`)
          : mapConditionByType(inner, `${path}.child`),
    };
  }
  return mapConditionByType(node, path);
}

function mapGroup(group: Json, path: string): Json {
  if (group.logic !== "and" && group.logic !== "or") {
    fail(`${path}.logic`, `expected "and" | "or", got ${JSON.stringify(group.logic)}`);
  }
  if (!Array.isArray(group.children)) fail(`${path}.children`, "expected a children array");
  return {
    type: "group",
    logic: group.logic,
    children: group.children.map((child, i) => mapChild(child, `${path}.children[${i}]`)),
  };
}

/** Structural v1 guard — true only for an object that IS a v1 AST shape. */
export function isQueryAstV1(ast: unknown): boolean {
  if (!isObject(ast) || ast.version !== 1) return false;
  const root = ast.root;
  return (
    isObject(ast.scope) && isObject(root) && root.type === "group" && Array.isArray(root.children)
  );
}

/**
 * Map a v1 query AST to its v2 image. Pure and total over the v1 grammar:
 * throws `QueryAstV1MapError` (with the tree path) on anything else —
 * including v2 input, which must NOT be re-mapped (the migration is
 * one-time; double-application is a bug, not a no-op).
 */
export function mapQueryAstV1ToV2(ast: unknown): unknown {
  if (!isObject(ast)) fail("$", "expected a query AST object");
  if (ast.version !== 1) {
    fail("$.version", `expected version 1, got ${JSON.stringify(ast.version)}`);
  }
  if (!isObject(ast.scope)) fail("$.scope", "expected a scope object");
  const scopeKeys = new Set(Object.keys(ast.scope));
  if (scopeKeys.size === 0) fail("$.scope", "scope must not be empty");
  const mapped: Json = {
    version: 2,
    scope: { ...ast.scope },
    root: expectGroup(ast.root, "$.root"),
  };
  if (ast.sort !== undefined) mapped.sort = ast.sort;
  if (ast.aggregation !== undefined) mapped.aggregation = ast.aggregation;
  return mapped;
}
