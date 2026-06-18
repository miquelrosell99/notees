"""Link parsing service.

Implements linked references and path references following Logseq-style semantics.

Key concepts:
1. Link Occurrence (syntax-level):
   - Links are parsed from text using [[nodeId]] or [[nodeId:linkUuid]] format
   - source_block_id = the block T directly containing the link
   - target_node_id = the node X being linked to
   - link_uuid = unique identifier for this specific link instance (optional, for tracking)

2. Property-based links:
   - Text properties: Links appear in root block R or descendants T
   - Node-class properties: Direct references where property owner B is the linker

3. Classes are stored in class_ids column and tracked separately via Classes Path

4. Breadcrumbs include property provenance: T → property_name → B → … → page
"""

from __future__ import annotations

import json
import re
import uuid as uuid_module
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.domain.entities import BacklinkInfo, NodeLink, NodeUpdateData
from app.domain.errors import NodeNotFoundError, NodeValidationError
from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast

if TYPE_CHECKING:
    from app.domain.entities import Node
    from app.features.nodes.port import LinkRepository, NodeRepository
    from app.features.properties.port import PropertyRepository


# Regex pattern for parsing links - [[nodeId]] or [[nodeId:linkUuid]] format
# Group 1: target node ID (required)
# Group 2: link UUID (optional, preceded by :)
LINK_PATTERN = re.compile(r"\[\[(\d+)(?::([a-f0-9-]+))?\]\]")

# Properties excluded from backlinks (extends excluded for inheritance)
EXCLUDED_PROPERTY_NAMES = ["extends"]


def generate_link_uuid() -> str:
    """Generate a new UUID v4 for a link instance."""
    return str(uuid_module.uuid4())


def _parse_links_from_ast(content: str) -> list[tuple[str, int, str | None, str | None]] | None:
    """Try to parse content as AST JSON and extract node links (ref_type='node').

    Returns None if content is not valid AST JSON, otherwise returns
    list of (target_node_uuid, position, link_uuid, label) tuples.

    The link_id format is "nodeUuid:linkUuid".
    Label is the custom display text from the 'label' field in the AST node.
    """
    try:
        ast = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None

    if not isinstance(ast, list):
        return None

    # Validate it looks like an AST document (array of objects with 'type')
    if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
        return None

    links: list[tuple[str, int, str | None, str | None]] = []
    position = 0

    def walk(nodes: Any) -> None:
        nonlocal position
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "node_link" and node.get("ref_type", "node") == "node":
                link_id = str(node.get("link_id", ""))
                # link_id format: "nodeUuid:linkUuid"
                parts = link_id.split(":", 1)
                if not parts[0]:
                    continue
                node_identifier = parts[0]  # UUID string
                link_uuid = parts[1] if len(parts) > 1 else None
                # Extract custom label if present
                label = node.get("label")
                links.append((node_identifier, position, link_uuid, label))
                position += 1
            # Recurse into children
            if "children" in node:
                walk(node["children"])

    walk(ast)
    return links


def _parse_inline_classes_from_ast(content: str) -> list[tuple[str, int, str | None]] | None:
    """Try to parse content as AST JSON and extract inline class refs (ref_type='class').

    Returns None if content is not valid AST JSON, otherwise returns
    list of (node_identifier, position, link_uuid) tuples.

    The link_id format is "nodeUuid:linkUuid".
    """
    try:
        ast = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None

    if not isinstance(ast, list):
        return None

    if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
        return None

    classes: list[tuple[str, int, str | None]] = []
    position = 0

    def walk(nodes: Any) -> None:
        nonlocal position
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "node_link" and node.get("ref_type") == "class":
                link_id = str(node.get("link_id", ""))
                # link_id format: "nodeUuid:linkUuid"
                parts = link_id.split(":", 1)
                if not parts[0]:
                    continue
                node_identifier = parts[0]  # UUID string
                link_uuid = parts[1] if len(parts) > 1 else None
                classes.append((node_identifier, position, link_uuid))
                position += 1
            if "children" in node:
                walk(node["children"])

    walk(ast)
    return classes


def _parse_embeds_from_ast(content: str) -> list[tuple[str, int, str | None]] | None:
    """Try to parse content as AST JSON and extract embed refs (ref_type='embed').

    Returns None if content is not valid AST JSON, otherwise returns
    list of (node_identifier, position, link_uuid) tuples.

    The link_id format is "nodeUuid:linkUuid".
    """
    try:
        ast = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None

    if not isinstance(ast, list):
        return None

    if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
        return None

    embeds: list[tuple[str, int, str | None]] = []
    position = 0

    def walk(nodes: Any) -> None:
        nonlocal position
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "node_link" and node.get("ref_type") == "embed":
                link_id = str(node.get("link_id", ""))
                parts = link_id.split(":", 1)
                if not parts[0]:
                    continue
                node_identifier = parts[0]
                link_uuid = parts[1] if len(parts) > 1 else None
                embeds.append((node_identifier, position, link_uuid))
                position += 1
            if "children" in node:
                walk(node["children"])

    walk(ast)
    return embeds


def sanitize_content(raw_content: str) -> str:
    """Strip editor artifacts and normalize to canonical format.

    Removes:
    - vscodecontentref artifacts: [[[nodeId]]](http://vscodecontentref/N)
    - Malformed internal URLs: [text](internal://nodeId)
    - Other editor-generated link corruptions

    Returns canonical [[nodeId]] or [[nodeId:linkUuid]] format.
    """
    if not raw_content:
        return raw_content

    content = raw_content

    # Remove vscodecontentref artifacts: [[[nodeId]]](http://vscodecontentref/N) -> [[nodeId]]
    content = re.sub(r"\[\[\[([^\]]+)\]\]\]\(http://vscodecontentref/\d+\)", r"[[\1]]", content)

    # Normalize internal URLs: [text](internal://nodeId) -> [[nodeId]]
    content = re.sub(r"\[([^\]]*)\]\(internal://(\d+)\)", r"[[\2]]", content)

    # Handle broken markdown links with node IDs: [[[nodeId]]] -> [[nodeId]]
    content = re.sub(r"\[\[\[([^\]]+)\]\]\]", r"[[\1]]", content)

    # Normalize any remaining malformed bracket patterns
    content = re.sub(r"\[\[\[([^\]]+)\]\]", r"[[\1]]", content)

    return content


