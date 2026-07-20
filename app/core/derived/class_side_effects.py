"""Global registry for ``class.assign`` / ``class.unassign`` side effects.

The operation-log core intentionally keeps derived-state appliers synchronous
and free of plugin dependencies.  Feature plugins that need to react when a
node gains or loses a class can register an async handler here; the
server-side :class:`app.core.workspace_store.WorkspaceStore` invokes matching
handlers after the SQLite derived state has been committed.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

ClassAssignSideEffect = Callable[
    [str, str, str, str, bool],
    Awaitable[Any] | Any,
]

_handlers: dict[str, list[ClassAssignSideEffect]] = {}


def register(class_uuid: str, handler: ClassAssignSideEffect) -> None:
    """Register ``handler`` to run when a node gains or loses ``class_uuid``."""
    _handlers.setdefault(class_uuid, []).append(handler)


def get(class_uuid: str) -> list[ClassAssignSideEffect]:
    """Return all registered handlers for ``class_uuid``."""
    return list(_handlers.get(class_uuid, []))


def clear(class_uuid: str | None = None) -> None:
    """Remove handlers.  Used by tests to reset global state."""
    if class_uuid is None:
        _handlers.clear()
    else:
        _handlers.pop(class_uuid, None)
