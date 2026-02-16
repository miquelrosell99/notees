"""Query SQL Cache

LRU cache for prepared SQL statements generated from system queries.
System queries (linked_references, child_pages, etc.) are structurally
identical across nodes — only runtime parameters differ.  Caching the
generated SQL template avoids re-generating it on every execution.

Cache keys are derived from the QueryAST structure (with placeholders
intact), so different nodes reuse the same template.
"""
from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

from ...logging_config import get_logger

logger = get_logger(__name__)


class QuerySQLCache:
    """Thread-safe LRU cache for query SQL templates.

    Stores (sql_template, param_names) keyed by a hash of the
    normalised AST dict.  The sql_template still contains named
    placeholders (%(p0)s etc.) which are filled at execution time.
    """

    def __init__(self, max_size: int = 128):
        self._max_size = max_size
        self._cache: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._hits = 0
        self._misses = 0

    # ── public API ──────────────────────────────────

    def get(self, ast_dict: Dict[str, Any], workspace_id: int) -> Optional[Tuple[str, Dict[str, Any]]]:
        """Look up a cached SQL template.

        Returns (sql, params_template) or None on miss.
        """
        key = self._make_key(ast_dict, workspace_id)
        entry = self._cache.get(key)
        if entry is not None:
            self._hits += 1
            self._cache.move_to_end(key)
            entry.last_hit = time.monotonic()
            entry.hit_count += 1
            return entry.sql, entry.params
        self._misses += 1
        return None

    def put(
        self,
        ast_dict: Dict[str, Any],
        workspace_id: int,
        sql: str,
        params: Dict[str, Any],
    ) -> None:
        """Store a SQL template in the cache."""
        key = self._make_key(ast_dict, workspace_id)
        self._cache[key] = _CacheEntry(
            sql=sql,
            params=params,
            created=time.monotonic(),
        )
        self._cache.move_to_end(key)
        # Evict oldest if over capacity
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)

    def invalidate_all(self) -> None:
        """Clear the entire cache (e.g. after schema change)."""
        self._cache.clear()
        logger.debug("QuerySQLCache invalidated")

    @property
    def stats(self) -> Dict[str, Any]:
        """Return cache statistics for observability."""
        total = self._hits + self._misses
        return {
            "size": len(self._cache),
            "max_size": self._max_size,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": round(self._hits / total, 3) if total else 0.0,
        }

    # ── internals ───────────────────────────────────

    @staticmethod
    def _make_key(ast_dict: Dict[str, Any], workspace_id: int) -> str:
        """Deterministic cache key from the AST structure."""
        # Sort keys for determinism, include workspace_id
        raw = json.dumps(ast_dict, sort_keys=True, default=str) + f"|ws={workspace_id}"
        return hashlib.sha256(raw.encode()).hexdigest()


class _CacheEntry:
    __slots__ = ("sql", "params", "created", "last_hit", "hit_count")

    def __init__(self, sql: str, params: Dict[str, Any], created: float):
        self.sql = sql
        self.params = params
        self.created = created
        self.last_hit = created
        self.hit_count = 0


# Module-level singleton so the cache persists across requests
_global_cache: Optional[QuerySQLCache] = None


def get_sql_cache() -> QuerySQLCache:
    """Get (or create) the global SQL cache singleton."""
    global _global_cache
    if _global_cache is None:
        _global_cache = QuerySQLCache(max_size=256)
    return _global_cache
