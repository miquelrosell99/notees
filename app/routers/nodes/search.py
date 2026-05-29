"""Search, list, and workspace endpoints for nodes."""

from fastapi import APIRouter, Depends, HTTPException, Query

from ...db.connection import acquire_connection
from ...db.schema.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PAGE_UUIDS
from ...models import PaginatedResponse, User
from ..auth import get_current_user
from .helpers import (
    _build_children_tree,
    _get_class_ids_batch,
    _get_node_service,
    _node_to_response,
)
from .models import NodeResponse

router = APIRouter()


@router.get("/workspace")
async def get_workspace_data_endpoint(
    user: User = Depends(get_current_user),
):
    """Get workspace data for visualization with nodes and links.

    Returns all pages as nodes and links between them based on node_link table.
    """
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        # System type UUIDs to exclude from workspace view
        excluded_uuids = [
            SYSTEM_CLASS_UUIDS["page"],
            SYSTEM_CLASS_UUIDS["class"],
            *SYSTEM_PAGE_UUIDS.values(),
        ]

        # Get all active pages as nodes (excluding system types)
        page_rows = await conn.fetch(
            """
            SELECT id, uuid, name, icon, is_class, is_day, is_month, is_year
            FROM node
            WHERE workspace_id = $1 AND is_page = TRUE AND active = TRUE
              AND uuid::text NOT IN (SELECT unnest($2::text[]))
            ORDER BY name
            """,
            service.workspace_id,
            excluded_uuids,
        )

        # Get types for each page
        page_ids = [row["id"] for row in page_rows]
        class_ids_map = (
            await _get_class_ids_batch(service.pool, service.workspace_id or 0, page_ids, conn=conn) if page_ids else {}
        )

        # Get block counts per page (recursive, excludes child pages and their hierarchies)
        block_count_map = {}
        if page_ids:
            block_count_rows = await conn.fetch(
                """
                SELECT page_id, COUNT(*) as block_count
                FROM node
                WHERE workspace_id = $1 AND is_page = FALSE AND active = TRUE AND page_id IS NOT NULL
                GROUP BY page_id
                """,
                service.workspace_id,
            )
            block_count_map = {row["page_id"]: row["block_count"] for row in block_count_rows}

        # Build nodes
        nodes = []
        for row in page_rows:
            node_class_ids = class_ids_map.get(row["id"], [])
            nodes.append(
                {
                    "id": row["id"],
                    "uuid": str(row["uuid"]),
                    "name": row["name"],
                    "icon": row["icon"],
                    "is_class": row["is_class"],
                    "is_daily": row["is_day"],
                    "is_monthly": row["is_month"],
                    "is_yearly": row["is_year"],
                    "class_ids": node_class_ids,
                    "block_count": block_count_map.get(row["id"], 0),
                }
            )

        # Get reference links between pages (only page-to-page links)
        link_rows = await conn.fetch(
            """
            SELECT DISTINCT nl.source_id, nl.target_id
            FROM node_link nl
            JOIN node source ON nl.source_id = source.id
            JOIN node target ON nl.target_id = target.id
            WHERE source.workspace_id = $1
              AND target.workspace_id = $1
              AND target.is_page = TRUE
              AND source.active = TRUE
              AND target.active = TRUE
            """,
            service.workspace_id,
        )

        # Build reference links - source is the page containing the block that links
        links = []
        page_id_set = {row["id"] for row in page_rows}

        # Batch-resolve block sources to their page_id (avoid N+1 queries)
        block_source_ids = [row["source_id"] for row in link_rows if row["source_id"] not in page_id_set]
        block_to_page = {}
        if block_source_ids:
            # Fetch all block→page mappings in one query
            block_rows = await conn.fetch("SELECT id, page_id FROM node WHERE id = ANY($1::int[])", block_source_ids)
            for br in block_rows:
                if br["page_id"]:
                    block_to_page[br["id"]] = br["page_id"]

        for row in link_rows:
            source_id = row["source_id"]
            target_id = row["target_id"]

            # Get the source page (may be the block's page_id)
            source_page_id = source_id
            if source_id not in page_id_set:
                source_page_id = block_to_page.get(source_id, source_id)

            if source_page_id in page_id_set and target_id in page_id_set:
                links.append(
                    {
                        "source": source_page_id,
                        "target": target_id,
                        "type": "reference",
                    }
                )

        # Get parent relationships between pages
        parent_rows = await conn.fetch(
            """
            SELECT child.id as child_id, parent.id as parent_id
            FROM node child
            JOIN node parent ON child.parent_id = parent.id
            WHERE child.workspace_id = $1
              AND child.is_page = TRUE
              AND parent.is_page = TRUE
              AND child.active = TRUE
              AND parent.active = TRUE
            """,
            service.workspace_id,
        )

        for row in parent_rows:
            child_id = row["child_id"]
            parent_id = row["parent_id"]
            if child_id in page_id_set and parent_id in page_id_set:
                links.append(
                    {
                        "source": parent_id,
                        "target": child_id,
                        "type": "parent",
                    }
                )

        # Get class relationships from node.class_ids field
        # Create links from node to its assigned classes (types)
        for row in page_rows:
            node_id = row["id"]
            node_class_ids = class_ids_map.get(node_id, [])
            for class_id in node_class_ids:
                # Only add link if the class is also a visible page node
                if class_id in page_id_set:
                    links.append(
                        {
                            "source": node_id,
                            "target": class_id,
                            "type": "class",
                        }
                    )

        # Get class extends relationships (inheritance between classes)
        class_extends_rows = await conn.fetch(
            """
            SELECT ce.target_id as child_id, ce.source_id as parent_id
            FROM class_extend ce
            JOIN node child ON ce.target_id = child.id
            JOIN node parent ON ce.source_id = parent.id
            WHERE child.workspace_id = $1
              AND parent.workspace_id = $1
              AND child.active = TRUE
              AND parent.active = TRUE
            """,
            service.workspace_id,
        )

        for row in class_extends_rows:
            child_id = row["child_id"]
            parent_id = row["parent_id"]
            if child_id in page_id_set and parent_id in page_id_set:
                links.append(
                    {
                        "source": child_id,
                        "target": parent_id,
                        "type": "extends",  # New type specifically for class inheritance
                    }
                )

        # Get property-based links (node-type properties)
        property_link_rows = await conn.fetch(
            """
            SELECT DISTINCT pvr.node_id, pvr.target_id
            FROM property_value_relation pvr
            JOIN node source ON pvr.node_id = source.id
            JOIN node target ON pvr.target_id = target.id
            WHERE source.workspace_id = $1
              AND target.workspace_id = $1
              AND source.is_page = TRUE
              AND target.is_page = TRUE
              AND source.active = TRUE
              AND target.active = TRUE
            """,
            service.workspace_id,
        )

        for row in property_link_rows:
            source_id = row["node_id"]
            target_id = row["target_id"]
            if source_id in page_id_set and target_id in page_id_set:
                links.append(
                    {
                        "source": source_id,
                        "target": target_id,
                        "type": "property-reference",
                    }
                )

        # Remove duplicate links (keeping first occurrence)
        seen = set()
        unique_links = []
        for link in links:
            key = (link["source"], link["target"], link["type"])
            if key not in seen:
                seen.add(key)
                unique_links.append(link)

        return {"nodes": nodes, "links": unique_links}


