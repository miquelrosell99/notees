/**
 * The condition model of the filter block builder — the v1/Odoo register
 * ([type][operator][value][mode]) as pure functions over the draft query
 * AST: the family a condition belongs to, the operator column's options
 * per family (adapting to the selected property schema), the operator's
 * current value (+ its negation), and the operator-application morphs
 * (the picked ids / values / timestamps carry across them). No React —
 * the row components in FilterBlockBuilder.tsx render this model.
 * Extracted verbatim from FilterBlockBuilder.tsx (Stage D monolith
 * split).
 */

import type { Child, Condition, PropertyOp } from "@notees/query";

import type { BuilderFacts } from "./QueryBuilderFields.js";
import {
  FILTER_KIND_OPTIONS,
  type ConditionKind,
} from "./filterQuery.js";

// --- the block (v1/Odoo register: [type][operator][value][mode]) -----------------

/**
 * A block's view of a child: a single condition, or a NOT wrapping one (the
 * negative operators — "is not", "is not set", "does not contain" — are
 * sugar over a not-wrap, so the draft AST carries them verbatim and the row
 * renders them as an operator choice). NOT-around-a-GROUP stays a group
 * wrapper (the NotBlock), never a block.
 */
export function blockView(child: Child): { negated: boolean; condition: Condition } | null {
  if (child.type === "not") {
    return child.child.type === "group"
      ? null
      : { negated: true, condition: child.child };
  }
  if (child.type === "group") return null;
  return { negated: false, condition: child };
}

/** The family a condition belongs to (the block TYPE column's value). */
export function familyOf(condition: Condition): ConditionKind {
  switch (condition.type) {
    case "content":
    case "contentSet":
      return "content";
    case "class":
    case "classExact":
    case "classAny":
    case "classAnyQuery":
    case "classSet":
      return "class";
    case "isClass":
      return "type";
    case "isEmbedded":
      return "placement";
    case "property":
    case "propertyBetween":
    case "propertyWithin":
      return "property";
    case "linkedTo":
    case "linkedToQuery":
    case "linkedToAny":
    case "linkSet":
      return "links";
    case "referencePathOf":
    case "referencePathOfQuery":
      return "referencePath";
    case "parentOf":
    case "parentOfQuery":
      return "parent";
    case "childOf":
    case "childOfQuery":
    case "childSet":
      return "child";
    case "descendantOf":
    case "descendantOfQuery":
    case "descendantOfAny":
    case "descendantSet":
      return "childPath";
    case "tag":
    case "tagAny":
    case "tagAnyQuery":
    case "tagSet":
      return "tags";
    case "parentSet":
      return "parent";
    case "pageOf":
    case "pageOfQuery":
    case "pageSet":
      return "page";
    case "ancestorIn":
    case "ancestorInQuery":
      return "parentPath";
    case "rootIn":
    case "rootInQuery":
      return "root";
    case "coverAsset":
      return "cover";
    case "bannerAsset":
      return "banner";
    case "aliasedNode":
      return "alias";
    case "createdAfter":
    case "createdBefore":
    case "createdCmp":
    case "createdBetween":
    case "createdWithin":
      return "created";
    case "updatedAfter":
    case "updatedBefore":
    case "updatedCmp":
    case "updatedBetween":
    case "updatedWithin":
      return "edited";
    default:
      return "class";
  }
}

interface OperatorOption {
  value: string;
  label: string;
}

/** The operator column's options per family (the Odoo operator sets, owner
 * 2026-10-16). The property family's list adapts to the SELECTED schema's
 * type; the edited family carries the set/not-set pair (created_at is always
 * set — the options would lie). */
