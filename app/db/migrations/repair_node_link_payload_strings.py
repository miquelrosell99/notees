"""Migration: repair relay payloads that were stored as JSON strings.

The ``normalize_node_link_uuids`` migration originally wrote rewritten
payloads back to ``relay_envelope`` using ``json.dumps()``. Because the
``payload`` column is ``jsonb``, PostgreSQL stored that as a JSON string
scalar instead of a JSON object. This migration finds those string payloads
and parses them back into objects so the relay layer can validate them as
``dict[str, Any]``.
"""

from __future__ import annotations

import asyncpg


async def run(conn: asyncpg.Connection) -> int:
    """Repair string-typed payloads and return the number of rows fixed."""
    result = await conn.execute(
        """
        UPDATE relay_envelope
        SET payload = (payload #>> '{}')::jsonb
        WHERE jsonb_typeof(payload) = 'string'
        """
    )
    # asyncpg's execute returns a status string like "UPDATE 42".
    parts = result.split()
    return int(parts[-1]) if parts and parts[-1].isdigit() else 0
