/**
 * The condition model of the filter block builder — the Odoo register
 * ([family][operator][value][target mode]) as pure functions over the v2
 * draft query AST: the family a condition belongs to, the operator column's
 * options per family (adapting to the selected property schema), the
 * operator's current value (+ its negation), and the operator-application
 * morphs (the picked ids / values / timestamps carry across them).
 *
 * v2 shape: the operator column maps onto the member family's orthogonal
 * axes — a membership label flips ONLY `condition.op` between "in" and
 * "not-in" (the target rides verbatim — the mode axis is never touched by
 * an operator choice); the set bits re-materialize the condition as
 * `op: "exists"` / "op: "not-exists"` (no target at all). NOT-wraps remain
 * only where the register sugar predates the wire ops: the content/property/
 * date negatives, the isClass/isEmbedded polarity (the boolean value is the
 * independent other axis), and the wire-field "is not set". No React — the
 * row components in FilterBlockBuilder.tsx render this model.
 */

import type {
  Child,
  Condition,
  MemberCondition,
  MemberFamily,
  PropertyOp,
  TargetRef,
} from "@notees/query";

import type { BuilderFacts } from "./builderFacts.js";
import {
  FILTER_KIND_OPTIONS,
  type ConditionKind,
} from "./filterQuery.js";

// --- the block ---------------------------------------------------------------------

/**
 * A block's view of a child: a single condition, or a NOT wrapping one (the
 * content/property/date negatives, the isClass/isEmbedded polarity, and the
 * wire-field "is not set" are sugar over a not-wrap, so the draft AST
 * carries them verbatim and the row renders them as an operator choice).
 * NOT-around-a-GROUP stays a group wrapper (the NotBlock), never a block.
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

/**
 * The family a condition belongs to (the block TYPE column's value). The v2
 * member condition maps to its wire family; `name` joins `content` (the
 * title register — the builder never authors it, but DSL-parsed ASTs can
 * carry it in).
 */
export function familyOf(condition: Condition): ConditionKind {
  switch (condition.type) {
    case "member":
      return condition.family === "class" ? "class" : condition.family;
    case "content":
    case "name":
      return "content";
    case "property":
      return "property";
    case "date":
      return condition.field === "created" ? "created" : "edited";
    case "nodeField":
      return condition.field === "coverAsset"
        ? "cover"
        : condition.field === "bannerAsset"
          ? "banner"
          : condition.field === "aliasedNode"
            ? "alias"
            : condition.field === "isClass"
              ? "type"
              : "placement";
  }
}

interface OperatorOption {
  value: string;
  label: string;
}

/**
 * The membership register per member family: the operator column's positive
 * and negative labels (unchanged from the v1 UI) and whether the family
 * offers the set bits. Both positive labels map onto the SAME v2 op ("in" —
 * v2 has no single/list split on the wire); the canonical label is what
 * operatorOf reads back (the other is an offered alias that keeps the
 * condition verbatim).
 */
const MEMBER_REGISTER: Record<
  MemberFamily,
  { positives: readonly string[]; canonical: string; negatives: readonly string[]; set: boolean }
> = {
  class: {
    positives: ["is", "contains"],
    canonical: "contains",
    negatives: ["not-contains", "is-not"],
    set: true,
  },
  tags: { positives: ["is"], canonical: "is", negatives: ["is-not"], set: true },
  links: { positives: ["is"], canonical: "is", negatives: ["is-not"], set: true },
  referencePath: {
    positives: ["is-any-of"],
    canonical: "is-any-of",
    negatives: ["is-not-any-of"],
    set: false,
  },
  parent: { positives: ["is"], canonical: "is", negatives: ["is-not"], set: true },
  child: {
    positives: ["contains-any-of"],
    canonical: "contains-any-of",
    negatives: ["not-contains-any-of"],
    set: true,
  },
  childPath: {
    positives: ["contains"],
    canonical: "contains",
    negatives: ["not-contains"],
    set: true,
  },
  page: { positives: ["is"], canonical: "is", negatives: ["is-not"], set: true },
  parentPath: {
    positives: ["includes"],
    canonical: "includes",
    negatives: ["not-includes"],
    set: true,
  },
  root: { positives: ["is"], canonical: "is", negatives: ["is-not"], set: false },
};

/**
 * The operator column's options per family (the Odoo operator sets). The
 * property family's list adapts to the SELECTED schema's type; the edited
 * family carries no set pair (created_at/updated_at are written at create
 * time — the options would lie).
 */