export function operatorOptions(
  family: ConditionKind,
  condition: Condition | undefined,
  facts: BuilderFacts,
): readonly OperatorOption[] {
  switch (family) {
    case "class":
      // The class set (owner ruling 2026-10-21: the multi-value register):
      // is/is not ride the EXACT set equality (the single-pill register),
      // contains/does not contain ride closure ANY-of membership over the
      // picked LIST (the "one of" operator collapsed into contains — the
      // identical semantics), is set/is not set test the set's emptiness.
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "content":
      // The text operator set: exact/equality, substring, edge-anchored,
      // full-text, and the emptiness bit.
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        { value: "starts", label: "starts with" },
        { value: "ends", label: "ends with" },
        { value: "fts", label: "full-text" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "tags":
    case "links":
      // The link/tag families (owner ruling 2026-10-21: the multi-value
      // register): is/is not bind the LIST (ANY-of membership over the picked
      // nodes — the "one of" operator collapsed into is), is set/is not set
      // test the reference's existence.
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "referencePath":
      // v1's REFERENCE PATH: the self-or-ancestor link rollup (containment
      // folded in) over the picked nodes / the subquery's matches.
      return [
        { value: "is-any-of", label: "is any of" },
        { value: "is-not-any-of", label: "is not any of" },
      ];
    case "parent":
      // v1's PARENT: the direct parent is any of the picked nodes (or the
      // subquery's matches) — plus the has-a-parent set bit.
      return [
        { value: "is-any-of", label: "is any of" },
        { value: "is-not-any-of", label: "is not any of" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "child":
      // v1's CHILD: contains any of the picked nodes as DIRECT children.
      return [
        { value: "contains-any-of", label: "contains any of" },
        { value: "not-contains-any-of", label: "does not contain any of" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "childPath":
      // v1's CHILD PATH: contains any of the picked nodes anywhere down
      // their tree (the v1 "contains" wording).
      return [
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "type":
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
      ];
    case "placement":
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
      ];
    case "page":
      // v1's Page block: the containing page is any of the picked nodes (or
      // the subquery's matches) — plus the lives-inside-a-page set bit.
      return [
        { value: "is-any-of", label: "is any of" },
        { value: "is-not-any-of", label: "is not any of" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "parentPath":
      // v1's Parent path block: the ancestor chain includes any of the
      // picked nodes (or the subquery's matches) — the v1 "includes" wording.
      return [
        { value: "includes", label: "includes" },
        { value: "not-includes", label: "does not include" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "root":
      // The root walk: the workspace-root ancestor is any of the picked
      // nodes (or the subquery's matches). The set bit is vacuous — every
      // node's root exists (a parentless row is its own root).
      return [
        { value: "is-any-of", label: "is any of" },
        { value: "is-not-any-of", label: "is not any of" },
      ];
    case "property":
      return propertyOperatorOptions(condition, facts);
    case "cover":
    case "banner":
    case "alias":
      return [
        { value: "exists", label: "is set" },
        { value: "not-exists", label: "is not set" },
      ];
    case "created":
    case "edited": {
      // The date operator set (Odoo's date list): day-granular equality, the
      // instant comparisons, the inclusive range, the relative period. The
      // set bits are deliberately absent — created_at/updated_at are written
      // at create time, so every row reads "set" (a lying control).
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "gt", label: ">" },
        { value: "gte", label: "≥" },
        { value: "lt", label: "<" },
        { value: "lte", label: "≤" },
        { value: "between", label: "is between" },
        { value: "within", label: "is within" },
      ];
    }
  }
}

/** The property family's operator list, adapted to the selected schema's type. */
export function propertyOperatorOptions(
  condition: Condition | undefined,
  facts: BuilderFacts,
): readonly OperatorOption[] {
  const schemaId = condition?.type === "property" || condition?.type === "propertyBetween" || condition?.type === "propertyWithin"
    ? condition.schemaId
    : "";
  const schema = facts.boundProperties.find((property) => property.id === schemaId);
  const set = [
    { value: "set", label: "is set" },
    { value: "not-set", label: "is not set" },
  ] as const;
  switch (schema?.type) {
    case "number":
    case "integer":
      // Odoo's numeric list: =/!=/>/>=/</<=, the range, the substring ops.
      return [
        { value: "eq", label: "=" },
        { value: "neq", label: "≠" },
        { value: "gt", label: ">" },
        { value: "gte", label: "≥" },
        { value: "lt", label: "<" },
        { value: "lte", label: "≤" },
        { value: "between", label: "is between" },
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        ...set,
      ];
    case "datetime":
      // The date list: the comparisons, the range, the relative period.
      return [
        { value: "eq", label: "=" },
        { value: "neq", label: "≠" },
        { value: "gt", label: ">" },
        { value: "gte", label: "≥" },
        { value: "lt", label: "<" },
        { value: "lte", label: "≤" },
        { value: "between", label: "is between" },
        { value: "within", label: "is within" },
        ...set,
      ];
    case "select":
      return [
        { value: "eq", label: "is" },
        { value: "neq", label: "is not" },
        ...set,
      ];
    case "boolean":
      return [
        { value: "is-true", label: "is true" },
        { value: "is-false", label: "is false" },
        ...set,
      ];
    case "object":
      // Node-typed: the value control is the anchored node picker.
      return [
        { value: "eq", label: "is" },
        { value: "neq", label: "is not" },
        ...set,
      ];
    default:
      // Text and the rest: the text set.
      return [
        { value: "eq", label: "is" },
        { value: "neq", label: "is not" },
        { value: "contains", label: "contains" },
        { value: "not-contains", label: "does not contain" },
        ...set,
      ];
  }
}

/** The operator column's current value for a condition (+ its negation). */
export function operatorOf(condition: Condition, negated: boolean): string {
  switch (condition.type) {
    case "class":
      // Closure membership (the plain `class` condition rides contains).
      return negated ? "not-contains" : "contains";
    case "classExact":
      return negated ? "is-not" : "is";
    case "classAny":
    case "classAnyQuery":
      // ANY-of closure membership over the picked list (the collapsed
      // "one of" register — owner ruling 2026-10-21).
      return negated ? "not-contains" : "contains";
    case "classSet":
      return negated ? "not-set" : "set";
    case "content":
      if (condition.op === "fts") return "fts";
      if (condition.op === "eq") return negated ? "is-not" : "is";
      if (condition.op === "starts") return "starts";
      if (condition.op === "ends") return "ends";
      return negated ? "not-contains" : "contains";
    case "contentSet":
      return negated ? "not-set" : "set";
    case "tag":
      return negated ? "is-not" : "is";
    case "tagAny":
    case "tagAnyQuery":
      // The multi-value register (owner ruling 2026-10-21): "is" binds the
      // picked LIST — ANY-of membership.
      return negated ? "is-not" : "is";
    case "tagSet":
      return negated ? "not-set" : "set";
    case "linkedTo":
    case "linkedToQuery":
      return negated ? "is-not" : "is";
    case "linkedToAny":
      // The multi-value register: "is" binds the picked LIST.
      return negated ? "is-not" : "is";
    case "linkSet":
      return negated ? "not-set" : "set";
    case "descendantOf":
    case "descendantOfQuery":
      return negated ? "is-not" : "is";
    case "descendantOfAny":
      return negated ? "not-contains" : "contains";
    case "descendantSet":
      return negated ? "not-set" : "set";
    case "parentOf":
    case "parentOfQuery":
      return negated ? "is-not-any-of" : "is-any-of";
    case "parentSet":
      return negated ? "not-set" : "set";
    case "childOf":
    case "childOfQuery":
      return negated ? "not-contains-any-of" : "contains-any-of";
    case "childSet":
      return negated ? "not-set" : "set";
    case "referencePathOf":
    case "referencePathOfQuery":
      return negated ? "is-not-any-of" : "is-any-of";
    case "pageOf":
    case "pageOfQuery":
      return negated ? "is-not-any-of" : "is-any-of";
    case "pageSet":
      return negated ? "not-set" : "set";
    case "ancestorIn":
    case "ancestorInQuery":
      return negated ? "not-includes" : "includes";
    case "rootIn":
    case "rootInQuery":
      return negated ? "is-not-any-of" : "is-any-of";
    case "isClass":
      return condition.isClass ? "is" : "is-not";
    case "isEmbedded":
      return condition.isEmbedded ? "is" : "is-not";
    case "property":
      if (condition.op === "exists") return negated ? "not-set" : "set";
      if (condition.op === "eq" && typeof condition.value === "boolean") {
        const truth = negated ? !condition.value : condition.value;
        return truth ? "is-true" : "is-false";
      }
      return condition.op;
    case "propertyBetween":
      return "between";
    case "propertyWithin":
      return "within";
    case "createdAfter":
      return "after";
    case "createdBefore":
      return "before";
    case "createdCmp":
      if (condition.op === "eq") return negated ? "is-not" : "is";
      if (condition.op === "neq") return negated ? "is" : "is-not";
      return condition.op;
    case "createdBetween":
      return "between";
    case "createdWithin":
      return "within";
    case "updatedAfter":
      return "after";
    case "updatedBefore":
      return "before";
    case "updatedCmp":
      if (condition.op === "eq") return negated ? "is-not" : "is";
      if (condition.op === "neq") return negated ? "is" : "is-not";
      return condition.op;
    case "updatedBetween":
      return "between";
    case "updatedWithin":
      return "within";
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return negated ? "not-exists" : "exists";
  }
}

/**
 * The class family's operator application (owner 2026-10-21, the multi-value
 * register): is / is not → EXACT set equality (the single-pill register, the
 * first carried id), contains / does not contain → closure ANY-of membership
 * over the picked LIST (the collapsed "one of"), is set / is not set →
 * emptiness. The picked ids carry across the morphs so switching operators
 * keeps the selection.
 */
function applyClassOperator(condition: Condition, op: string): Child {
  const carried: string[] =
    condition.type === "classAny"
      ? condition.classIds
      : (condition.type === "class" || condition.type === "classExact") && condition.classId !== ""
        ? [condition.classId]
        : [];
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (op) {
    case "is":
      return { type: "classExact", classId: carried[0] ?? "" };
    case "is-not":
      return neg({ type: "classExact", classId: carried[0] ?? "" });
    case "contains":
      return { type: "classAny", classIds: carried };
    case "not-contains":
      return neg({ type: "classAny", classIds: carried });
    case "set":
      return { type: "classSet" };
    case "not-set":
      return neg({ type: "classSet" });
    default:
      return condition;
  }
}

/** Carried ids for the node-target families (links / parent / tags morphs). */
function carriedNodeIds(condition: Condition): string[] {
  if (condition.type === "tagAny") return condition.tagIds;
  if (
    condition.type === "linkedToAny" ||
    condition.type === "descendantOfAny" ||
    condition.type === "pageOf" ||
    condition.type === "ancestorIn" ||
    condition.type === "rootIn" ||
    condition.type === "parentOf" ||
    condition.type === "childOf" ||
    condition.type === "referencePathOf"
  ) {
    return condition.nodeIds;
  }
  if (condition.type === "linkedTo" || condition.type === "descendantOf") {
    return condition.nodeId !== "" ? [condition.nodeId] : [];
  }
  if (condition.type === "tag") {
    return condition.tagId !== "" ? [condition.tagId] : [];
  }
  return [];
}

/**
 * The node-target morph (owner 2026-10-21, the multi-value register): is /
 * is not bind the picked LIST (ANY-of membership — the collapsed "one of";
 * the legacy single shapes re-enter as the multi list carrying their id),
 * is set / is not set test the reference's existence.
 */
function applyNodeTargetOperator(
  condition: Condition,
  op: string,
  any: (ids: string[]) => Condition,
  setType: Condition,
): Child {
  const carried = carriedNodeIds(condition);
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (op) {
    case "is":
      return any(carried);
    case "is-not":
      return neg(any(carried));
    case "set":
      return setType;
    case "not-set":
      return neg(setType);
    default:
      return condition;
  }
}

/**
 * The node-container morph (v1's Page / Parent path / Root blocks): the
 * static pick and the dynamic subquery share one operator pair (is any of /
 * is not any of — "includes" on the parent path), plus the set bits where
 * they mean something (Page is set = lives inside a page; Parent path is
 * set = has an ancestor at all; Root's set bit is vacuous — never offered).
 */
function applyContainerNodeOperator(
  condition: Condition,
  op: string,
  kind: "page" | "path" | "root",
): Child {
  const carried: string[] =
    condition.type === "pageOf" || condition.type === "ancestorIn" || condition.type === "rootIn"
      ? condition.nodeIds
      : [];
  const single =
    kind === "page"
      ? (nodeIds: string[]): Condition => ({ type: "pageOf", nodeIds })
      : kind === "path"
        ? (nodeIds: string[]): Condition => ({ type: "ancestorIn", nodeIds })
        : (nodeIds: string[]): Condition => ({ type: "rootIn", nodeIds });
  // The parent-path "is set" IS "has a parent" (parentSet); the page's is
  // "lives inside a page" (pageSet).
  const setType: Condition =
    kind === "page" ? { type: "pageSet" } : kind === "path" ? { type: "parentSet" } : condition;
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (op) {
    case "is-any-of":
    case "includes":
      return single(carried);
    case "is-not-any-of":
    case "not-includes":
      return neg(single(carried));
    case "set":
      return setType;
    case "not-set":
      return neg(setType);
    default:
      return condition;
  }
}

/**
 * The generic node-target morph for the v1 pick-set families (Parent direct /
 * Child / Child path / Reference path): a positive/negative operator pair
 * over the picked-id set, plus an optional set bit. The picked ids carry
 * across the morphs; the dynamic (*Query) shapes re-enter through the same
 * operators (the value column is the subquery then).
 */
function applyPickSetOperator(
  condition: Condition,
  op: string,
  positiveOp: string,
  negativeOp: string,
  single: (nodeIds: string[]) => Condition,
  setType: Condition | null,
): Child {
  const carried = carriedNodeIds(condition);
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  if (op === positiveOp) return single(carried);
  if (op === negativeOp) return neg(single(carried));
  if (setType !== null && op === "set") return setType;
  if (setType !== null && op === "not-set") return neg(setType);
  return condition;
}

/** The content morph: the text operator set + the emptiness bit. */
function applyContentOperator(condition: Condition, op: string): Child {
  const carried = condition.type === "content" ? condition.value : "";
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  const text = (contentOp: "eq" | "contains" | "starts" | "ends" | "fts", value: string): Condition => ({
    type: "content",
    op: contentOp,
    value,
  });
  switch (op) {
    case "is":
      return text("eq", carried);
    case "is-not":
      return neg(text("eq", carried));
    case "contains":
      return text("contains", carried);
    case "not-contains":
      return neg(text("contains", carried));
    case "starts":
      return text("starts", carried);
    case "ends":
      return text("ends", carried);
    case "fts":
      return text("fts", carried);
    case "set":
      return { type: "contentSet" };
    case "not-set":
      return neg({ type: "contentSet" });
    default:
      return condition;
  }
}

/** The date morph (created / edited): comparisons carry the timestamp, the range carries it into `from`. */
function applyDateOperator(condition: Condition, op: string, edited: boolean): Child {
  const carried =
    condition.type === "createdCmp" || condition.type === "updatedCmp"
      ? condition.timestamp
      : (condition.type === "createdAfter" || condition.type === "updatedAfter" || condition.type === "createdBefore" || condition.type === "updatedBefore" || condition.type === "createdBetween" || condition.type === "updatedBetween")
        ? (condition as { timestamp?: string; from?: string }).timestamp ??
          (condition as { from?: string }).from ??
          ""
        : "";
  const cmp = (dateOp: "eq" | "neq" | "gt" | "gte" | "lt" | "lte", timestamp: string): Condition =>
    edited
      ? { type: "updatedCmp", op: dateOp, timestamp }
      : { type: "createdCmp", op: dateOp, timestamp };
  const between = (from: string, to: string): Condition =>
    edited ? { type: "updatedBetween", from, to } : { type: "createdBetween", from, to };
  const within = (period: "today" | "this_week" | "this_month" | "this_year"): Condition =>
    edited ? { type: "updatedWithin", period } : { type: "createdWithin", period };
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (op) {
    case "is":
      return cmp("eq", carried);
    case "is-not":
      return neg(cmp("eq", carried));
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return cmp(op, carried);
    case "after":
      return edited
        ? { type: "updatedAfter", timestamp: carried }
        : { type: "createdAfter", timestamp: carried };
    case "before":
      return edited
        ? { type: "updatedBefore", timestamp: carried }
        : { type: "createdBefore", timestamp: carried };
    case "between":
      return between(carried, carried);
    case "within":
      return within("today");
    case "set":
    case "not-set":
      // The date set bits are vacuous: created_at/updated_at are written at
      // create time, so every row reads "set" — no honest control to offer.
      return condition;
    default:
      return condition;
  }
}

/** The property morph: the op carries the value across; between/within keep the schema. */
function applyPropertyOperator(condition: Condition, op: string): Child {
  const schemaId =
    condition.type === "property" || condition.type === "propertyBetween" || condition.type === "propertyWithin"
      ? condition.schemaId
      : "";
  const carried = condition.type === "property" ? condition.value : undefined;
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  const value = (propertyOp: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte", v: unknown): Condition => ({
    type: "property",
    schemaId,
    op: propertyOp,
    ...(v !== undefined ? { value: v } : {}),
  });
  switch (op) {
    case "eq":
      return value("eq", carried);
    case "neq":
      return value("neq", carried);
    case "contains":
      return value("contains", carried);
    case "not-contains":
      return neg(value("contains", carried));
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return value(op, carried);
    case "is-true":
      return value("eq", true);
    case "is-false":
      return value("eq", false);
    case "between":
      return { type: "propertyBetween", schemaId, from: carried, to: undefined };
    case "within":
      return { type: "propertyWithin", schemaId, period: "today" };
    case "set":
      return { type: "property", schemaId, op: "exists" };
    case "not-set":
      return neg({ type: "property", schemaId, op: "exists" });
    default:
      return condition;
  }
}

/**
 * Apply an operator choice to a block's condition, returning the new child
 * (not-wrapped where the operator is negative). The picked ids / values /
 * timestamps carry across the operator morphs; the boolean families flip
 * their bit instead of wrapping.
 */
export function applyOperator(condition: Condition, op: string): Child {
  const wrap = (next: Condition): Child => next;
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  switch (condition.type) {
    case "class":
    case "classExact":
    case "classAny":
    case "classSet":
      return applyClassOperator(condition, op);
    case "content":
    case "contentSet":
      return applyContentOperator(condition, op);
    case "tag":
    case "tagAny":
    case "tagAnyQuery":
    case "tagSet":
      return applyNodeTargetOperator(
        condition,
        op,
        (tagIds) => ({ type: "tagAny", tagIds }),
        { type: "tagSet" },
      );
    case "linkedTo":
    case "linkedToAny":
    case "linkSet":
      return applyNodeTargetOperator(
        condition,
        op,
        (nodeIds) => ({ type: "linkedToAny", nodeIds }),
        { type: "linkSet" },
      );
    case "parentOf":
    case "parentOfQuery":
      return applyPickSetOperator(
        condition,
        op,
        "is-any-of",
        "is-not-any-of",
        (nodeIds) => ({ type: "parentOf", nodeIds }),
        { type: "parentSet" },
      );
    case "childOf":
    case "childOfQuery":
    case "childSet":
      return applyPickSetOperator(
        condition,
        op,
        "contains-any-of",
        "not-contains-any-of",
        (nodeIds) => ({ type: "childOf", nodeIds }),
        { type: "childSet" },
      );
    case "descendantOf":
    case "descendantOfAny":
    case "descendantOfQuery":
    case "descendantSet":
      return applyPickSetOperator(
        condition,
        op,
        "contains",
        "not-contains",
        (nodeIds) => ({ type: "descendantOfAny", nodeIds }),
        { type: "descendantSet" },
      );
    case "referencePathOf":
    case "referencePathOfQuery":
      return applyPickSetOperator(
        condition,
        op,
        "is-any-of",
        "is-not-any-of",
        (nodeIds) => ({ type: "referencePathOf", nodeIds }),
        null,
      );
    case "parentSet":
      // The Parent family's set bit — every operator choice on it keeps it
      // (its operator list is only set / not-set, its own states).
      return condition;
    case "pageOf":
    case "pageOfQuery":
    case "pageSet":
      return applyContainerNodeOperator(condition, op, "page");
    case "ancestorIn":
    case "ancestorInQuery":
      return applyContainerNodeOperator(condition, op, "path");
    case "rootIn":
    case "rootInQuery":
      return applyContainerNodeOperator(condition, op, "root");
    case "createdAfter":
    case "createdBefore":
    case "createdCmp":
    case "createdBetween":
    case "createdWithin":
      return applyDateOperator(condition, op, false);
    case "updatedAfter":
    case "updatedBefore":
    case "updatedCmp":
    case "updatedBetween":
    case "updatedWithin":
      return applyDateOperator(condition, op, true);
    case "property":
    case "propertyBetween":
    case "propertyWithin":
      return applyPropertyOperator(condition, op);
    case "isClass":
      return { ...condition, isClass: op !== "is-not" };
    case "isEmbedded":
      return { ...condition, isEmbedded: op !== "is-not" };
    case "linkedToQuery":
      return op === "is-not" ? neg(condition) : wrap(condition);
    case "classAnyQuery":
      // The dynamic class row: the negative operator wraps in not, every
      // other choice keeps the condition (the nested group is the value).
      return op === "not-contains" ? neg(condition) : wrap(condition);
    case "tagAnyQuery":
      return op === "is-not" ? neg(condition) : wrap(condition);
    case "coverAsset":
    case "bannerAsset":
    case "aliasedNode":
      return op === "not-exists" ? neg(condition) : wrap(condition);
    default:
      return condition;
  }
}

export const FAMILY_OPTIONS: readonly { value: ConditionKind; label: string }[] = FILTER_KIND_OPTIONS.filter(
  (option): option is { value: ConditionKind; label: string; icon: string; description: string } =>
    option.value !== "group-and" && option.value !== "group-or" && option.value !== "not",
);

export const FAMILY_LABELS: Record<ConditionKind, string> = Object.fromEntries(
  FAMILY_OPTIONS.map((option) => [option.value, option.label]),
) as Record<ConditionKind, string>;