class LinkParsingService:
    """Service for parsing and managing links in node content.

    Handles:
    - Text links: [[id]] syntax in node name field
    - Inline classes: ref_type='class' in AST content (stored with is_inline_class=True)
    - Property links: Node-class property values
    - Classes Path: Inherited classes from ancestors for queries (classes stored in class_ids column)
    """

    def __init__(
        self,
        node_repository: NodeRepository,
        link_repository: LinkRepository,
        property_repository: PropertyRepository | None = None,
    ):
        self._node_repo = node_repository
        self._link_repo = link_repository
        self._property_repo = property_repository

    def parse_links(self, content: str) -> list[tuple[str, int, str | None, str | None]]:
        """Parse content and extract all links.

        Returns list of tuples: (target_node_uuid, position, link_uuid, label)
        Extracts node_link entries with ref_type='node' from AST JSON content.
        The first element is the node UUID.
        Label is the custom display text if present.
        """
        return _parse_links_from_ast(content) or []

    def parse_inline_classes(self, content: str) -> list[tuple[str, int, str | None]]:
        """Parse content and extract all inline class references.

        Returns list of tuples: (node_identifier, position, link_uuid)
        Extracts node_link entries with ref_type='class' from AST JSON content.
        """
        return _parse_inline_classes_from_ast(content) or []

    async def _get_existing_text_links(self, source_node_id: int) -> set[int]:
        """Get set of target node IDs for existing text links from a source node."""
        targets = await self._link_repo.get_text_link_targets(source_node_id)
        return set(targets)

    @staticmethod
    def _node_name_to_text(name: str | None) -> str:
        """Convert a node's raw AST name to plain text."""
        if not name:
            return "Untitled"
        try:
            ast = parse_ast(name, ParseMode.JSON)
            text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
            return text.strip() or "Untitled"
        except (ValueError, TypeError, KeyError):
            return name or "Untitled"

    @staticmethod
    def _notees_link(name: str | None, uuid: str) -> str:
        """Build a markdown-style link with notees: URI.

        Returns: [Node Name](notees:uuid)
        """
        text = LinkParsingService._node_name_to_text(name)
        return f"[{text}](notees:{uuid})"

    async def _log_link_activity(
        self,
        source_node_id: int,
        target_node_id: int,
        source_page_id: int | None,
        target_node: Node,
    ) -> None:
        """Log activity for a new page link insertion.

        Creates two activity entries:
        1. On source page: "Link to [target page name](notees:uuid) inserted"
        2. On target page: "Linked in [source page name](notees:uuid)"

        Uses notees: URI scheme with node UUID for stable, navigable links.
        Only logs for page links (target is a page).
        """
        if not target_node.is_page:
            return

        now = await self._get_utc_now()

        # Get source page info
        source_page = None
        if source_page_id:
            source_page = await self._node_repo.get_by_id(source_page_id)

        # Build markdown links with notees: URI
        target_link = self._notees_link(target_node.name, target_node.uuid)

        # 1. Log on source page: "Link to [target](notees:uuid) inserted"
        if source_page_id:
            await self._link_repo.log_link_activity(
                source_page_id, "link_inserted", f"Link to {target_link} inserted", target_node_id, now
            )

        # 2. Log on target page: "Linked in [source page](notees:uuid)"
        if source_page:
            source_link = self._notees_link(source_page.name, source_page.uuid)
            await self._link_repo.log_link_activity(
                target_node_id, "link_inserted", f"Linked in {source_link}", source_page_id, now
            )

    async def _get_utc_now(self) -> datetime:
        """Get current UTC time as datetime object."""
        from datetime import datetime

        return datetime.now(UTC)

    async def update_node_links(self, node_id: int, content: str) -> list[NodeLink]:
        """Parse content and update link table for a node.

        This handles text links (direct [[id]] in content).
        Property links are handled separately by update_property_links.

        Also logs activity for new page link insertions:
        - On source page: "Link to [target] inserted"
        - On target page: "Linked in [source page]"

        Args:
            node_id: The block T containing the link
            content: The text content to parse

        Returns:
            List of created NodeLink objects
        """
        # Get existing links before deleting (to track new links)
        existing_target_ids = await self._get_existing_text_links(node_id)

        # Get source node to determine its page
        source_node = await self._node_repo.get_by_id(node_id)
        source_page_id = source_node.page_id if source_node else None
        # If source is a page itself, use its own ID
        if source_node and source_node.is_page:
            source_page_id = source_node.id

        # Remove existing non-inline-class text links from this source (property_id IS NULL)
        await self._delete_non_inline_class_text_links(node_id)

        # Page nodes may not contain inline node links — enforce the constraint
        # and return early (existing links were already cleaned up above).
        if source_node and source_node.is_page:
            return []

        # Parse new links from AST (link_id format: "nodeUuid:linkUuid")
        parsed = self.parse_links(content)

        # Batch-resolve all link and embed target UUIDs in a single query.
        all_link_uuids = {node_identifier for node_identifier, _position, _link_uuid, _label in parsed}
        parsed_embeds = _parse_embeds_from_ast(content) or []
        all_embed_uuids = {node_identifier for node_identifier, _position, _link_uuid in parsed_embeds}
        all_target_uuids = list(all_link_uuids | all_embed_uuids)
        uuid_to_node: dict[str, Node] = {}
        if all_target_uuids:
            resolved_nodes = await self._node_repo.get_by_uuids(all_target_uuids)
            uuid_to_node = {n.uuid: n for n in resolved_nodes if n.uuid}

        created_links = []
        seen_target_ids: set[int] = set()

        for node_identifier, position, link_uuid, _label in parsed:
            target_node = uuid_to_node.get(node_identifier)
            if not target_node:
                continue

            target_id = target_node.id

            # Skip duplicate links to the same target within the same block
            if target_id in seen_target_ids:
                continue
            seen_target_ids.add(target_id)

            link = NodeLink(
                source_id=node_id,
                target_id=target_id,
                uuid=link_uuid,
                position=position,
                name=None,  # Label lives in the AST, not in the DB
            )
            created_link = await self._link_repo.create(link)
            created_links.append(created_link)

            # Log activity for NEW page links only
            if target_id not in existing_target_ids and target_node.is_page:
                await self._log_link_activity(node_id, target_id, source_page_id, target_node)

        # Parse and persist embed references (ref_type='embed') as node_link rows.
        # They are tracked separately from regular links via the is_embed flag.
        seen_embed_target_ids: set[int] = set()
        for node_identifier, position, link_uuid in parsed_embeds:
            target_node = uuid_to_node.get(node_identifier)
            if not target_node:
                continue

            target_id = target_node.id
            if target_id in seen_embed_target_ids:
                continue
            seen_embed_target_ids.add(target_id)

            embed_link = NodeLink(
                source_id=node_id,
                target_id=target_id,
                uuid=link_uuid,
                position=position,
                is_embed=True,
                name=None,
            )
            created_embed = await self._link_repo.create(embed_link)
            created_links.append(created_embed)

        return created_links

    async def _delete_non_inline_class_text_links(self, source_node_id: int) -> None:
        """Delete all non-inline-class text links from a source node."""
        await self._link_repo.delete_non_inline_class_text_links(source_node_id)

    async def update_inline_classes(self, node_id: int, content: str) -> list[NodeLink]:
        """Parse content and update inline class links for a node.

        Inline class references (ref_type='class' in AST) are stored as
        NodeLink entries with is_inline_class=True AND added to class_ids array.

        Args:
            node_id: The block containing the inline class references
            content: The text content to parse

        Returns:
            List of created NodeLink objects (with is_inline_class=True)
        """
        # Get old inline class IDs BEFORE deleting them
        old_inline_class_ids = set(await self._link_repo.get_inline_class_targets(node_id))

        # Remove existing inline class links from this source
        await self._link_repo.delete_source_inline_classes(node_id)

        # Parse new inline classes from AST
        parsed = self.parse_inline_classes(content)

        # Batch-resolve all inline class UUIDs in a single query.
        inline_class_uuids = list({node_identifier for node_identifier, _position, _link_uuid in parsed})
        uuid_to_node: dict[str, Node] = {}
        if inline_class_uuids:
            resolved_nodes = await self._node_repo.get_by_uuids(inline_class_uuids)
            uuid_to_node = {n.uuid: n for n in resolved_nodes if n.uuid}

        created_links = []
        new_inline_class_ids = []

        for node_identifier, position, link_uuid in parsed:
            class_node = uuid_to_node.get(node_identifier)
            if not class_node:
                continue

            link = NodeLink(
                source_id=node_id,
                target_id=class_node.id,
                position=position,
                is_inline_class=True,
                uuid=link_uuid,
            )
            created_link = await self._link_repo.create(link)
            created_links.append(created_link)
            new_inline_class_ids.append(class_node.id)

        # Update class_ids array to include inline classes
        current_class_ids = await self._node_repo.get_node_class_ids(node_id)

        # Remove old inline classes from class_ids
        filtered_class_ids = [cid for cid in current_class_ids if cid not in old_inline_class_ids]

        # Add new inline classes to class_ids (avoid duplicates)
        for class_id in new_inline_class_ids:
            if class_id not in filtered_class_ids:
                filtered_class_ids.append(class_id)

        # Update the class_ids array
        await self._node_repo.update_node_class_ids(node_id, filtered_class_ids)

        return created_links

    async def get_inline_classes_for_node(self, node_id: int) -> list[NodeLink]:
        """Get all inline class links for a node.

        Args:
            node_id: The source node ID

        Returns:
            List of NodeLink objects with is_inline_class=True
        """
        return await self._link_repo.get_source_inline_classes(node_id)

    async def update_property_links(self, node_id: int, property_id: int, target_node_ids: list[int]) -> list[NodeLink]:
        """Update links for a node-class property.

        For node-class properties, the property owner B is the explicit linker.
        Classes are now stored in class_ids column, not as a property.

        Args:
            node_id: The property owner B
            property_id: The property ID
            target_node_ids: List of target node IDs referenced by the property

        Returns:
            List of created NodeLink objects
        """
        # Delete existing links for this property
        await self._delete_property_links(node_id, property_id)

        # Batch-resolve all target nodes in a single query.
        id_to_node: dict[int, Node] = {}
        if target_node_ids:
            resolved_nodes = await self._node_repo.get_by_ids(target_node_ids)
            id_to_node = {n.id: n for n in resolved_nodes if n.id is not None}

        created_links = []

        for target_id in target_node_ids:
            # Verify target exists
            if target_id not in id_to_node:
                continue

            link = NodeLink(
                source_id=node_id,
                target_id=target_id,
            )
            created_link = await self._link_repo.create(link)
            created_links.append(created_link)

        return created_links

    async def _delete_property_links(self, source_node_id: int, property_id: int) -> None:
        """Delete all links for a specific property from a source node."""
        await self._link_repo.delete_property_links(source_node_id, property_id)

    async def get_backlinks(self, target_node_id: int) -> list[BacklinkInfo]:
        """Get all backlinks pointing to a node with full provenance.

        Returns BacklinkInfo objects containing:
        - The explicit linker (T for text links, B for property links)
        - Property provenance if applicable
        - Breadcrumb path to page ancestor

        Includes backlinks to all descendants (children, grandchildren, etc.) recursively.
        Also includes backlinks to all aliases of this node (and their descendants).

        Classes are stored in class_ids column, not as property links.
        """
        # Get all descendants of the target node (includes children, grandchildren, etc.)
        descendant_ids = await self._node_repo.get_descendants(target_node_id, include_self=True)

        if not descendant_ids:
            descendant_ids = [target_node_id]

        # Also include alias nodes and THEIR descendants
        alias_ids = await self._link_repo.get_alias_node_ids(target_node_id)
        for alias_id in alias_ids:
            alias_descendants = await self._node_repo.get_descendants(alias_id, include_self=True)
            if alias_descendants:
                descendant_ids.extend(alias_descendants)
            else:
                descendant_ids.append(alias_id)

        # Get all links pointing to this node OR any of its descendants, with property info
        rows = await self._link_repo.get_backlinks_batch(descendant_ids)

        backlinks = []
        seen_source_target_pairs: set[tuple[int, int]] = set()
        # Collect unique source node IDs for batch breadcrumb fetching
        backlink_source_ids: set[int] = set()

        for row in rows:
            pair = (row["source_id"], row["target_id"])
            if pair in seen_source_target_pairs:
                continue
            seen_source_target_pairs.add(pair)

            link = NodeLink(
                id=row["id"],
                source_id=row["source_id"],
                target_id=row["target_id"],
                position=row["position"] or 0,
                is_inline_class=bool(row.get("is_inline_class", False)),
                is_embed=bool(row.get("is_embed", False)),
            )

            backlink_source_ids.add(row["source_id"])

            backlink_info = BacklinkInfo(
                link=link,
                source_node_id=row["source_id"],
                source_node_name=row["source_name"] or "",
                source_node_uuid=row["source_uuid"],
                source_is_page=bool(row["source_is_page"]),
                source_page_id=row["source_page_id"],
                source_page_name=row["page_name"],
                source_page_uuid=row["page_uuid"],
                property_id=row["property_id"],
                property_name=row["property_name"],
                breadcrumb_path=[],
            )
            backlinks.append(backlink_info)

        # Also get references from node-type properties (property_value_relation)
        property_rows = await self._link_repo.get_property_backlinks_batch(descendant_ids)

        for row in property_rows:
            link = NodeLink(
                id=None,
                source_id=row["source_id"],
                target_id=target_node_id,
                position=0,
            )

            backlink_source_ids.add(row["source_id"])

            backlink_info = BacklinkInfo(
                link=link,
                source_node_id=row["source_id"],
                source_node_name=row["source_name"] or "",
                source_node_uuid=row["source_uuid"],
                source_is_page=bool(row["source_is_page"]),
                source_page_id=row["source_page_id"],
                source_page_name=row["page_name"],
                source_page_uuid=row["page_uuid"],
                property_id=row["property_id"],
                property_name=row["property_name"],
                breadcrumb_path=[],
            )
            backlinks.append(backlink_info)

        # Batch build breadcrumbs for all unique source nodes
        if backlink_source_ids:
            breadcrumb_map = await self._node_repo.get_breadcrumbs_batch(list(backlink_source_ids))
            for b in backlinks:
                ancestors = breadcrumb_map.get(b.source_node_id, [])
                b.breadcrumb_path = self._build_breadcrumb_path_from_ancestors(
                    ancestors,
                    property_name=b.property_name,
                )

        # ── Detect text property context ──────────────────────────────
        text_link_backlinks = [b for b in backlinks if b.property_id is None and not b.source_is_page]

        if text_link_backlinks:
            text_source_ids = [b.source_node_id for b in text_link_backlinks]
            source_ancestor_map = await self._node_repo.get_ancestors_batch(text_source_ids, include_self=True)
            all_ancestor_ids: set[int] = set()
            for ancestors in source_ancestor_map.values():
                all_ancestor_ids.update(ancestors)

            if all_ancestor_ids:
                text_prop_rows = await self._link_repo.get_text_property_backlinks_batch(list(all_ancestor_ids))

                text_prop_lookup: dict[int, dict] = {}
                for tpr in text_prop_rows:
                    text_prop_lookup[tpr["root_block_id"]] = {
                        "owner_id": tpr["owner_id"],
                        "owner_name": tpr["owner_name"],
                        "owner_uuid": tpr["owner_uuid"],
                        "owner_is_page": tpr["owner_is_page"],
                        "owner_page_id": tpr["owner_page_id"],
                        "owner_page_name": tpr["owner_page_name"],
                        "owner_page_uuid": tpr["owner_page_uuid"],
                        "property_id": tpr["property_id"],
                        "property_name": tpr["property_name"],
                        "root_block_id": tpr["root_block_id"],
                    }

                if text_prop_lookup:
                    for b in text_link_backlinks:
                        ancestors = source_ancestor_map.get(b.source_node_id, [])
                        for anc_id in ancestors:
                            if anc_id in text_prop_lookup:
                                info = text_prop_lookup[anc_id]
                                b.property_id = info["property_id"]
                                b.property_name = info["property_name"]
                                b.text_property_root_block_id = info["root_block_id"]
                                b.source_node_id = info["owner_id"]
                                b.source_node_name = info["owner_name"] or ""
                                b.source_node_uuid = info["owner_uuid"] or ""
                                b.source_is_page = bool(info["owner_is_page"])
                                if info["owner_is_page"]:
                                    b.source_page_id = info["owner_id"]
                                    b.source_page_name = info["owner_name"]
                                    b.source_page_uuid = info["owner_uuid"]
                                else:
                                    b.source_page_id = info["owner_page_id"]
                                    b.source_page_name = info["owner_page_name"]
                                    b.source_page_uuid = info["owner_page_uuid"]
                                # Rebuild breadcrumb for the new owner
                                owner_ancestors = breadcrumb_map.get(info["owner_id"], [])
                                b.breadcrumb_path = self._build_breadcrumb_path_from_ancestors(
                                    owner_ancestors,
                                    property_name=info["property_name"],
                                )
                                break

        return backlinks

    async def _build_breadcrumb_path(
        self,
        source_node_id: int,
        property_name: str | None = None,
    ) -> list[tuple[int | None, str, bool]]:
        """Build breadcrumb path from source to page ancestor.

        Uses the node repository's get_breadcrumbs method (recursive CTE) for
        efficient ancestor lookup.

        Format: [(node_id, name, is_property_segment), ...]
        - For text links: T → ... → page
        - For property links: T → property_name → B → ... → page

        Property names are included as breadcrumb segments (is_property_segment=True).
        """
        breadcrumbs = []

        # Use the node repository's get_breadcrumbs method (recursive CTE)
        try:
            ancestor_nodes = await self._node_repo.get_breadcrumbs(source_node_id)
        except AttributeError:
            # Fallback: return empty if method not available
            return breadcrumbs

        if not ancestor_nodes:
            return breadcrumbs

        # ancestor_nodes is ordered from root to exit_node
        # We want: source → ... → page (source first)
        # So reverse: exit_node (source) first, then up to the containing page
        reversed_nodes = list(reversed(ancestor_nodes))

        first_node = True
        for node in reversed_nodes:
            # Add property segment after the first node (the source block)
            # Breadcrumb: source → property_name → ... → page
            if first_node and property_name:
                breadcrumbs.append((node.id, node.name or "", False))
                breadcrumbs.append((None, property_name, True))  # Property segment
                first_node = False
            else:
                breadcrumbs.append((node.id, node.name or "", False))

            # Stop at page
            if node.is_page:
                break

        return breadcrumbs

    def _build_breadcrumb_path_from_ancestors(
        self,
        ancestor_nodes: list[object],
        property_name: str | None = None,
    ) -> list[tuple[int | None, str, bool]]:
        """Build breadcrumb path from pre-fetched ancestor nodes.

        Mirrors the logic of `_build_breadcrumb_path` but uses already-fetched
        ancestor nodes to avoid a recursive CTE per backlink.

        Format: [(node_id, name, is_property_segment), ...]
        """
        breadcrumbs: list[tuple[int | None, str, bool]] = []
        if not ancestor_nodes:
            return breadcrumbs

        reversed_nodes = list(reversed(ancestor_nodes))
        first_node = True
        for node in reversed_nodes:
            if first_node and property_name:
                breadcrumbs.append((node.id, node.name or "", False))
                breadcrumbs.append((None, property_name, True))
                first_node = False
            else:
                breadcrumbs.append((node.id, node.name or "", False))
            if node.is_page:
                break
        return breadcrumbs

    async def get_path_references(self, node_id: int) -> list[int]:
        """Get all nodes referenced in the path from this node to root.

        Uses recursive CTE for efficient ancestor lookup.

        This includes:
        - All text links from ancestors
        - All property links from ancestors (excluding classes)

        Used for query semantics where descendants inherit references.
        """
        try:
            ancestor_ids = await self._node_repo.get_ancestors(node_id, include_self=True)
        except LookupError:
            return []

        if not ancestor_ids:
            return []

        return await self._link_repo.get_path_references(ancestor_ids)

    async def update_classes_path(self, node_id: int) -> list[int]:
        """Compute and store the Classes Path for a node.

        Uses recursive CTE for efficient ancestor lookup.

        Classes Path = ordered list of class node IDs inherited from ancestors'
        class_ids columns.

        This is separate from backlinks and is used for filtering/queries.
        """
        classes_path: list[int] = []

        # Get own classes from class_ids column
        own_classes = await self._node_repo.get_node_class_ids(node_id)
        if own_classes:
            classes_path.extend(own_classes)

        # Get ancestor IDs using closure table (ordered from root to parent)
        try:
            ancestor_ids = await self._node_repo.get_ancestors(node_id, include_self=False)
        except LookupError:
            ancestor_ids = []

        # Collect classes from all ancestors
        if ancestor_ids:
            ancestor_classes = await self._link_repo.get_distinct_class_ids(ancestor_ids)
            for class_id in ancestor_classes:
                if class_id not in classes_path:
                    classes_path.append(class_id)

        # Store classes_path
        await self._link_repo.bulk_update_classes_path([(classes_path, node_id)])

        return classes_path

    async def update_classes_path_for_descendants(self, node_id: int) -> None:
        """Update classes_path for a node and all its descendants.

        Uses recursive CTE to efficiently get all descendants.
        Called when a node's classes change or when a node is reparented.
        """
        # Get all descendant IDs using closure table (includes self)
        try:
            descendant_ids = await self._node_repo.get_descendants(node_id, include_self=True)
        except LookupError:
            # Fallback to just updating the current node
            await self.update_classes_path(node_id)
            return

        # Update classes_path for each descendant
        for desc_id in descendant_ids:
            await self.update_classes_path(desc_id)

    def strip_links(self, content: str) -> str:
        """Remove link markup from content, leaving just the node IDs as text.

        [[123]] -> 123
        """
        return LINK_PATTERN.sub(r"\1", content).strip()

    def render_links(self, content: str, link_map: dict) -> str:
        """Render content with links as HTML anchors.

        Args:
            content: Raw content with [[nodeId]] links
            link_map: Dict mapping node IDs to their names

        Returns:
            HTML string with clickable links
        """

        def link_replacer(match):
            node_id = match.group(1)
            if node_id in link_map:
                name = link_map[node_id].get("name", node_id)
                is_page = link_map[node_id].get("is_page", True)
                link_class = "page-link" if is_page else "block-link"
                return f'<a href="/node/{node_id}" class="node-link {link_class}">{name}</a>'
            return f'<span class="node-link unresolved">{node_id}</span>'

        return LINK_PATTERN.sub(link_replacer, content)

    async def get_backlink_source_ids(self, target_id: int) -> list[int]:
        """Get distinct source node IDs that link to the target."""
        return await self._link_repo.get_backlink_source_ids(target_id)

    async def redirect_link_targets(self, old_target_id: int, new_target_id: int) -> None:
        """Update all node_link records to point from old_target to new_target."""
        await self._link_repo.redirect_link_targets(old_target_id, new_target_id)

    async def delete_source_links(self, source_node_id: int) -> int:
        """Delete all links from a source node."""
        return await self._link_repo.delete_source_links(source_node_id)

    async def get_links_for_nodes(
        self,
        node_ids: list[int],
        scope: str,
        cooccurrence: bool,
        context_node_id: int | None,
    ) -> list[dict[str, Any]]:
        """Get links for a set of nodes."""
        return await self._link_repo.get_links_for_nodes(
            node_ids, scope, cooccurrence, context_node_id
        )

    async def get_alias_node_ids(self, target_node_id: int) -> list[int]:
        """Get IDs of nodes that alias the target node."""
        return await self._link_repo.get_alias_node_ids(target_node_id)

    async def get_alias_node_ids_batch(self, target_node_ids: list[int]) -> dict[int, list[int]]:
        """Get alias node IDs for multiple target nodes."""
        return await self._link_repo.get_alias_node_ids_batch(target_node_ids)

    async def get_inline_class_targets(self, node_id: int) -> list[int]:
        """Get target IDs of inline class links from a source node."""
        return await self._link_repo.get_inline_class_targets(node_id)

    async def get_inline_class_references(self, target_node_id: int) -> list[NodeLink]:
        """Get all inline class links pointing to a target node."""
        return await self._link_repo.get_inline_class_references(target_node_id)

    async def get_backlink_counts(self, target_ids: list[int]) -> dict[int, int]:
        """Get backlink counts for multiple target nodes."""
        return await self._link_repo.get_backlink_counts(target_ids)

    async def get_text_link_targets_batch(self, source_ids: list[int]) -> list[int]:
        """Get distinct target IDs of text links from source nodes."""
        return await self._link_repo.get_text_link_targets_batch(source_ids)

    async def get_text_links(self, source_node_id: int) -> list[NodeLink]:
        """Get all text links (property_id IS NULL) from a source node."""
        return await self._link_repo.get_text_links(source_node_id)

    async def get_text_links_batch(self, node_ids: list[int]) -> dict[int, list[NodeLink]]:
        """Get text links for multiple source nodes, grouped by source_id."""
        links = await self._link_repo.get_text_links_batch(node_ids)
        result: dict[int, list[NodeLink]] = {}
        for link in links:
            result.setdefault(link.source_id, []).append(link)
        return result

    async def get_property_backlinks(
        self, node_id: int
    ) -> list[tuple[Any, int, str]]:
        """Get pages that reference this node via date or node properties.

        Returns a list of (page_node, property_id, property_name) tuples.
        """
        target = await self._node_repo.get_by_id(node_id)
        if not target:
            raise NodeNotFoundError(str(node_id))

        from app.domain.entities.constants import parse_date_uuid

        date_info = parse_date_uuid(target.uuid)
        is_day = date_info is not None and date_info.get("type") == "day"

        date_rows, node_rows = await self._link_repo.get_property_backlinks_for_node(node_id)
        rows = list(node_rows)
        if is_day:
            rows.extend(date_rows)

        result: list[tuple[Any, int, str]] = []
        seen_page_ids: set[int] = set()

        # Batch-resolve all source nodes and their containing pages.
        source_node_ids = list({row["node_id"] for row in rows})
        source_nodes = await self._node_repo.get_by_ids(source_node_ids)
        source_node_map: dict[int, Node] = {n.id: n for n in source_nodes if n.id is not None}

        page_ids = list({sn.page_id for sn in source_nodes if sn.page_id})
        pages = await self._node_repo.get_by_ids(page_ids)
        page_map: dict[int, Node] = {p.id: p for p in pages if p.id is not None}

        for row in rows:
            source_node = source_node_map.get(row["node_id"])
            if not source_node:
                continue

            page = source_node
            if source_node.page_id:
                page = page_map.get(source_node.page_id, source_node)

            if page.id is None or page.id in seen_page_ids:
                continue
            seen_page_ids.add(page.id)
            result.append((page, row["property_id"], row["property_name"]))

        return result

    async def get_alias_ids(self, target_node_id: int) -> list[int]:
        """Get IDs of nodes that are aliases of the target node."""
        return await self._link_repo.get_alias_node_ids(target_node_id)

    async def add_alias(self, target_node_id: int, alias_node_id: int) -> None:
        """Add a page as an alias of the target node.

        Raises:
            NodeNotFoundError: If target or alias node does not exist.
            NodeValidationError: If alias constraints are violated.
        """
        if alias_node_id == target_node_id:
            raise NodeValidationError("A node cannot be an alias of itself")

        target = await self._node_repo.get_by_id(target_node_id)
        if not target:
            raise NodeNotFoundError(str(target_node_id))
        if not target.is_page:
            raise NodeValidationError("Aliases can only be added to page nodes")
        if target.aliased_id is not None:
            raise NodeValidationError(
                "Cannot add aliases to a node that is itself an alias. Add aliases to the main node instead."
            )

        alias = await self._node_repo.get_by_id(alias_node_id)
        if not alias:
            raise NodeNotFoundError(str(alias_node_id))
        if not alias.is_page:
            raise NodeValidationError("Only page nodes can be used as aliases")
        if alias.aliased_id is not None:
            raise NodeValidationError("This node is already an alias of another node")

        alias_ids = await self._link_repo.get_alias_node_ids(alias_node_id)
        if alias_ids:
            raise NodeValidationError(
                "Cannot use a node that has aliases as an alias itself. Remove its aliases first."
            )

        await self._link_repo.set_alias(target_node_id, alias_node_id)

    async def remove_alias(self, target_node_id: int, alias_node_id: int) -> bool:
        """Remove an alias from a node."""
        return await self._link_repo.remove_alias(target_node_id, alias_node_id)

    async def rebuild_all_links(self) -> dict[str, Any]:
        """Rebuild all node_link records from AST content.

        Deletes existing text links and inline classes, then re-parses all nodes'
        AST content to rebuild both types of links.
        """
        from app.logging_config import get_logger

        logger = get_logger(__name__)

        deleted = await self._link_repo.delete_text_links_for_workspace()
        logger.info(f"[REBUILD_LINKS] Deleted {deleted} existing text links and inline classes")

        nodes = await self._node_repo.get_active_nodes()
        logger.info(f"[REBUILD_LINKS] Processing {len(nodes)} nodes")

        nodes_processed = 0
        links_created = 0
        inline_classes_created = 0
        errors: list[str] = []

        for node in nodes:
            node_id = node.id
            content = node.name

            if not content:
                nodes_processed += 1
                continue

            try:
                created_links = await self.update_node_links(node_id, content)
                links_created += len(created_links)

                created_classes = await self.update_inline_classes(node_id, content)
                inline_classes_created += len(created_classes)

                nodes_processed += 1

                if nodes_processed % 100 == 0:
                    logger.info(f"[REBUILD_LINKS] Progress: {nodes_processed}/{len(nodes)} nodes")
            except Exception as e:
                error_msg = f"Node {node_id}: {str(e)}"
                errors.append(error_msg)
                logger.warning(f"[REBUILD_LINKS] Error processing node {node_id}: {e}")
                nodes_processed += 1
                continue

        logger.info(
            f"[REBUILD_LINKS] Completed: {nodes_processed} nodes, {links_created} links + "
            f"{inline_classes_created} inline classes created, {len(errors)} errors"
        )

        return {
            "success": True,
            "nodes_processed": nodes_processed,
            "links_created": links_created,
            "inline_classes_created": inline_classes_created,
            "errors": errors[:100],
            "total_errors": len(errors),
        }

    async def fix_raw_uuid_links(self) -> dict[str, Any]:
        """Find raw [[uuid]] text in AST content and convert them to proper node_link AST nodes."""
        from app.logging_config import get_logger

        logger = get_logger(__name__)

        uuid_re = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        uuid_pattern = re.compile(
            rf"(?:\[(?P<label>[^\]]+)\]\(\[\[(?P<uuid_labeled>{uuid_re})\]\]\)|\[\[(?P<uuid_bare>{uuid_re})\]\])",
            re.IGNORECASE,
        )

        def _extract_uuid_and_label(match: re.Match) -> tuple[str, str | None]:
            if match.group("uuid_labeled"):
                return match.group("uuid_labeled").lower(), match.group("label") or None
            return match.group("uuid_bare").lower(), None

        def transform_text_node(text_value: str, uuid_to_node: dict) -> list[dict[str, Any]]:
            parts: list[dict[str, Any]] = []
            last_end = 0

            for match in uuid_pattern.finditer(text_value):
                target_uuid, label = _extract_uuid_and_label(match)
                if target_uuid not in uuid_to_node:
                    continue

                before = text_value[last_end : match.start()]
                if before:
                    parts.append({"type": "text", "text": before})

                link_uuid = str(uuid_module.uuid4())
                link_id = f"{target_uuid}:{link_uuid}"
                node_link: dict[str, Any] = {
                    "type": "node_link",
                    "link_id": link_id,
                    "ref_type": "node",
                }
                if label:
                    node_link["label"] = label
                parts.append(node_link)

                last_end = match.end()

            if last_end < len(text_value):
                remaining = text_value[last_end:]
                if remaining:
                    parts.append({"type": "text", "text": remaining})

            return parts

        def walk_and_transform(nodes: list[Any], uuid_to_node: dict) -> tuple[list[Any], int]:
            converted = 0
            new_nodes: list[Any] = []

            for node in nodes:
                if not isinstance(node, dict):
                    new_nodes.append(node)
                    continue

                node_type = node.get("type")
                if node_type == "broken_link":
                    link_id = node.get("link_id", "")
                    colon_idx = link_id.find(":")
                    node_uuid = link_id[:colon_idx].lower() if colon_idx > 0 else link_id.lower()
                    if node_uuid in uuid_to_node:
                        new_link_uuid = str(uuid_module.uuid4())
                        new_link_id = f"{node_uuid}:{new_link_uuid}"
                        new_node = {
                            **node,
                            "type": "node_link",
                            "ref_type": "node",
                            "link_id": new_link_id,
                        }
                        new_nodes.append(new_node)
                        converted += 1
                        continue
                    new_nodes.append(node)
                elif node_type == "text":
                    text_val = node.get("text", "")
                    if "[[" in text_val and uuid_pattern.search(text_val):
                        replacement = transform_text_node(text_val, uuid_to_node)
                        if replacement and replacement != [node]:
                            link_count = sum(
                                1 for r in replacement if isinstance(r, dict) and r.get("type") == "node_link"
                            )
                            if link_count > 0:
                                new_nodes.extend(replacement)
                                converted += link_count
                                continue
                    new_nodes.append(node)
                elif "children" in node:
                    child_nodes, child_converted = walk_and_transform(node["children"], uuid_to_node)
                    new_node = {**node, "children": child_nodes}
                    new_nodes.append(new_node)
                    converted += child_converted
                else:
                    new_nodes.append(node)

            return new_nodes, converted

        nodes = await self._node_repo.get_active_nodes()
        logger.info(f"[FIX_RAW_UUID_LINKS] Processing {len(nodes)} nodes")

        nodes_processed = 0
        nodes_fixed = 0
        links_converted = 0
        errors: list[str] = []

        all_referenced_uuids: set[str] = set()
        for node in nodes:
            content = node.name
            if not content:
                continue
            if "[[" not in content and "broken_link" not in content:
                continue
            try:
                ast = json.loads(content)
                if not isinstance(ast, list):
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            def collect_uuids(nodes: list[Any]) -> None:
                for n in nodes:
                    if not isinstance(n, dict):
                        continue
                    if n.get("type") == "text":
                        text = n.get("text", "")
                        if "[[" in text:
                            for m in uuid_pattern.finditer(text):
                                uuid = (m.group("uuid_labeled") or m.group("uuid_bare")).lower()
                                all_referenced_uuids.add(uuid)
                    elif n.get("type") == "broken_link":
                        link_id = n.get("link_id", "")
                        colon_idx = link_id.find(":")
                        node_uuid = link_id[:colon_idx].lower() if colon_idx > 0 else link_id.lower()
                        if re.match(uuid_re, node_uuid, re.IGNORECASE):
                            all_referenced_uuids.add(node_uuid)
                    if "children" in n:
                        collect_uuids(n["children"])

            collect_uuids(ast)

        if not all_referenced_uuids:
            logger.info("[FIX_RAW_UUID_LINKS] No raw UUID links found")
            return {
                "success": True,
                "nodes_processed": len(nodes),
                "nodes_fixed": 0,
                "links_converted": 0,
                "errors": [],
                "total_errors": 0,
            }

        logger.info(f"[FIX_RAW_UUID_LINKS] Found {len(all_referenced_uuids)} unique referenced UUIDs")

        uuid_to_node: dict[str, dict[str, Any]] = {}
        for ref_uuid in all_referenced_uuids:
            found = await self._node_repo.get_by_uuid(ref_uuid)
            if found and found.id is not None:
                uuid_to_node[ref_uuid] = {"id": found.id, "uuid": found.uuid}

        logger.info(
            f"[FIX_RAW_UUID_LINKS] Resolved {len(uuid_to_node)}/{len(all_referenced_uuids)} UUIDs to existing nodes"
        )

        for node in nodes:
            node_id = node.id
            content = node.name
            nodes_processed += 1

            if not content or ("[[" not in content and "broken_link" not in content):
                continue

            try:
                ast = json.loads(content)
                if not isinstance(ast, list):
                    continue
                if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            try:
                new_ast, converted = walk_and_transform(ast, uuid_to_node)

                if converted > 0:
                    new_content = json.dumps(new_ast, ensure_ascii=False)
                    await self._node_repo.update(node_id, NodeUpdateData(name=new_content))

                    await self.update_node_links(node_id, new_content)
                    await self.update_inline_classes(node_id, new_content)

                    nodes_fixed += 1
                    links_converted += converted

                    if nodes_fixed % 50 == 0:
                        logger.info(
                            f"[FIX_RAW_UUID_LINKS] Progress: {nodes_fixed} nodes fixed, {links_converted} links converted"
                        )

            except Exception as e:
                error_msg = f"Node {node_id}: {str(e)}"
                errors.append(error_msg)
                logger.warning(f"[FIX_RAW_UUID_LINKS] Error processing node {node_id}: {e}")
                continue

        logger.info(
            f"[FIX_RAW_UUID_LINKS] Completed: {nodes_processed} processed, {nodes_fixed} fixed, "
            f"{links_converted} links converted, {len(errors)} errors"
        )

        return {
            "success": True,
            "nodes_processed": nodes_processed,
            "nodes_fixed": nodes_fixed,
            "links_converted": links_converted,
            "errors": errors[:100],
            "total_errors": len(errors),
        }

    async def fix_links_for_uuid(self, target_uuid: str) -> dict[str, Any]:
        """Fix broken_link and raw [[uuid]] references pointing to a specific UUID."""
        from app.logging_config import get_logger

        logger = get_logger(__name__)

        uuid_re_full = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
        if not re.match(uuid_re_full, target_uuid, re.IGNORECASE):
            raise NodeValidationError(f"Invalid UUID format: {target_uuid}")

        target_uuid_lower = target_uuid.lower()

        uuid_re_fragment = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        uuid_pattern = re.compile(
            rf"(?:\[(?P<label>[^\]]+)\]\(\[\[(?P<uuid_labeled>{uuid_re_fragment})\]\]\)|\[\[(?P<uuid_bare>{uuid_re_fragment})\]\])",
            re.IGNORECASE,
        )

        def _extract_uuid_and_label(match: re.Match) -> tuple[str, str | None]:
            if match.group("uuid_labeled"):
                return match.group("uuid_labeled").lower(), match.group("label") or None
            return match.group("uuid_bare").lower(), None

        def transform_text_node(text_value: str) -> list[dict[str, Any]]:
            parts: list[dict[str, Any]] = []
            last_end = 0

            for match in uuid_pattern.finditer(text_value):
                ref_uuid, label = _extract_uuid_and_label(match)
                if ref_uuid != target_uuid_lower:
                    continue

                before = text_value[last_end : match.start()]
                if before:
                    parts.append({"type": "text", "text": before})

                link_uuid = str(uuid_module.uuid4())
                link_id = f"{target_uuid_lower}:{link_uuid}"
                node_link: dict[str, Any] = {
                    "type": "node_link",
                    "link_id": link_id,
                    "ref_type": "node",
                }
                if label:
                    node_link["label"] = label
                parts.append(node_link)

                last_end = match.end()

            if last_end < len(text_value):
                remaining = text_value[last_end:]
                if remaining:
                    parts.append({"type": "text", "text": remaining})

            return parts

        def walk_and_transform(nodes: list[Any]) -> tuple[list[Any], int]:
            converted = 0
            new_nodes: list[Any] = []

            for node in nodes:
                if not isinstance(node, dict):
                    new_nodes.append(node)
                    continue

                node_type = node.get("type")
                if node_type == "broken_link":
                    link_id = node.get("link_id", "")
                    colon_idx = link_id.find(":")
                    node_uuid = link_id[:colon_idx].lower() if colon_idx > 0 else link_id.lower()
                    if node_uuid == target_uuid_lower:
                        new_link_uuid = str(uuid_module.uuid4())
                        new_link_id = f"{node_uuid}:{new_link_uuid}"
                        new_node = {
                            **node,
                            "type": "node_link",
                            "ref_type": "node",
                            "link_id": new_link_id,
                        }
                        new_nodes.append(new_node)
                        converted += 1
                        continue
                    new_nodes.append(node)
                elif node_type == "text":
                    text_val = node.get("text", "")
                    if "[[" in text_val and uuid_pattern.search(text_val):
                        replacement = transform_text_node(text_val)
                        if replacement and replacement != [node]:
                            link_count = sum(
                                1 for r in replacement if isinstance(r, dict) and r.get("type") == "node_link"
                            )
                            if link_count > 0:
                                new_nodes.extend(replacement)
                                converted += link_count
                                continue
                    new_nodes.append(node)
                elif "children" in node:
                    child_nodes, child_converted = walk_and_transform(node["children"])
                    new_node = {**node, "children": child_nodes}
                    new_nodes.append(new_node)
                    converted += child_converted
                else:
                    new_nodes.append(node)

            return new_nodes, converted

        patterns = [f'%"{target_uuid_lower}"%', f"%[[{target_uuid_lower}]]%"]
        candidate_rows = await self._node_repo.find_active_nodes_by_name_patterns(patterns)

        logger.info(
            f"[FIX_LINKS_FOR_UUID] Found {len(candidate_rows)} candidate nodes for UUID {target_uuid_lower}"
        )

        nodes_fixed = 0
        links_converted = 0
        errors: list[str] = []

        for row in candidate_rows:
            node_id = row["id"]
            content = row["name"]

            if not content:
                continue

            try:
                ast = json.loads(content)
                if not isinstance(ast, list):
                    continue
                if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            try:
                new_ast, converted = walk_and_transform(ast)

                if converted > 0:
                    new_content = json.dumps(new_ast, ensure_ascii=False)
                    await self._node_repo.update(node_id, NodeUpdateData(name=new_content))

                    await self.update_node_links(node_id, new_content)
                    await self.update_inline_classes(node_id, new_content)

                    nodes_fixed += 1
                    links_converted += converted
            except Exception as e:
                error_msg = f"Node {node_id}: {str(e)}"
                errors.append(error_msg)
                logger.warning(f"[FIX_LINKS_FOR_UUID] Error processing node {node_id}: {e}")
                continue

        logger.info(
            f"[FIX_LINKS_FOR_UUID] Completed for {target_uuid_lower}: {nodes_fixed} nodes fixed, "
            f"{links_converted} links converted, {len(errors)} errors"
        )

        return {
            "success": True,
            "target_uuid": target_uuid_lower,
            "nodes_fixed": nodes_fixed,
            "links_converted": links_converted,
            "errors": errors[:50],
            "total_errors": len(errors),
        }
