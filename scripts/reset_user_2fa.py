#!/usr/bin/env python
"""Host-level recovery: disable two-factor authentication for a user.

This is the emergency escape hatch for when a user (including an admin, for whom
2FA is required) loses access to their authenticator and all backup codes. It
requires shell access to the server, which is the intended trust boundary -- it
is deliberately not exposed as an in-app action.

Run inside the backend container so the database hostname resolves:

    docker compose -f compose.dev.yaml exec backend uv run python scripts/reset_user_2fa.py <email>

It clears the user's TOTP secret, disables 2FA, and deletes all backup codes.
The user can then log in with their password and (if an admin) will be required
to enroll again.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

import asyncpg

from app.config import settings


async def reset(email: str) -> int:
    conn = await asyncpg.connect(settings.database_url)
    try:
        row = await conn.fetchrow(
            'SELECT id, email, totp_enabled FROM "user" WHERE email = $1', email
        )
        if row is None:
            print(f"No user found with email {email!r}", file=sys.stderr)
            return 1

        async with conn.transaction():
            await conn.execute(
                'UPDATE "user" '
                "SET totp_enabled = FALSE, totp_secret = NULL, totp_enabled_at = NULL, write_date = NOW() "
                "WHERE id = $1",
                row["id"],
            )
            result = await conn.execute(
                "DELETE FROM user_backup_code WHERE user_id = $1", row["id"]
            )

        print(
            f"2FA disabled for {row['email']} (was_enabled={row['totp_enabled']}); "
            f"backup codes removed ({result})."
        )
        return 0
    finally:
        await conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Disable 2FA for a user (host recovery).")
    parser.add_argument("email", help="Email of the user whose 2FA should be disabled")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(reset(args.email)))


if __name__ == "__main__":
    main()
