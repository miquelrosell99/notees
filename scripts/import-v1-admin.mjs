/**
 * Import the v1 admin account into the v2 sync server.
 *
 * v1 stored users in PostgreSQL with bcrypt hashes (app/utils/password.py).
 * This script imports ONE account — the owner/admin — into the v2 server's
 * user table (scrypt-hashed, so the password must be provided here; it is
 * verified against the v1 bcrypt hash BEFORE anything is written, using the
 * system Python + bcrypt, and the script refuses to import on mismatch).
 *
 * The admin also becomes owner of EVERY existing v2 workspace (v2 is
 * single-user so far; this preserves full access to the migrated v1
 * workspaces, which have relay data but no membership rows yet).
 *
 * Usage (from the repo root):
 *
 *   pnpm --filter @notees/server exec tsx scripts/import-v1-admin.mjs \
 *     --data-dir config/notees/sync \
 *     --email miquelroselltarrago@gmail.com \
 *     --password '…' \
 *     [--uuid 8c3b46ab-9476-4b6b-aa9e-b3c84de3966b]
 *
 * Idempotent: skips when the email already exists (reports and exits 0).
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { AuthStorage, hashPassword } from "../apps/server/src/auth.ts";

const args = parseArgs({
  options: {
    "data-dir": { type: "string", default: "config/notees/sync" },
    email: { type: "string" },
    password: { type: "string" },
    uuid: { type: "string", default: "8c3b46ab-9476-4b6b-aa9e-b3c84de3966b" },
    "v1-hash": {
      type: "string",
      default: "$2b$12$JAiiyzXxxR.FWNhCRONoauDga9Jzs8i9SUWZo52R8ySrNr5EPS8b.",
    },
  },
});

const email = args.values.email;
const password = args.values.password;
const uuid = args.values.uuid;
const v1Hash = args.values["v1-hash"];
const dataDir = args.values["data-dir"];

if (!email || !password) {
  console.error("usage: import-v1-admin.mjs --email <email> --password <password> [--data-dir …] [--uuid …] [--v1-hash …]");
  process.exit(2);
}

// 1. Verify the password against the v1 bcrypt hash (passlib-era, verified
//    with the bcrypt package directly — passlib 1.7.4 is broken against
//    bcrypt 5.x).
const ok = (() => {
  try {
    execFileSync(
      "python3",
      ["-c", "import bcrypt,sys; sys.exit(0 if bcrypt.checkpw(sys.argv[1].encode(), sys.argv[2].encode()) else 1)", password, v1Hash],
    );
    return true;
  } catch {
    return false;
  }
})();
if (!ok) {
  console.error("refusing to import: the password does not match the v1 bcrypt hash.");
  process.exit(1);
}
console.log(`password verified against the v1 bcrypt hash for ${email}`);

// 2. Write the user + workspace memberships.
const auth = new AuthStorage(`${dataDir}/relay.db`);

const existing = auth.findUserByEmail(email);
if (existing !== null) {
  console.log(`user ${email} already exists (${existing.id}) — nothing to do.`);
} else {
  const passwordHash = await hashPassword(password);
  const user = auth.createUser({
    id: uuid,
    email,
    passwordHash,
    displayName: null,
    isAdmin: true,
  });
  console.log(`created admin user ${user.id} (${user.email})`);
}

const existingUser = auth.findUserByEmail(email);
if (existingUser === null) throw new Error(`user ${email} vanished after import`);
const userId = existingUser.id;
// Password-derived encryption key record (E2EE groundwork): backfilled now,
// while the plaintext password is at hand, for accounts imported before the
// KDF columns existed. Idempotent — skipped when a record exists.
const kdf = await auth.ensureKdfRecord(userId, password);
console.log(`kdf record present for user (scrypt N=${kdf.N}).`);
const workspaces = auth.listAllWorkspaceIds();
for (const workspaceId of workspaces) {
  try {
    auth.createWorkspace({ id: workspaceId });
  } catch {
    // Row exists.
  }
  auth.addMember(workspaceId, userId, "owner");
}
console.log(`granted owner membership on ${workspaces.length} workspace(s).`);

auth.close();
console.log("done.");
