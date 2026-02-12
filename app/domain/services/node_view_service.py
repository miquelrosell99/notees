"""NodeView service for managing dynamic query views.

Handles creation of default NodeViews when pages are created.
"""
from __future__ import annotations

import json
from typing import Optional, List, Dict, Any

from ..entities import NodeView, generate_uuid
from ..entities.query_ast import (
    QueryAST, ScopeNode, ScopeType, GroupNode, LogicType,
    ReferenceCondition, ParentPathCondition, ParentCondition, ClassCondition, ExtendsCondition, FlagCondition,
    PropertyCondition, PropertyOperator,
    ContentCondition, ContentOperator
)
from ..repositories import PostgresNodeViewRepository
from...db.schema.constants import DEFAULT_VIEW_CLASSES
from ...logging_config import get_logger

logger = get_logger(__name__)


# Default view configurations using QueryAST format
DEFAULT_VIEW_CONFIGS: Dict[str, Dict[str, Any]] = {
    "child_pages": {
        "name": "All Pages",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.PAGES),
            root_group=GroupNode(
                logic=LogicType.AND,
                children=[
                    ParentCondition(
                        parent_uuid="{current_node_uuid}"
                    )
                ]
            ),
            is_system=True
        )
    },
    "classed_nodes": {
        "name": "Classed Nodes",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND,
                children=[
                    ClassCondition(
                        class_uuid="{current_node_uuid}",
                        operator="contains"
                    )
                ]
            ),
            is_system=True
        )
    },
    "extended_by": {
        "name": "Extended By",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND,
                children=[
                    ExtendsCondition(
                        extends_class_uuid="{current_node_uuid}"
                    )
                ]
            ),
            is_system=True
        )
    },
    "linked_references": {
        "name": "All References",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND,
                children=[
                    ReferenceCondition(target_uuid="{current_node_uuid}")
                ]
            ),
            is_system=True
        )
    },
    "main_content": {
        "name": "Content",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND,
                children=[]
            ),
            is_system=True
        )
    },
}


class NodeViewService:
    """Service for managing NodeViews."""
    
    def __init__(
        self,
        pool,
        workspace_id: int,
        user_id: Optional[str] = None,
    ):
        """Initialize the NodeView service.
        
        Args:
            pool: asyncpg connection pool
            workspace_id: Current workspace ID
            user_id: Current user ID (string) for audit
        """
        self._pool = pool
        self._workspace_id = workspace_id
        self._user_id = user_id
        self._view_repo = PostgresNodeViewRepository(pool, workspace_id, user_id)
    
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
            config = DEFAULT_VIEW_CONFIGS.get(view_type)
            if not config:
                logger.warning(f"No default config for view_type '{view_type}', skipping")
                continue
            
            try:
                # Convert QueryAST to dict for storage
                query_ast: QueryAST = config["query_ast"]
                query_json = query_ast.to_dict()
                
                view = await self._view_repo.create(
                    node_id=node_id,
                    name=config["name"],
                    view_type=view_type,
                    query_json=query_json,
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
