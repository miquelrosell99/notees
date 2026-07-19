"""Undo feature module.

Server-side undo has been removed. The undo router now returns 410 Gone for
all endpoints; client-side inverse operations handle undo/redo.
"""
