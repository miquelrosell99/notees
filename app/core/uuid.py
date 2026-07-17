"""UUID generation utilities for the new operation-log architecture."""

from uuid_extensions import uuid7


def uuidv7() -> str:
    """Return a new UUIDv7 as a string.

    UUIDv7 encodes a Unix timestamp in the most-significant bits, so generated
    identifiers are roughly sortable by creation time.
    """
    return str(uuid7())
