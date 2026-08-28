"""Workspace-aware citekey filling for import/sync plugins.

Wraps the pure pattern interpreter in
:mod:`app.domain.services.citekey` with the workspace plumbing plugins need:
read the node's current ``citekey``, read the ``citekey_pattern`` workspace
setting, collect existing citekeys for collision resolution, and persist the
generated key.

The ``citekey`` property is filled **only when empty** — a stored key (user
edited or previously imported, including Zotero's own citation key) is never
recomputed or overwritten.
"""

from __future__ import annotations

import json

from app.core.uuid import uuidv7
from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS
from app.domain.services.citekey import DEFAULT_CITEKEY_PATTERN, generate_citekey

from .context import PluginContext

CITEKEY_PATTERN_SETTING = "citekey_pattern"


async def fill_citekey_if_empty(
    plugin_context: PluginContext,
    *,
    workspace_uuid: str,
    actor_uuid: str,
    workspace_id: int,
    user_id: int,
    node_uuid: str,
    title: str | None,
    creators: list[dict[str, str]] | None = None,
    publication_date: str | None = None,
    explicit_citekey: str | None = None,
) -> str | None:
    """Set the node's ``citekey`` property when it is currently empty.

    ``explicit_citekey`` (e.g. Zotero's ``citationKey`` or a BibTeX entry key)
    wins over pattern generation. Returns the key that was stored, or ``None``
    when the node already had a non-empty citekey (left untouched).
    """
    citekey_schema_uuid = SYSTEM_PROPERTY_UUIDS["citekey"]
    store = await plugin_context._get_workspace_store(workspace_uuid, actor_uuid)
    try:
        await store.sync()
        current = await store.get_property(node_id=node_uuid, schema_id=citekey_schema_uuid)
        if isinstance(current, str) and current.strip():
            return None

        if explicit_citekey and explicit_citekey.strip():
            key = explicit_citekey.strip()
        else:
            pattern = await plugin_context.get_workspace_setting(
                workspace_id,
                user_id,
                CITEKEY_PATTERN_SETTING,
                DEFAULT_CITEKEY_PATTERN,
            )
            rows = await store.query(
                "SELECT value FROM property_value WHERE property_schema_id = ?",
                (citekey_schema_uuid,),
            )
            existing = {value for row in rows if isinstance((value := json.loads(row["value"])), str) and value}
            key = generate_citekey(
                pattern,
                creators=creators,
                publication_date=publication_date,
                title=title,
                existing=existing,
            )

        await store.set_property(
            property_value_id=uuidv7(),
            node_id=node_uuid,
            schema_id=citekey_schema_uuid,
            value=key,
        )
        return key
    finally:
        await store.close()
