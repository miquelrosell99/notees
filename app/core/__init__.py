"""New operation-log architecture core package.

This package contains foundational types and utilities for the ideal
local-first, operation-based, CRDT-driven data architecture.
"""

from app.core.clock import Clock, Hlc, compare_hlc, max_hlc
from app.core.operation import Operation, OperationEnvelope, create_operation
from app.core.sync import SyncEngine
from app.core.transport import MemoryRelay, MemoryTransport, Transport
from app.core.uuid import uuidv7
from app.core.validation import validate_operation
from app.core.workspace_store import WorkspaceStore

__all__ = [
    "Clock",
    "Hlc",
    "compare_hlc",
    "max_hlc",
    "MemoryRelay",
    "MemoryTransport",
    "Operation",
    "OperationEnvelope",
    "SyncEngine",
    "Transport",
    "WorkspaceStore",
    "create_operation",
    "uuidv7",
    "validate_operation",
]
