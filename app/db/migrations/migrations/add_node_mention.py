"""Migration: add the node_mention table for unlinked mentions.

Tracks occurrences of a page name in another page's content that are not yet
explicit links. The table is created idempotently; new databases already
receive it via SCHEMA_SQL.
"""

from __future__ import annotations

import asyncpg


async def run(conn: asyncpg.Connection) -> None:
    """Run the migration."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS node_mention (
            id SERIAL PRIMARY KEY,
            uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
            source_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
            target_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
            workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            match_text TEXT NOT NULL,
            position INTEGER DEFAULT 0,
            is_ignored BOOLEAN DEFAULT FALSE,
            create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
            write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL
        )
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_node_mention_source_id ON node_mention(source_id)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_node_mention_target_id ON node_mention(target_id)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_node_mention_workspace_id ON node_mention(workspace_id)"
    )
    await conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_node_mention_workspace_target
            ON node_mention(workspace_id, target_id)
            WHERE is_ignored = FALSE
        """
    )
    await conn.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'unique_node_mention'
                  AND conrelid = 'node_mention'::regclass
            ) THEN
                ALTER TABLE node_mention
                    ADD CONSTRAINT unique_node_mention
                        UNIQUE (workspace_id, source_id, target_id, position);
            END IF;
        END $$;
        """
    )
