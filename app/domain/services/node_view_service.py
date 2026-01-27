"""NodeView service for managing dynamic query views.

Handles creation of default NodeViews when pages are created.
"""
from __future__ import annotations

import json
from typing import Optional, List, Dict, Any

from ..entities import NodeView, generate_uuid
from ..repositories import PostgresNodeViewRepository
from ...db.schema.constants import (
    DEFAULT_VIEW_CLASSES, 
    DEFAULT_QUERY_BLOCK_TREE,
)
from ...logging_config import get_logger

logger = get_logger(__name__)


# Default view configurations with initial block trees
DEFAULT_VIEW_CONFIGS: Dict[str, Dict[str, Any]] = {
    "child_pages": {
        "name": "All Pages",
        "block_tree": {
            "type": "AND_CONTAINER",
            "blocks": [
                {
                    "type": "ANCESTOR_PATH",
                    "blocks": [
                        {"type": "UUID", "value": "{current_node_uuid}"}
                    ],
                    "max_depth": 1
                },
                {
                    "type": "TYPE",
                    "value": "page"
                }
            ]
        }
    },
    "typed_nodes": {
        "name": "Typed Items",
        "block_tree": {
            "type": "AND_CONTAINER",
            "blocks": [
                {
                    "type": "REFERENCE",
                    "target_uuid": "{current_node_uuid}",
                }
            ]
        }
    },
    "linked_references": {
        "name": "All References",
        "block_tree": {
            "type": "AND_CONTAINER",
            "blocks": [
                {
                    "type": "REFERENCE",
                    "target_uuid": "{current_node_uuid}",
                }
            ]
        }
    },
    "main_content": {
        "name": "Content",
        "block_tree": {
            "type": "AND_CONTAINER",
            "blocks": [
                {
                    "type": "ANCESTOR_PATH",
                    "blocks": [
                        {"type": "UUID", "value": "{current_node_uuid}"}
                    ],
                    "max_depth": 1  # Direct children only
                }
            ]
        }
    },
    "all_pages": {
        "name": "All Pages",
        "block_tree": {
            "type": "AND_CONTAINER",
            "blocks": [
                {
                    "type": "TYPE",
                    "value": "page"
                },
                {
                    "type": "PROPERTY",
                    "property_name": "parent_id",
                    "operator": "is_empty",
                    "value": None
                }
            ]
        }
    },
}


class NodeViewService:
    """Service for managing NodeViews."""
    
    def __init__(
        self,
        pool,
        graph_id: int,
        user_id: Optional[str] = None,
    ):
        """Initialize the NodeView service.
        
        Args:
            pool: asyncpg connection pool
            graph_id: Current graph ID
            user_id: Current user ID (string) for audit
        """
        self._pool = pool
        self._graph_id = graph_id
        self._user_id = user_id
        self._view_repo = PostgresNodeViewRepository(pool, graph_id, user_id)
    
    async def create_default_views(self, node_id: int, view_types: Optional[List[str]] = None) -> List[NodeView]:
        """Create default NodeViews for a node.
        
        Args:
            node_id: The node to create views for
            view_types: Optional list of view types to create (defaults to DEFAULT_VIEW_CLASSES)
            
        Returns:
            List of created NodeViews
        """
        if view_types is None:
            view_types = DEFAULT_VIEW_CLASSES
        
        created_views = []
        
        for view_type in view_types:
            config = DEFAULT_VIEW_CONFIGS.get(view_type, {
                "name": view_type.replace("_", " ").title(),
                "block_tree": DEFAULT_QUERY_BLOCK_TREE.copy(),
            })
            
            try:
                view = await self._view_repo.create(
                    node_id=node_id,
                    name=config["name"],
                    view_type=view_type,
                    query_json=config["block_tree"],
                    order_index=0,
                    is_default=True,
                )
                created_views.append(view)
            except Exception as e:
                logger.error(f"Failed to create default view '{view_type}' for node {node_id}: {e}")
        
        return created_views
    
    async def get_views_for_node(
        self,
        node_id: int,
        view_type: Optional[str] = None,
    ) -> List[NodeView]:
        """Get NodeViews for a node.
        
        Args:
            node_id: The node ID
            view_type: Optional filter by view_type
            
        Returns:
            List of NodeViews
        """
        return await self._view_repo.list_by_node(node_id, view_type=view_type)
    
    async def ensure_default_views(self, node_id: int) -> List[NodeView]:
        """Ensure a node has default views, creating them if needed.
        
        This is idempotent - it only creates views for view_types that don't exist.
        
        Args:
            node_id: The node ID
            
        Returns:
            List of all NodeViews for the node
        """
        existing_views = await self._view_repo.list_by_node(node_id)
        existing_types = {v.view_type for v in existing_views}
        
        # Create missing default views
        missing_types = [vt for vt in DEFAULT_VIEW_CLASSES if vt not in existing_types]
        
        if missing_types:
            await self.create_default_views(node_id, view_types=missing_types)
        
        # Return all views
        return await self._view_repo.list_by_node(node_id)