@router.get("/workspace/nodes")
async def get_workspace_nodes_endpoint(
    user: User = Depends(get_current_user),
):
    """Get all workspace nodes for visualization (without links).

    Returns the same nodes as /workspace but omits the links payload,
    making it significantly lighter for cases where the caller fetches
    links separately via POST /links.
    """
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        excluded_uuids = [
            SYSTEM_CLASS_UUIDS["page"],
            SYSTEM_CLASS_UUIDS["class"],
            *SYSTEM_PAGE_UUIDS.values(),
        ]

        page_rows = await conn.fetch(
            """
            SELECT id, uuid, name, icon, is_class, is_day, is_month, is_year
            FROM node
            WHERE workspace_id = $1 AND is_page = TRUE AND active = TRUE
              AND uuid::text NOT IN (SELECT unnest($2::text[]))
            ORDER BY name
            """,
            service.workspace_id,
            excluded_uuids,
        )

        page_ids = [row["id"] for row in page_rows]
        class_ids_map = (
            await _get_class_ids_batch(service.pool, service.workspace_id or 0, page_ids, conn=conn) if page_ids else {}
        )

        # Get block counts per page (recursive, excludes child pages and their hierarchies)
        block_count_map = {}
        if page_ids:
            block_count_rows = await conn.fetch(
                """
                SELECT page_id, COUNT(*) as block_count
                FROM node
                WHERE workspace_id = $1 AND is_page = FALSE AND active = TRUE AND page_id IS NOT NULL
                GROUP BY page_id
                """,
                service.workspace_id,
            )
            block_count_map = {row["page_id"]: row["block_count"] for row in block_count_rows}

        nodes = []
        for row in page_rows:
            node_class_ids = class_ids_map.get(row["id"], [])
            nodes.append(
                {
                    "id": row["id"],
                    "uuid": str(row["uuid"]),
                    "name": row["name"],
                    "icon": row["icon"],
                    "is_class": row["is_class"],
                    "is_daily": row["is_day"],
                    "is_monthly": row["is_month"],
                    "is_yearly": row["is_year"],
                    "class_ids": node_class_ids,
                    "block_count": block_count_map.get(row["id"], 0),
                }
            )

        return {"nodes": nodes}


