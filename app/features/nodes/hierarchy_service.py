"""Hierarchy domain service.

Contains business logic for node hierarchy operations:
- Parent-child relationships
- Tree traversal
- Move operations
- Circular reference detection
"""

from collections.abc import Awaitable, Callable

from app.domain.entities.node import Node, NodeId
from app.domain.errors import CircularReferenceError


class HierarchyService:
    """Domain service for hierarchy operations.

    This service handles:
    - Validating parent-child relationships
    - Detecting circular references
    - Computing paths and ancestors

    Note: This service needs a way to look up nodes. It accepts
    a lookup function rather than accessing the database directly.
    """

    @staticmethod
    def validate_parent_assignment(
        node_id: NodeId,
        new_parent_id: NodeId | None,
        get_ancestors: Callable[[NodeId], list[NodeId]],
    ) -> None:
        """Validate that assigning a parent won't create a cycle.

        Args:
            node_id: The node being moved
            new_parent_id: The proposed new parent
            get_ancestors: Function to get ancestor IDs for a node

        Raises:
            CircularReferenceError: If assignment would create a cycle
        """
        if new_parent_id is None:
            return  # Moving to root is always valid

        if node_id == new_parent_id:
            raise CircularReferenceError(str(node_id), str(new_parent_id))

        # Check if node_id is an ancestor of new_parent_id
        ancestors = get_ancestors(new_parent_id)
        if node_id in ancestors:
            raise CircularReferenceError(str(node_id), str(new_parent_id))

    @staticmethod
    async def validate_parent_assignment_async(
        node_id: NodeId,
        new_parent_id: NodeId | None,
        get_ancestors: Callable[[NodeId], Awaitable[list[NodeId]]],
    ) -> None:
        """Async version of validate_parent_assignment."""
        if new_parent_id is None:
            return

        if node_id == new_parent_id:
            raise CircularReferenceError(str(node_id), str(new_parent_id))

        ancestors = await get_ancestors(new_parent_id)
        if node_id in ancestors:
            raise CircularReferenceError(str(node_id), str(new_parent_id))

    @staticmethod
    def compute_path(
        node_id: NodeId,
        get_parent: Callable[[NodeId], NodeId | None],
        max_depth: int = 100,
    ) -> list[NodeId]:
        """Compute the path from root to the given node.

        Returns a list of node IDs from root to the node.
        """
        path = []
        current = node_id
        depth = 0

        while current and depth < max_depth:
            path.append(current)
            current = get_parent(current)
            depth += 1

        return list(reversed(path))

    @staticmethod
    def find_containing_page(
        node_id: NodeId,
        get_node: Callable[[NodeId], Node | None],
        max_depth: int = 100,
    ) -> NodeId | None:
        """Find the page that contains a block.

        Walks up the parent chain to find the first page ancestor.
        """
        current_id = node_id
        depth = 0

        while current_id and depth < max_depth:
            node = get_node(current_id)
            if not node:
                return None

            if node.is_page:
                return node.id

            current_id = node.parent_id
            depth += 1

        return None

    @staticmethod
    def compute_descendants(
        node_id: NodeId,
        get_children: Callable[[NodeId], list[NodeId]],
        max_depth: int = 100,
    ) -> set[NodeId]:
        """Compute all descendants of a node.

        Returns a set of all descendant node IDs.
        """
        descendants: set[NodeId] = set()
        to_visit = [node_id]
        depth = 0

        while to_visit and depth < max_depth:
            current = to_visit.pop(0)
            children = get_children(current)

            for child in children:
                if child not in descendants:
                    descendants.add(child)
                    to_visit.append(child)

            depth += 1

        return descendants

    @staticmethod
    def reorder_siblings(
        siblings: list[Node],
        moved_id: NodeId,
        new_sequence: int,
    ) -> list[Node]:
        """Reorder siblings after a move operation.

        Returns the updated list with corrected sequence values.
        """
        # Sort by current sequence
        sorted_siblings = sorted(siblings, key=lambda n: n.sequence)

        # Remove the moved node
        others = [n for n in sorted_siblings if n.id != moved_id]
        moved_node = next((n for n in sorted_siblings if n.id == moved_id), None)

        if not moved_node:
            return sorted_siblings

        # Insert at new position
        new_sequence = max(0, min(new_sequence, len(others)))
        others.insert(new_sequence, moved_node)

        # Reassign sequence values
        for i, node in enumerate(others):
            node.sequence = i

        return others
