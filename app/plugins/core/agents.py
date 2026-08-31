"""Creator → agent node helpers shared by import/sync plugins.

Creators are passed in a normalized shape:

- persons: ``{"given_name": ..., "family_name": ...}``
- organizations: ``{"organization_name": ...}``

Each creator is deduped by display name via
:meth:`PluginContext.find_or_create_node_by_name` so repeated syncs never
create duplicate agents, and the resulting node UUIDs feed the system
``authors`` property while the normalized dicts feed citekey generation.
"""

from __future__ import annotations

from app.domain.entities.constants import (
    SYSTEM_CLASS_UUIDS,
    SYSTEM_PROPERTY_UUIDS,
)

from .context import PluginContext


def creator_display_name(creator: dict[str, str]) -> str:
    """Return the display name used to dedupe a creator node."""
    organization = creator.get("organization_name", "").strip()
    if organization:
        return organization
    return f"{creator.get('given_name', '').strip()} {creator.get('family_name', '').strip()}".strip()


async def find_or_create_creators(
    plugin_context: PluginContext,
    workspace_uuid: str,
    actor_uuid: str,
    creators: list[dict[str, str]],
) -> list[str]:
    """Find-or-create one ``person``/``organization`` node per creator.

    Returns the agent node UUIDs in creator order. Creators without any name
    are skipped. Person nodes are created with the structured
    ``given_name``/``family_name`` system properties (used by citekey
    generation); properties are only set when the node is first created.
    """
    person_class_uuid = SYSTEM_CLASS_UUIDS["person"]
    organization_class_uuid = SYSTEM_CLASS_UUIDS["organization"]
    given_name_uuid = SYSTEM_PROPERTY_UUIDS["given_name"]
    family_name_uuid = SYSTEM_PROPERTY_UUIDS["family_name"]

    author_uuids: list[str] = []
    for creator in creators:
        name = creator_display_name(creator)
        if not name:
            continue
        organization = creator.get("organization_name", "").strip()
        if organization:
            node_uuid = await plugin_context.find_or_create_node_by_name(
                workspace_uuid, actor_uuid, organization_class_uuid, organization
            )
        else:
            property_values = {}
            if creator.get("given_name", "").strip():
                property_values[given_name_uuid] = creator["given_name"].strip()
            if creator.get("family_name", "").strip():
                property_values[family_name_uuid] = creator["family_name"].strip()
            node_uuid = await plugin_context.find_or_create_node_by_name(
                workspace_uuid,
                actor_uuid,
                person_class_uuid,
                name,
                property_values=property_values,
            )
        author_uuids.append(node_uuid)
    return author_uuids
