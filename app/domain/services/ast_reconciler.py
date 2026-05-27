"""AST Reconciler: projects Yjs CRDT state back into the relational node model.

This module maintains the queryable AST mirror (`node` table) from the
authoritative Yjs document state. It enables the existing search, backlink,
export, and QueryAST infrastructure to continue working without modification.

Phase 1: Skeleton / dark launch. The reconciler is instantiated and callable
but does not yet perform full two-way reconciliation.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...logging_config import get_logger

if TYPE_CHECKING:
    import asyncpg
    import y_py

logger = get_logger(__name__)


class ASTReconciler:
    """Reconciles Yjs document state into the PostgreSQL node table."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def reconcile_page(self, page_uuid: str, ydoc: y_py.YDoc) -> None:
        """Reconcile a single page's Yjs document into the AST mirror.

        Steps (when fully implemented):
        1. Walk the Yjs document blocks.
        2. Convert each block's Y.Text content to JSON AST.
        3. Compare with current node rows and upsert changes.
        4. Update node_link table from parsed AST references.
        5. Update page title in node.name.
        6. Increment node.version.

        Phase 1: No-op except logging.
        """
        logger.debug(f"ASTReconciler.reconcile_page called for {page_uuid} (dark launch)")
        # TODO: Implement full reconciliation in Phase 2

    async def reconcile_all_dirty_pages(self) -> None:
        """Background task to reconcile any pages marked as dirty."""
        logger.debug("ASTReconciler.reconcile_all_dirty_pages called (dark launch)")
        # TODO: Implement in Phase 2