@router.post("/links")
async def get_links_for_nodes(
    body: dict,
    user: User = Depends(get_current_user),
):
    """Get links for a specific set of node IDs.

    Accepts {"node_ids": [1, 2, 3, ...], "scope": "between" | "touching",
             "cooccurrence": true | false, "context_node_id": id | null}
    and returns links (reference, parent, class, extends, property-reference, cooccurrence).

    Scopes:
      - "between" (default): only links where BOTH source and target are in the set.
        Use for rendering a graph of known nodes.
      - "touching": links where AT LEAST ONE end is in the set.
        Use for discovering connections from a starting set of nodes.

    Co-occurrence:
      - Without context_node_id: global flat co-occurrence across all blocks mentioning the node set.
      - With context_node_id: parent-inclusive co-occurrence within the context page.
    """
    node_ids = body.get("node_ids", [])
    scope = body.get("scope", "between")
    cooccurrence = body.get("cooccurrence", False)
    if not node_ids or not isinstance(node_ids, list):
        return {"links": []}
    if scope not in ("between", "touching"):
        raise HTTPException(status_code=400, detail="scope must be 'between' or 'touching'")

    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        node_id_set = set(node_ids)
        require_both = scope == "between"
        links = []

        # 1. Reference links (from node_link table, resolving blocks to pages)
        link_rows = await conn.fetch(
            """
            SELECT DISTINCT nl.source_id, nl.target_id
            FROM node_link nl
            JOIN node source ON nl.source_id = source.id
            JOIN node target ON nl.target_id = target.id
            WHERE source.workspace_id = $1
              AND target.workspace_id = $1
              AND target.is_page = TRUE
              AND source.active = TRUE
              AND target.active = TRUE
              AND (nl.source_id = ANY($2::int[]) OR nl.target_id = ANY($2::int[]))
            """,
            service.workspace_id,
            node_ids,
        )

        # Batch-resolve block sources to their page_id
        block_source_ids = [row["source_id"] for row in link_rows if row["source_id"] not in node_id_set]
        block_to_page = {}
        if block_source_ids:
            block_rows = await conn.fetch("SELECT id, page_id FROM node WHERE id = ANY($1::int[])", block_source_ids)
            for br in block_rows:
                if br["page_id"]:
                    block_to_page[br["id"]] = br["page_id"]

        for row in link_rows:
            source_page_id = row["source_id"]
            if source_page_id not in node_id_set:
                source_page_id = block_to_page.get(source_page_id, source_page_id)
            target_id = row["target_id"]
            if require_both:
                if source_page_id in node_id_set and target_id in node_id_set:
                    links.append({"source": source_page_id, "target": target_id, "type": "reference"})
            else:
                # touching: at least one end is in the set
                if source_page_id in node_id_set or target_id in node_id_set:
                    links.append({"source": source_page_id, "target": target_id, "type": "reference"})

        # 2. Parent relationships
        if require_both:
            parent_rows = await conn.fetch(
                """
                SELECT child.id as child_id, parent.id as parent_id
                FROM node child
                JOIN node parent ON child.parent_id = parent.id
                WHERE child.workspace_id = $1
                  AND child.is_page = TRUE
                  AND parent.is_page = TRUE
                  AND child.active = TRUE
                  AND parent.active = TRUE
                  AND child.id = ANY($2::int[])
                  AND parent.id = ANY($2::int[])
                """,
                service.workspace_id,
                node_ids,
            )
        else:
            parent_rows = await conn.fetch(
                """
                SELECT child.id as child_id, parent.id as parent_id
                FROM node child
                JOIN node parent ON child.parent_id = parent.id
                WHERE child.workspace_id = $1
                  AND child.is_page = TRUE
                  AND parent.is_page = TRUE
                  AND child.active = TRUE
                  AND parent.active = TRUE
                  AND (child.id = ANY($2::int[]) OR parent.id = ANY($2::int[]))
                """,
                service.workspace_id,
                node_ids,
            )
        for row in parent_rows:
            links.append({"source": row["parent_id"], "target": row["child_id"], "type": "parent"})

        # 3. Class relationships
        class_ids_map = await _get_class_ids_batch(service.pool, service.workspace_id or 0, node_ids, conn=conn)
        for nid in node_ids:
            for class_id in class_ids_map.get(nid, []):
                if not require_both or class_id in node_id_set:
                    links.append({"source": nid, "target": class_id, "type": "class"})

        # 4. Class extends (inheritance)
        if require_both:
            class_extends_rows = await conn.fetch(
                """
                SELECT ce.target_id as child_id, ce.source_id as parent_id
                FROM class_extend ce
                JOIN node child ON ce.target_id = child.id
                JOIN node parent ON ce.source_id = parent.id
                WHERE child.workspace_id = $1
                  AND parent.workspace_id = $1
                  AND child.active = TRUE
                  AND parent.active = TRUE
                  AND ce.target_id = ANY($2::int[])
                  AND ce.source_id = ANY($2::int[])
                """,
                service.workspace_id,
                node_ids,
            )
        else:
            class_extends_rows = await conn.fetch(
                """
                SELECT ce.target_id as child_id, ce.source_id as parent_id
                FROM class_extend ce
                JOIN node child ON ce.target_id = child.id
                JOIN node parent ON ce.source_id = parent.id
                WHERE child.workspace_id = $1
                  AND parent.workspace_id = $1
                  AND child.active = TRUE
                  AND parent.active = TRUE
                  AND (ce.target_id = ANY($2::int[]) OR ce.source_id = ANY($2::int[]))
                """,
                service.workspace_id,
                node_ids,
            )
        for row in class_extends_rows:
            links.append({"source": row["child_id"], "target": row["parent_id"], "type": "extends"})

        # 5. Property-based links
        if require_both:
            property_link_rows = await conn.fetch(
                """
                SELECT DISTINCT pvr.node_id, pvr.target_id
                FROM property_value_relation pvr
                JOIN node source ON pvr.node_id = source.id
                JOIN node target ON pvr.target_id = target.id
                WHERE source.workspace_id = $1
                  AND target.workspace_id = $1
                  AND source.is_page = TRUE
                  AND target.is_page = TRUE
                  AND source.active = TRUE
                  AND target.active = TRUE
                  AND pvr.node_id = ANY($2::int[])
                  AND pvr.target_id = ANY($2::int[])
                """,
                service.workspace_id,
                node_ids,
            )
        else:
            property_link_rows = await conn.fetch(
                """
                SELECT DISTINCT pvr.node_id, pvr.target_id
                FROM property_value_relation pvr
                JOIN node source ON pvr.node_id = source.id
                JOIN node target ON pvr.target_id = target.id
                WHERE source.workspace_id = $1
                  AND target.workspace_id = $1
                  AND source.is_page = TRUE
                  AND target.is_page = TRUE
                  AND source.active = TRUE
                  AND target.active = TRUE
                  AND (pvr.node_id = ANY($2::int[]) OR pvr.target_id = ANY($2::int[]))
                """,
                service.workspace_id,
                node_ids,
            )
        for row in property_link_rows:
            links.append({"source": row["node_id"], "target": row["target_id"], "type": "property-reference"})

        # 6. Co-occurrence inference: links from blocks with multiple page references
        if cooccurrence:
            context_node_id = body.get("context_node_id")
            from collections import Counter, defaultdict

            if context_node_id:
                # Local/context mode: parent-inclusive co-occurrence within context page
                block_rows = await conn.fetch(
                    """
                    SELECT id, parent_id FROM node
                    WHERE workspace_id = $1 AND is_page = FALSE AND active = TRUE AND page_id = $2
                    """,
                    service.workspace_id,
                    context_node_id,
                )
                block_ids = [r["id"] for r in block_rows]
                parent_map = {r["id"]: r["parent_id"] for r in block_rows}

                if block_ids:
                    link_rows = await conn.fetch(
                        """
                        SELECT nl.source_id AS block_id, nl.target_id
                        FROM node_link nl
                        WHERE nl.source_id = ANY($1::int[]) AND nl.target_id = ANY($2::int[])
                        """,
                        block_ids,
                        node_ids,
                    )

                    block_targets: dict = defaultdict(list)
                    for row in link_rows:
                        block_targets[row["block_id"]].append(row["target_id"])

                    parent_ids = list({p for p in parent_map.values() if p is not None})
                    if parent_ids:
                        parent_link_rows = await conn.fetch(
                            """
                            SELECT nl.source_id AS block_id, nl.target_id
                            FROM node_link nl
                            WHERE nl.source_id = ANY($1::int[]) AND nl.target_id = ANY($2::int[])
                            """,
                            parent_ids,
                            node_ids,
                        )
                        parent_targets: dict = defaultdict(list)
                        for row in parent_link_rows:
                            parent_targets[row["block_id"]].append(row["target_id"])

                        for block_id, parent_id in parent_map.items():
                            if parent_id in parent_targets:
                                block_targets[block_id].extend(parent_targets[parent_id])

                    pair_counts = Counter()
                    for _block_id, targets in block_targets.items():
                        unique_targets = list(dict.fromkeys(targets))[:10]
                        if len(unique_targets) < 2:
                            continue
                        for i in range(len(unique_targets)):
                            for j in range(i + 1, len(unique_targets)):
                                a, b = unique_targets[i], unique_targets[j]
                                pair_counts[(a, b)] += 1

                    for (a, b), count in pair_counts.items():
                        links.append({"source": a, "target": b, "type": "cooccurrence", "weight": count})
            else:
                # Global mode: flat co-occurrence across all blocks mentioning the node set
                sem_rows = await conn.fetch(
                    """
                    SELECT nl.source_id AS block_id, nl.target_id AS target_page_id
                    FROM node_link nl
                    JOIN node block ON nl.source_id = block.id
                    JOIN node target ON nl.target_id = target.id
                    WHERE block.workspace_id = $1
                      AND block.is_page = FALSE
                      AND block.active = TRUE
                      AND target.active = TRUE
                      AND target.is_page = TRUE
                      AND nl.target_id = ANY($2::int[])
                    """,
                    service.workspace_id,
                    node_ids,
                )
                block_targets: dict = defaultdict(list)
                for row in sem_rows:
                    block_targets[row["block_id"]].append(row["target_page_id"])

                pair_counts = Counter()
                for _block_id, targets in block_targets.items():
                    unique_targets = list(dict.fromkeys(targets))[:10]
                    if len(unique_targets) < 2:
                        continue
                    for i in range(len(unique_targets)):
                        for j in range(i + 1, len(unique_targets)):
                            a, b = unique_targets[i], unique_targets[j]
                            pair_counts[(a, b)] += 1

                for (a, b), count in pair_counts.items():
                    links.append({"source": a, "target": b, "type": "cooccurrence", "weight": count})

        # Deduplicate
        seen = set()
        unique_links = []
        for link in links:
            key = (link["source"], link["target"], link["type"])
            if key not in seen:
                seen.add(key)
                unique_links.append(link)

        return {"links": unique_links}


