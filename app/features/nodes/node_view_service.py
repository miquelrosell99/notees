"""NodeView service for managing dynamic query views.

Handles creation of default NodeViews when pages are created.
"""

from __future__ import annotations

from typing import Any

from app.domain.entities import NodeView
from app.domain.entities.constants import DEFAULT_VIEW_CLASSES
from app.domain.entities.query_ast import (
    ClassCondition,
    ContentCondition,
    ContentOperator,
    ExtendsCondition,
    GroupNode,
    LogicType,
    PageCondition,
    ParentCondition,
    PropertyCondition,
    PropertyOperator,
    QueryAST,
    ReferenceCondition,
    ScopeNode,
    ScopeType,
    create_default_query_ast,
)
from app.domain.errors import DomainError
from app.domain.services.query_ast_validation import can_save_query, validate_query_ast
from app.features.nodes.port import NodeViewRepository
from app.logging_config import get_logger

logger = get_logger(__name__)


# Default view configurations using QueryAST format
DEFAULT_VIEW_CONFIGS: dict[str, dict[str, Any]] = {
    "child_pages": {
        "name": "All Pages",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.PAGES),
            root_group=GroupNode(logic=LogicType.AND, children=[ParentCondition(parent_uuid="{current_node_uuid}")]),
            is_system=True,
        ),
    },
    "classed_nodes": {
        "name": "Classed Nodes",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND, children=[ClassCondition(class_uuid="{current_node_uuid}", operator="contains")]
            ),
            is_system=True,
        ),
    },
    "extended_by": {
        "name": "Extended By",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND, children=[ExtendsCondition(extends_class_uuid="{current_node_uuid}")]
            ),
            is_system=True,
        ),
    },
    "linked_references": {
        "name": "All References",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND,
                children=[
                    ReferenceCondition(target_uuid="{current_node_uuid}"),
                    PageCondition(
                        page_uuid="{current_node_uuid}",
                        operator="is_not_page",
                    ),
                ],
            ),
            is_system=True,
        ),
    },
    "unlinked_references": {
        "name": "Unlinked References",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND,
                children=[
                    ContentCondition(
                        operator=ContentOperator.CONTAINS,
                        value="{current_node_name}",
                    ),
                    PropertyCondition(
                        property_name="uuid",
                        operator=PropertyOperator.NOT_EQUALS,
                        value="{current_node_uuid}",
                    ),
                    ClassCondition(
                        class_uuid="00000000-0000-0000-0001-000000000002",  # Page class UUID
                        operator="does_not_contain",
                    ),
                ],
            ),
            is_system=True,
        ),
    },
    "main_content": {
        "name": "Content",
        "query_ast": QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(logic=LogicType.AND, children=[]),
            is_system=True,
        ),
    },
}


class NodeViewService:
    """Service for managing NodeViews."""

    def __init__(
        self,
        view_repo: NodeViewRepository,
    ):
        """Initialize the NodeView service.

        Args:
            view_repo: NodeView repository for the current workspace.
        """
        self._view_repo = view_repo

    async def create_default_views(self, node_id: int, view_types: list[str] | None = None) -> list[NodeView]:
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
                    view_mode="table" if view_type == "classed_nodes" else "list",
                )
                created_views.append(view)
            except Exception as e:
                logger.error(f"Failed to create default view '{view_type}' for node {node_id}: {e}")

        return created_views

    async def duplicate_view(self, view_id: int) -> NodeView:
        """Duplicate a NodeView, copying its query and full presentation config.

        The copy is appended at the end of the view_type's tab order and is
        never marked as default.

        Raises:
            DomainError: if the source view does not exist.
        """
        source = await self._view_repo.get_by_id(view_id)
        if source is None:
            raise DomainError("NodeView not found")

        order_index = await self._view_repo.count_by_view_type(source.node_id, source.view_type)

        return await self._view_repo.create(
            node_id=source.node_id,
            name=f"{source.name} copy",
            view_type=source.view_type,
            query_json=source.query_json,
            order_index=order_index,
            is_default=False,
            shown_properties=source.shown_properties,
            group_by=source.group_by,
            view_mode=source.view_mode,
            sort_entries=source.sort_entries,
            settings=source.settings,
        )

    async def get_views_for_node(
        self,
        node_id: int,
        view_type: str | None = None,
    ) -> list[NodeView]:
        """Get NodeViews for a node.

        Args:
            node_id: The node ID
            view_type: Optional filter by view_type

        Returns:
            List of NodeViews
        """
        return await self._view_repo.list_by_node(node_id, view_type=view_type)

    async def ensure_default_views(self, node_id: int) -> list[NodeView]:
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

    def prepare_query_ast_for_create(
        self, query_ast: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Validate a QueryAST dict for a new NodeView and return the stored form.

        Raises:
            DomainError: if the AST is invalid or attempts to create a system query.
        """
        if query_ast:
            ast = QueryAST.from_dict(query_ast)
            if ast.is_system:
                raise DomainError("Cannot create system queries through this endpoint")
            validation = validate_query_ast(ast, allow_system_modification=False)
            if not validation.valid:
                first_issue = validation.issues[0].message if validation.issues else "Unknown error"
                raise DomainError(f"Invalid query AST: {first_issue}")
            return query_ast
        return create_default_query_ast().to_dict()

    async def prepare_query_ast_for_update(
        self,
        view_id: int,
        query_ast: dict[str, Any],
    ) -> dict[str, Any]:
        """Validate a QueryAST dict for an existing NodeView and return the stored form.

        System views preserve their ``is_system`` flag; non-system views cannot
        be marked as system. Raises DomainError on invalid or disallowed input.
        """
        view = await self._view_repo.get_by_id(view_id)
        if view is None:
            raise DomainError("NodeView not found")

        existing_query = view.query_json or {}
        is_system_view = existing_query.get("is_system", False)

        ast = QueryAST.from_dict(query_ast)
        if is_system_view:
            ast.is_system = True
        elif ast.is_system:
            raise DomainError("Cannot create system queries through this endpoint")

        validate_query_ast(ast, allow_system_modification=is_system_view)
        can_save, reason = can_save_query(ast, allow_system_modification=is_system_view)
        if not can_save:
            raise DomainError(f"Cannot save query: {reason}")

        return ast.to_dict()
