"""Collaboration document manager for Yjs CRDT state.

Manages the lifecycle of in-memory Yjs documents per page, including:
- Lazy loading from PostgreSQL snapshots or update logs
- Applying updates and computing diffs
- Persisting updates to the event log
- Publishing updates via Redis pub/sub
- Periodic snapshotting and memory eviction
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict
from typing import TYPE_CHECKING

import y_py

from ...db.connection import get_connection
from ...logging_config import get_logger

if TYPE_CHECKING:
    import asyncpg

    from ...infrastructure.redis_pubsub import CollaborationPubSub

logger = get_logger(__name__)

# Evict documents after 5 minutes of inactivity
_DOC_TTL_SECONDS = 300

# Snapshot interval: save a full snapshot every 100 updates
_SNAPSHOT_INTERVAL = 100


class CollabManager:
    """Manages Yjs documents for real-time collaborative editing."""

    def __init__(self, pool: asyncpg.Pool, pubsub: CollaborationPubSub) -> None:
        self._pool = pool
        self._pubsub = pubsub
        self._docs: dict[str, y_py.YDoc] = {}
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._last_accessed: dict[str, float] = {}
        self._update_counts: dict[str, int] = defaultdict(int)
        self._cleanup_task: asyncio.Task | None = None
        self._shutting_down = False

    def start_cleanup_task(self) -> None:
        """Start the background task that evicts idle documents."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def shutdown(self) -> None:
        """Gracefully shutdown: save all snapshots and stop cleanup."""
        self._shutting_down = True
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._cleanup_task

        # Save snapshots for all loaded docs
        await asyncio.gather(
            *[self._save_snapshot_safe(uuid) for uuid in list(self._docs.keys())],
            return_exceptions=True,
        )

    async def _save_snapshot_safe(self, page_uuid: str) -> None:
        try:
            await self.save_snapshot(page_uuid)
        except Exception:
            logger.exception(f"Failed to save snapshot for {page_uuid} during shutdown")

    async def _cleanup_loop(self) -> None:
        """Periodically evict idle documents and save snapshots."""
        while not self._shutting_down:
            try:
                await asyncio.sleep(60)
                await self._evict_idle_docs()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Error in collab cleanup loop")

    async def _evict_idle_docs(self) -> None:
        """Evict documents that haven't been accessed recently."""
        now = asyncio.get_event_loop().time()
        to_evict = [
            uuid for uuid, last in self._last_accessed.items()
            if now - last > _DOC_TTL_SECONDS and uuid in self._docs
        ]
        for page_uuid in to_evict:
            async with self._locks[page_uuid]:
                if page_uuid in self._docs:
                    try:
                        await self.save_snapshot(page_uuid)
                    except Exception:
                        logger.exception(f"Failed to save snapshot for {page_uuid}")
                    del self._docs[page_uuid]
                    del self._last_accessed[page_uuid]
                    self._update_counts.pop(page_uuid, None)
            self._locks.pop(page_uuid, None)

    async def get_or_load_doc(self, page_uuid: str) -> y_py.YDoc:
        """Get an existing YDoc or load it from persistent storage."""
        async with self._locks[page_uuid]:
            if page_uuid in self._docs:
                self._last_accessed[page_uuid] = asyncio.get_event_loop().time()
                return self._docs[page_uuid]

            doc = y_py.YDoc()
            snapshot_loaded = False

            # 1. Try to load from snapshot table
            try:
                async with get_connection() as conn:
                    row = await conn.fetchrow(
                        "SELECT snapshot_bytes FROM yjs_state_vector WHERE page_uuid = $1",
                        page_uuid,
                    )
                    if row and row["snapshot_bytes"]:
                        y_py.apply_update(doc, row["snapshot_bytes"])
                        snapshot_loaded = True
                        logger.debug(f"Loaded YDoc snapshot for page {page_uuid}")
            except Exception:
                logger.exception(f"Failed to load snapshot for {page_uuid}")

            # 2. If no snapshot, replay update log
            if not snapshot_loaded:
                try:
                    async with get_connection() as conn:
                        rows = await conn.fetch(
                            "SELECT update_bytes FROM yjs_update WHERE page_uuid = $1 ORDER BY seq ASC",
                            page_uuid,
                        )
                        for row in rows:
                            try:
                                y_py.apply_update(doc, row["update_bytes"])
                            except Exception:
                                logger.warning(f"Failed to apply update for {page_uuid}")
                        if rows:
                            logger.debug(f"Replayed {len(rows)} updates for page {page_uuid}")
                except Exception:
                    logger.exception(f"Failed to replay updates for {page_uuid}")

            self._docs[page_uuid] = doc
            self._last_accessed[page_uuid] = asyncio.get_event_loop().time()
            return doc

    async def apply_update(
        self,
        page_uuid: str,
        update: bytes,
        user_uuid: str | None = None,
    ) -> None:
        """Apply a Yjs update, persist it, and publish to the backplane."""
        # Ensure doc is loaded (outside lock to avoid deadlock)
        doc = await self.get_or_load_doc(page_uuid)

        async with self._locks[page_uuid]:
            y_py.apply_update(doc, update)
            self._update_counts[page_uuid] += 1
            should_snapshot = self._update_counts[page_uuid] >= _SNAPSHOT_INTERVAL

            # Persist update to event log
            try:
                async with get_connection() as conn:
                    seq = await conn.fetchval(
                        "SELECT COALESCE(MAX(seq), 0) + 1 FROM yjs_update WHERE page_uuid = $1",
                        page_uuid,
                    )
                    await conn.execute(
                        """
                        INSERT INTO yjs_update (page_uuid, update_bytes, user_uuid, seq)
                        VALUES ($1, $2, $3, $4)
                        """,
                        page_uuid,
                        update,
                        user_uuid,
                        seq,
                    )
            except Exception:
                logger.exception(f"Failed to persist update for {page_uuid}")

            # Save snapshot if interval reached
            if should_snapshot:
                self._update_counts[page_uuid] = 0
                try:
                    await self._do_save_snapshot(page_uuid, doc)
                except Exception:
                    logger.exception(f"Failed to save snapshot for {page_uuid}")

        # Publish to backplane outside the lock
        try:
            await self._pubsub.publish(f"collab:{page_uuid}", update)
        except Exception:
            logger.exception(f"Failed to publish update for {page_uuid}")

    async def get_diff(self, page_uuid: str, state_vector: bytes | None = None) -> bytes:
        """Get the update diff needed to sync a client from the given state vector."""
        doc = await self.get_or_load_doc(page_uuid)
        return y_py.encode_state_as_update(doc, state_vector)

    async def get_state_vector(self, page_uuid: str) -> bytes:
        """Get the current state vector of a page's document."""
        doc = await self.get_or_load_doc(page_uuid)
        return y_py.encode_state_vector(doc)

    async def save_snapshot(self, page_uuid: str) -> None:
        """Save a full snapshot of the current document state."""
        doc = await self.get_or_load_doc(page_uuid)
        async with self._locks[page_uuid]:
            await self._do_save_snapshot(page_uuid, doc)

    async def _do_save_snapshot(self, page_uuid: str, doc: y_py.YDoc) -> None:
        """Internal snapshot save (assumes lock is held)."""
        snapshot = y_py.encode_state_as_update(doc)
        state_vector = y_py.encode_state_vector(doc)
        async with get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO yjs_state_vector (page_uuid, snapshot_bytes, state_vector)
                VALUES ($1, $2, $3)
                ON CONFLICT (page_uuid) DO UPDATE SET
                  snapshot_bytes = EXCLUDED.snapshot_bytes,
                  state_vector = EXCLUDED.state_vector,
                  updated_at = NOW()
                """,
                page_uuid,
                snapshot,
                state_vector,
            )
        logger.debug(f"Saved YDoc snapshot for page {page_uuid}")