@router.get("/search")
async def search_nodes(
    q: str = "",
    limit: int = 50,
    class_filters: str | None = None,  # Comma-separated class IDs to filter by
    uuid: str | None = None,  # Direct UUID lookup (prefix match)
    is_page: bool | None = None,  # Filter by is_page flag
    is_class: bool | None = None,  # Filter by is_class flag
    is_daily: bool | None = None,  # Filter by is_day flag
    user: User = Depends(get_current_user),
):
    """Search nodes by name, UUID, or filtered by properties.

    Args:
        q: Search query (name search)
        limit: Maximum number of results (capped at 5000)
        class_filters: Optional comma-separated list of class IDs to filter results
        uuid: Optional UUID prefix to search by (exact or prefix match)
        is_page: Optional boolean to filter pages vs blocks
        is_class: Optional boolean to filter class definitions
        is_daily: Optional boolean to filter daily notes

    Returns nodes with class_ids populated for reliable filtering.
    """
    limit = min(limit, 5000)  # prevent runaway queries
    service = await _get_node_service(user)

    # UUID search: direct lookup by UUID (exact match first, then prefix)
    if uuid:
        uuid = uuid.strip()
        if uuid:
            # Try exact match first
            node = await service.get_node_by_uuid(uuid)
            if node and node.id is not None:
                node_class_ids = node.class_ids or []
                return {"nodes": [_node_to_response(node, classes=node_class_ids)]}

            # Fall back to prefix match (uuid starts with the search term)
            if len(uuid) >= 4:  # Require at least 4 chars for prefix search
                async with acquire_connection(service.pool) as conn:
                    rows = await conn.fetch(
                        """SELECT n.* FROM node n
                        WHERE n.workspace_id = $1 AND n.active = TRUE AND n.is_deleted = FALSE
                          AND n.uuid::text LIKE $2
                        ORDER BY n.write_date DESC NULLS LAST
                        LIMIT $3""",
                        service.workspace_id,
                        uuid + "%",
                        min(limit, 20),
                    )
                    result = []
                    for row in rows:
                        node_obj = service.row_to_node(row)
                        node_class_ids = node_obj.class_ids or []
                        result.append(_node_to_response(node_obj, classes=node_class_ids))
                    return {"nodes": result}

            return {"nodes": []}

    nodes = await service.search(q, limit)

    # Parse class filters if provided
    filter_class_ids: set | None = None
    if class_filters:
        try:
            filter_class_ids = {int(cid.strip()) for cid in class_filters.split(",") if cid.strip()}
        except ValueError:
            pass

    # Build response with filters applied
    result = []
    for n in nodes:
        if n.id is None:
            continue
        node_class_ids = n.class_ids or []

        # Apply class filter if specified
        if filter_class_ids:
            if not filter_class_ids.intersection(node_class_ids):
                continue

        # Apply boolean filters
        if is_page is not None and n.is_page != is_page:
            continue
        if is_class is not None and n.is_class != is_class:
            continue
        if is_daily is not None and n.is_day != is_daily:
            continue

        result.append(_node_to_response(n, classes=node_class_ids))

    return {"nodes": result}


