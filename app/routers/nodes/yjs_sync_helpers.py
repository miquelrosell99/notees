"""Background Yjs sync triggers for REST mutations.

These helpers run Yjs document rebuilds asynchronously so that REST mutations
do not block on CRDT computation.
"""

from __future__ import annotations

import asyncio

from ...db.connection import clear_request_conn
from ...domain.services.yjs_sync_service import YjsSyncService
from ...logging_config import get_logger

logger = get_logger(__name__)

_sync_service = YjsSyncService()


async def _rebuild_page_yjs_after_node_change(node_id: int) -> None:
    """Module-level background task: rebuild Yjs state after a node mutation."""
    clear_request_conn()
    try:
        await _sync_service.on_node_content_changed(node_id)
    except Exception:
        logger.exception(f"Background Yjs rebuild failed for node {node_id}")


async def _rebuild_page_yjs_after_delete(page_uuid: str) -> None:
    """Module-level background task: rebuild Yjs state after a node deletion."""
    clear_request_conn()
    try:
        await _sync_service.on_node_deleted(page_uuid)
    except Exception:
        logger.exception(f"Background Yjs rebuild failed for page {page_uuid}")


def trigger_yjs_rebuild(node_id: int) -> None:
    """Fire-and-forget Yjs rebuild for a node mutation."""
    asyncio.create_task(_rebuild_page_yjs_after_node_change(node_id))


def trigger_yjs_rebuild_for_delete(page_uuid: str) -> None:
    """Fire-and-forget Yjs rebuild for a page after node deletion."""
    asyncio.create_task(_rebuild_page_yjs_after_delete(page_uuid))
