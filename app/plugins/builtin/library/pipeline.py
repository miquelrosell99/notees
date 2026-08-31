"""Create-source pipeline: normalized metadata → fully populated source node.

Shared by the add-by-identifier router (Task 13) and future add-by-file
flows (Task 14). The pipeline only runs *after* a provider has returned
complete metadata, so a provider failure never leaves a half-created node.
"""

from __future__ import annotations

from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.core.agents import find_or_create_creators
from app.plugins.core.citekey import fill_citekey_if_empty
from app.plugins.core.context import PluginContext

from .lookup import SourceMetadata

# Source classes the identifier lookup may suggest (subset of the system
# source hierarchy; ``document`` is the fallback).
SOURCE_CLASS_NAMES = frozenset({"book", "paper", "article", "thesis", "document"})


async def create_source_from_metadata(
    plugin_context: PluginContext,
    *,
    workspace_uuid: str,
    actor_uuid: str,
    workspace_id: int,
    user_id: int,
    metadata: SourceMetadata,
) -> dict[str, str | None]:
    """Create a source page from normalized metadata.

    Creates the source node (classed page), find-or-creates agent nodes for
    the creators, sets the system bibliographic properties (isbn/doi/
    publication_date/publisher), and fills ``citekey`` via the workspace
    pattern. Returns ``{"node_uuid", "citekey"}`` (citekey is None when it
    was somehow already set — impossible for a fresh node, kept for the
    helper's contract).
    """
    class_name = metadata.class_name if metadata.class_name in SOURCE_CLASS_NAMES else "document"
    class_uuid = SYSTEM_CLASS_UUIDS[class_name]

    property_values: dict[str, str] = {}
    if metadata.isbn:
        property_values[SYSTEM_PROPERTY_UUIDS["isbn"]] = metadata.isbn
    if metadata.doi:
        property_values[SYSTEM_PROPERTY_UUIDS["doi"]] = metadata.doi
    if metadata.publication_date:
        property_values[SYSTEM_PROPERTY_UUIDS["publication_date"]] = metadata.publication_date
    if metadata.publisher:
        property_values[SYSTEM_PROPERTY_UUIDS["publisher"]] = metadata.publisher

    node_uuid = await plugin_context.create_page(
        workspace_uuid,
        actor_uuid,
        metadata.title,
        class_uuids=[class_uuid],
        property_values=property_values,
        icon="bookshelf",
    )

    if metadata.creators:
        author_uuids = await find_or_create_creators(plugin_context, workspace_uuid, actor_uuid, metadata.creators)
        if author_uuids:
            await plugin_context.set_multi_property(
                workspace_uuid,
                actor_uuid,
                node_uuid,
                SYSTEM_PROPERTY_UUIDS["authors"],
                author_uuids,
            )

    citekey = await fill_citekey_if_empty(
        plugin_context,
        workspace_uuid=workspace_uuid,
        actor_uuid=actor_uuid,
        workspace_id=workspace_id,
        user_id=user_id,
        node_uuid=node_uuid,
        title=metadata.title,
        creators=metadata.creators,
        publication_date=metadata.publication_date,
    )
    return {"node_uuid": node_uuid, "citekey": citekey}
