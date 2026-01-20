"""Graph data operations for knowledge graph visualization."""
import re
from typing import Any, Dict, List

from ..logging_config import logger
from .connection import get_db


async def get_graph_data(user_id: str) -> Dict[str, Any]:
    """Get data for knowledge graph visualization."""
    db = await get_db(user_id)

    try:
        # Get all active nodes with create_date
        cursor = await db.execute("""
            SELECT id, name, parent_id, page_id, is_page, is_day, is_month, is_year, create_date
            FROM node 
            WHERE active = 1
        """)
        all_nodes_raw = await cursor.fetchall()
        
        # Get types property id from the property table
        types_cursor = await db.execute("""
            SELECT id FROM property WHERE name = 'types' LIMIT 1
        """)
        types_row = await types_cursor.fetchone()
        types_property_id = types_row['id'] if types_row else None
        
        # Get all type assignments if we have a types property
        node_types_map: Dict[int, List[int]] = {}
        if types_property_id:
            type_cursor = await db.execute("""
                SELECT node_id, target_node_id 
                FROM property_value_relation 
                WHERE property_id = ? AND target_node_id IS NOT NULL
            """, (types_property_id,))
            type_rows = await type_cursor.fetchall()
            for row in type_rows:
                node_id = row['node_id']
                type_id = row['target_node_id']
                if node_id not in node_types_map:
                    node_types_map[node_id] = []
                node_types_map[node_id].append(type_id)
        
        pages = []
        blocks = []
        
        for row in all_nodes_raw:
            node = dict(row)
            
            # Use boolean flags from schema
            is_page = bool(node.get('is_page', 0))
            node['is_daily'] = bool(node.get('is_day', 0))

            if is_page:
                pages.append(node)
            else:
                blocks.append(node)
        
        # Build nodes and links
        nodes = []
        links = []
        page_map = {}
        
        for page in pages:
            title = page.get("name") or "Untitled"
            page_map[title] = page["id"]
            
            nodes.append({
                "id": page["id"],
                "title": title,
                "type": "page",
                "is_daily": page["is_daily"],
                "types": node_types_map.get(page["id"], []),
                "created_at": page.get("create_date"),
                "backlink_count": 0,  # Will be updated after link building
                "internal_link_count": 0,  # Will be updated after link building
            })
            
            # Parent link for nested pages
            if page.get("parent_id"):
                 # Only link if parent is also a page in our set
                 if any(p['id'] == page['parent_id'] for p in pages):
                    links.append({
                        "source": page["parent_id"],
                        "target": page["id"],
                        "type": "parent"
                    })
        
        # Find @ page links in all nodes
        link_pattern = re.compile(r'@\[\[([^\]]+)\]\]|@(\w+)')
        link_set = set()
        
        for node in pages + blocks:
            content = node.get("name") or ""
            matches = link_pattern.findall(content)
            
            # Determine source page
            source_page_id = None
            if node in pages:
                source_page_id = node['id']
            else:
                # Use page_id column if available
                source_page_id = node.get('page_id')
                # If page_id missing, we skip linking for this block as graph usually works on page level
            
            if not source_page_id:
                continue

            for match_groups in matches:
                match = match_groups[0] or match_groups[1]
                if match in page_map:
                    target_page_id = page_map[match]
                    
                    if source_page_id != target_page_id:
                        link_key = f"{source_page_id}-{target_page_id}"
                        if link_key not in link_set:
                            link_set.add(link_key)
                            links.append({
                                "source": source_page_id,
                                "target": target_page_id,
                                "type": "reference"
                            })
        
        # Calculate link counts for each node
        # backlink_count = number of incoming reference links
        # internal_link_count = number of outgoing reference links
        node_map = {n["id"]: n for n in nodes}
        for link in links:
            if link["type"] == "reference":
                # Target gets a backlink
                if link["target"] in node_map:
                    node_map[link["target"]]["backlink_count"] += 1
                # Source has an internal link
                if link["source"] in node_map:
                    node_map[link["source"]]["internal_link_count"] += 1
        
        return {"nodes": nodes, "links": links}
    finally:
        await db.close()