@router.get("/", name="list_nodes")
async def list_nodes(
    pages_only: bool = False,
    parent_id: int | None = None,
    type_id: int | None = None,
    class_filters: str | None = None,  # Comma-separated class IDs to filter by
    include_children: bool = False,
    root_only: bool = False,  # Only return nodes with no parent
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int | None = Query(None, ge=1, description="Items per page (omit to return all)"),
    user: User = Depends(get_current_user),
):
    """List nodes with optional filters and pagination.

    Args:
        pages_only: Only return pages (no blocks)
        parent_id: Only return children of this node
        type_id: Only return nodes with this type
        class_filters: Additional comma-separated class IDs to filter by
        include_children: Include nested children for each node
        root_only: Only return root nodes (no parent_id)
        page: Page number (1-indexed)
        page_size: Number of items per page, or omit to disable pagination

    Returns paginated nodes with class_ids populated for reliable filtering.
    When page_size is omitted, all matching nodes are returned.
    """
    service = await _get_node_service(user)

    if parent_id:
        nodes = await service.get_node_children(parent_id)
    elif type_id:
        nodes = await service.get_nodes_typed_with(type_id)
    elif pages_only:
        nodes = await service.get_all_pages()
    else:
        nodes = await service.search("", limit=10000)  # Get all for filtering

    # Parse class filters if provided
    filter_class_ids: set | None = None
    if class_filters:
        try:
            filter_class_ids = {int(cid.strip()) for cid in class_filters.split(",") if cid.strip()}
        except ValueError:
            pass

    # Batch fetch class_ids for all nodes
    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(service.pool, service.workspace_id or 0, node_ids)

    # Filter to root nodes if requested
    if root_only:
        nodes = [n for n in nodes if n.parent_id is None]

    # Build response, optionally filtering by classes
    result = []
    for n in nodes:
        if n.id is None:
            continue
        node_class_ids = class_ids_map.get(n.id, [])

        # Apply class filter if specified
        if filter_class_ids:
            if not filter_class_ids.intersection(node_class_ids):
                continue

        result.append(_node_to_response(n, classes=node_class_ids))

    # Include children if requested (recursive tree building)
    if include_children and result:
        result = await _build_children_tree(service, result, class_ids_map)

    # Apply pagination only when page_size is requested
    total = len(result)
    if page_size is not None:
        offset = (page - 1) * page_size
        paginated_items = result[offset : offset + page_size]
        has_next = (page * page_size) < total
        has_prev = page > 1
        effective_page_size = page_size
    else:
        paginated_items = result
        has_next = False
        has_prev = False
        effective_page_size = total

    return PaginatedResponse[NodeResponse](
        items=paginated_items,
        total=total,
        page=page,
        page_size=effective_page_size,
        has_next=has_next,
        has_prev=has_prev,
    )