export function operatorOptions(
  family: ConditionKind,
  condition: Condition | undefined,
  facts: BuilderFacts,
): readonly OperatorOption[] {
  switch (family) {
    case "class":
      // The class set: BOTH class operators ride the extends-aware closure
      // membership — "is fuente" matches a node classed book when book
      // extends fuente. is / is not and contains / does not contain are the
      // SAME v2 wire op ("in" over the picked ids — the single/list split
      // was a v1 wire artifact); is set / is not set test the set's
      // emptiness. (Exact set equality — the class member's "exact" op — is
      // legacy-wire-only: stored ASTs still parse/evaluate it, the UI no
      // longer binds it.)
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
      // The link/tag families (the multi-value register): contains/does not
      // contain bind the LIST (ANY-of membership over the picked nodes).
      return [
        { value: "is", label: "contains" },
        { value: "is-not", label: "does not contain" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "referencePath":
      // The link-path rollup (containment folded in) over the picked nodes /
      // the subquery's matches / the host.
      return [
        { value: "is-any-of", label: "contains" },
        { value: "is-not-any-of", label: "does not contain" },
      ];
    case "parent":
      // The DIRECT PARENT is one node — is/is not bind the picked list (the
      // single-slot value control carries 0/1 elements), is set/is not set
      // the has-a-parent bit.
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "child":
      // A DIRECT child is one of the picked nodes.
      return [
        { value: "contains-any-of", label: "contains" },
        { value: "not-contains-any-of", label: "does not contain" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "childPath":
      // The subtree contains any of the picked nodes anywhere down their
      // tree (the v1 "contains" wording).
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
      // The CONTAINING PAGE is one node — is/is not bind the picked list,
      // is set/is not set the lives-inside-a-page bit.
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "parentPath":
      // The ancestor chain contains any of the picked nodes (or the
      // subquery's matches / the host page).
      return [
        { value: "includes", label: "contains" },
        { value: "not-includes", label: "does not contain" },
        { value: "set", label: "is set" },
        { value: "not-set", label: "is not set" },
      ];
    case "root":
      // The workspace-root ancestor is one node — is/is not bind the picked
      // list. The set bit is vacuous — every node's root exists (a
      // parentless row is its own root).
      return [
        { value: "is", label: "is" },
        { value: "is-not", label: "is not" },
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
  const schemaId = condition?.type === "property" ? condition.schemaId : "";
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
    case "member": {
      const register = MEMBER_REGISTER[condition.family];
      if (condition.op === "exact") {
        // Legacy-wire-only (exact set equality): rows still render their "is".
        return negated ? "is-not" : "is";
      }
      if (condition.op === "exists") return negated ? "not-set" : "set";
      if (condition.op === "not-exists") return negated ? "set" : "not-set";
      // in / not-in read the family's canonical membership label (the
      // single/list register collapsed onto the one wire op).
      return condition.op === "not-in"
        ? negated
          ? register.canonical
          : register.negatives[0]!
        : negated
          ? register.negatives[0]!
          : register.canonical;
    }
    case "content":
    case "name":
      if (condition.op === "exists") return negated ? "not-set" : "set";
      if (condition.op === "fts") return "fts";
      if (condition.op === "eq") return negated ? "is-not" : "is";
      if (condition.op === "starts") return "starts";
      if (condition.op === "ends") return "ends";
      return negated ? "not-contains" : "contains";
    case "property":
      if (condition.op === "exists") return negated ? "not-set" : "set";
      if (condition.op === "between") return "between";
      if (condition.op === "within") return "within";
      if (condition.op === "eq" && typeof condition.value === "boolean") {
        const truth = negated ? !condition.value : condition.value;
        return truth ? "is-true" : "is-false";
      }
      // The scalar arms read the polarity too: a not-wrapped eq/contains
      // row renders its negative label (the content family's contract).
      if (condition.op === "eq") return negated ? "neq" : "eq";
      if (condition.op === "contains") return negated ? "not-contains" : "contains";
      return condition.op;
    case "date":
      if (condition.op === "eq") return negated ? "is-not" : "is";
      if (condition.op === "neq") return negated ? "is" : "is-not";
      return condition.op;
    case "nodeField":
      if (condition.field === "isClass" || condition.field === "isEmbedded") {
        // The boolean axis rides the VALUE; polarity rides the not-wrap —
        // the operator column reads (and applies) ONLY the polarity, like
        // the content/property/date negatives and the set-bit arm below.
        return negated ? "is-not" : "is";
      }
      return negated ? "not-exists" : "exists";
  }
}

/**
 * The member morph — the orthogonality law: an operator choice touches ONLY
 * the op axis. Positive labels → `op: "in"`, negative labels →
 * `op: "not-in"`, each carrying the target VERBATIM (an ids list, a nested
 * query, or the self marker — the mode survives every flip). The set bits
 * re-materialize the condition as `exists` / `not-exists` (the set shapes
 * carry no target); flipping back to a membership label re-materializes an
 * `in` over an empty ids pick.
 */
function applyMemberOperator(condition: MemberCondition, op: string): Child {
  const register = MEMBER_REGISTER[condition.family];
  let carriedTarget: TargetRef | undefined;
  if (condition.op === "in" || condition.op === "not-in") carriedTarget = condition.target;
  if (condition.op === "exact") carriedTarget = condition.target;
  const target = carriedTarget ?? { mode: "ids" as const, ids: [] };
  const inOp = condition.op === "not-exists" ? "not-in" : "in";
  if (register.positives.includes(op)) {
    return { ...condition, op: inOp, target } as MemberCondition;
  }
  if (register.negatives.includes(op)) {
    return { ...condition, op: "not-in", target } as MemberCondition;
  }
  if (op === "set") {
    return { type: "member", family: condition.family, op: "exists" };
  }
  if (op === "not-set") {
    return { type: "member", family: condition.family, op: "not-exists" };
  }
  return condition;
}

/** The content/name morph: the text operator set + the emptiness bit. */
function applyTextOperator(condition: Extract<Condition, { type: "content" | "name" }>, op: string): Child {
  const carried = condition.value ?? "";
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  const text = (
    textOp: "eq" | "contains" | "starts" | "ends" | "fts",
    value: string,
  ): Condition => {
    if (condition.type === "content") return { type: "content", op: textOp, value };
    // The title register carries only eq/neq/contains/exists — the edge/fts
    // arms are guarded into "contains" here (unreachable for name rows).
    return { type: "name", op: textOp === "eq" ? "eq" : "contains", value };
  };
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
      return condition.type === "content" ? text("starts", carried) : condition;
    case "ends":
      return condition.type === "content" ? text("ends", carried) : condition;
    case "fts":
      return condition.type === "content" ? text("fts", carried) : condition;
    case "set":
      return { type: condition.type, op: "exists" };
    case "not-set":
      return neg({ type: condition.type, op: "exists" });
    default:
      return condition;
  }
}

/**
 * The date morph (created / edited): the field rides the condition (the
 * family only names WHICH date column); comparisons carry the timestamp, the
 * range carries it into `from`. The set bits are vacuous — created_at/
 * updated_at are written at create time — and keep the condition.
 */
function applyDateOperator(condition: Extract<Condition, { type: "date" }>, op: string): Child {
  const carried = condition.timestamp ?? condition.from ?? "";
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  const cmp = (dateOp: "eq" | "neq" | "gt" | "gte" | "lt" | "lte", timestamp: string): Condition => ({
    type: "date",
    field: condition.field,
    op: dateOp,
    timestamp,
  });
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
      return { type: "date", field: condition.field, op: "after", timestamp: carried };
    case "before":
      return { type: "date", field: condition.field, op: "before", timestamp: carried };
    case "between":
      return {
        type: "date",
        field: condition.field,
        op: "between",
        from: carried,
        to: condition.to ?? carried,
      };
    case "within":
      return {
        type: "date",
        field: condition.field,
        op: "within",
        period: condition.period ?? "today",
      };
    case "set":
    case "not-set":
      // The date set bits are vacuous: created_at/updated_at are written at
      // create time, so every row reads "set" — no honest control to offer.
      return condition;
    default:
      return condition;
  }
}

/** The property morph: the op carries the value across; between keeps the bounds (an eq value carries into the range); within keeps the period. */
function applyPropertyOperator(condition: Extract<Condition, { type: "property" }>, op: string): Child {
  const schemaId = condition.schemaId;
  const carried = condition.value;
  const neg = (next: Condition): Child => ({ type: "not", child: next });
  const value = (
    propertyOp: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte",
    v: unknown,
  ): Condition => ({
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
    case "between": {
      // The bounds ride the re-pick: an eq value carries into the range
      // (the date arm's contract); a between row keeps both bounds verbatim.
      const from = condition.value !== undefined ? condition.value : condition.from;
      return { type: "property", schemaId, op: "between", from, to: condition.to ?? condition.value };
    }
    case "within":
      return { type: "property", schemaId, op: "within", period: condition.period ?? "today" };
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
 * (not-wrapped where the register sugars the negative that way — the
 * content/property/date families, the isClass/isEmbedded polarity, and the
 * wire fields). The member families flip the wire op instead (in ⇄ not-in
 * with the target verbatim; the set bits re-materialize exists/not-exists).
 * The orthogonality law: an operator choice NEVER touches the family's value
 * payload (picked ids / text / value / boolean / bounds / timestamps ride
 * across the morphs).
 */
export function applyOperator(condition: Condition, op: string): Child {
  switch (condition.type) {
    case "member":
      return applyMemberOperator(condition, op);
    case "content":
    case "name":
      return applyTextOperator(condition, op);
    case "date":
      return applyDateOperator(condition, op);
    case "property":
      return applyPropertyOperator(condition, op);
    case "nodeField":
      if (condition.field === "isClass" || condition.field === "isEmbedded") {
        // The orthogonality law: the operator choice touches ONLY the
        // polarity — "is-not" wraps (the group-level not sugar, like the
        // cover/banner/alias arm below), "is" returns the positive row. The
        // boolean VALUE is the independent other axis and never moves here.
        return op === "is-not" ? { type: "not", child: condition } : condition;
      }
      return op === "not-exists" ? { type: "not", child: condition } : condition;
  }
}

export const FAMILY_OPTIONS: readonly { value: ConditionKind; label: string }[] = FILTER_KIND_OPTIONS.filter(
  (option): option is { value: ConditionKind; label: string; icon: string; description: string } =>
    option.value !== "group-and" && option.value !== "group-or" && option.value !== "not",
);

export const FAMILY_LABELS: Record<ConditionKind, string> = Object.fromEntries(
  FAMILY_OPTIONS.map((option) => [option.value, option.label]),
) as Record<ConditionKind, string>;
