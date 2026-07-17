import { expect, test } from "bun:test";
import { createOperation, validateOperation } from "../src/operation";

test("creates and validates a node.create operation", () => {
  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: [],
      opType: "node.create",
    },
    { nodeId: "node-1", kind: "page", parentId: null }
  );
  expect(validateOperation(op)).toBe(true);
  expect(op.envelope.opType).toBe("node.create");
});
