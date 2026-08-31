"""Global registry for post-commit operation listeners.

The operation-log core intentionally keeps derived-state appliers synchronous
and free of plugin dependencies.  Features that need to react to applied
operations (for example, continuous export reconciliation) can register an
async listener here; the server-side
:class:`app.core.workspace_store.WorkspaceStore` invokes all listeners after
the SQLite derived state has been committed — both for locally applied
operations and for remote operations replayed by ``sync()``.

Listeners must be fast and non-blocking; heavy work should be scheduled
(e.g. debounced) rather than executed inline.
"""

from __future__ import annotations

import contextlib
from collections.abc import Awaitable, Callable
from typing import Any

from app.core.operation import Operation

OperationListener = Callable[[Operation], Awaitable[Any] | Any]

_listeners: list[OperationListener] = []


def register(listener: OperationListener) -> None:
    """Register ``listener`` to run after any operation is committed."""
    _listeners.append(listener)


def unregister(listener: OperationListener) -> None:
    """Remove a previously registered listener (no-op when absent)."""
    with contextlib.suppress(ValueError):
        _listeners.remove(listener)


def get() -> list[OperationListener]:
    """Return all registered listeners."""
    return list(_listeners)


def clear() -> None:
    """Remove all listeners.  Used by tests to reset global state."""
    _listeners.clear()
