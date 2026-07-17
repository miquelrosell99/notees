import { expect, test } from "bun:test";
import { deriveKey, encryptEnvelope, decryptEnvelope } from "../src/crypto";

test("round-trips encrypted payload with routing metadata visible", async () => {
  const key = await deriveKey("workspace-secret");
  const payload = { nodeId: "n1", kind: "page" };
  const encrypted = await encryptEnvelope(payload, key, {
    id: "op-1",
    actorId: "actor-1",
    affectedNodeIds: ["n1"],
    opType: "node.create",
    hlc: { physical: 1000, logical: 0 },
  });
  expect(encrypted.id).toBe("op-1");
  expect(encrypted.actorId).toBe("actor-1");
  expect(encrypted.affectedNodeIds).toEqual(["n1"]);
  expect(encrypted.opType).toBe("node.create");
  expect(encrypted.hlc.physical).toBe(1000);

  const decrypted = await decryptEnvelope(encrypted, key);
  expect(decrypted).toEqual(payload);
});
