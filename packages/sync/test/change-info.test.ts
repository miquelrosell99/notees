/**
 * Change-info classification (§34.114): the incremental-invalidation
 * vocabulary — which op types are listing-affecting (structural), the
 * presentAsMain carrier exception, envelope summarization, and the
 * coalescing merge.
 */

import { describe, expect, it } from "vitest";

import {
  isListingAffectingEnvelope,
  isListingAffectingOp,
  mergeChangeInfo,
  summarizeEnvelopes,
} from "../src/change-info.js";

describe("isListingAffectingOp", () => {
  it("classifies placement/membership/schema ops as structural", () => {
    for (const opType of [
      "object.create",
      "object.delete",
      "object.move",
      "class.create",
      "class.update",
      "class.setExtends",
      "class.property.set",
      "class.reorder",
      "class.unassign",
      "propertySchema.create",
      "workspace.feature.set",
    ]) {
      expect(isListingAffectingOp(opType), opType).toBe(true);
    }
  });

  it("classifies content/payload ops as non-structural", () => {
    for (const opType of ["object.update", "property.set", "property.unset", "asset.attach"]) {
      expect(isListingAffectingOp(opType), opType).toBe(false);
    }
  });
});

describe("isListingAffectingEnvelope", () => {
  it("treats a presentAsMain toggle riding object.update as structural", () => {
    expect(
      isListingAffectingEnvelope({
        opType: "object.update",
        payload: { objectId: "n1", presentAsMain: true },
      }),
    ).toBe(true);
  });

  it("keeps a pure content object.update non-structural", () => {
    expect(
      isListingAffectingEnvelope({
        opType: "object.update",
        payload: { objectId: "n1", contentAst: [{ type: "text", text: "hi" }] },
      }),
    ).toBe(false);
  });
});

describe("summarizeEnvelopes", () => {
  it("flattens and dedupes affected ids and ORs structural", () => {
    const info = summarizeEnvelopes([
      { opType: "object.update", affectedNodeIds: ["a", "b"] },
      { opType: "property.set", affectedNodeIds: ["b", "c"] },
    ]);
    expect(info.affectedNodeIds.sort()).toEqual(["a", "b", "c"]);
    expect(info.structural).toBe(false);
  });

  it("marks the batch structural when any carrier is listing-affecting", () => {
    const info = summarizeEnvelopes([
      { opType: "object.update", affectedNodeIds: ["a"] },
      { opType: "object.move", affectedNodeIds: ["a"] },
    ]);
    expect(info.structural).toBe(true);
    expect(info.affectedNodeIds).toEqual(["a"]);
  });
});

describe("mergeChangeInfo", () => {
  it("unions ids and ORs structural", () => {
    const merged = mergeChangeInfo(
      { affectedNodeIds: ["a"], structural: false },
      { affectedNodeIds: ["b"], structural: true },
    );
    expect(merged.affectedNodeIds.sort()).toEqual(["a", "b"]);
    expect(merged.structural).toBe(true);
  });

  it("returns the other side when one is undefined", () => {
    expect(mergeChangeInfo(undefined, { affectedNodeIds: ["a"], structural: false })).toEqual({
      affectedNodeIds: ["a"],
      structural: false,
    });
  });
});
