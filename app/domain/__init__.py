"""Domain layer for Notees.

This package contains the core business logic of the application,
organized with clean architecture principles.

The domain layer is organized into:
- entities/: Domain objects with identity and lifecycle (Node, Property, Link, User)
- repositories/: Repository interfaces and implementations
- services/: Domain logic and business rules
- errors.py: Domain-specific exceptions

Architecture:
- Node is the core entity - everything is a node
- Pages are nodes tagged as "page"
- Blocks are nodes with a parent_id (always have page_id set)
- Tags are nodes tagged as "tag" (always also tagged as "page")
- Properties are stored in node_property + property_value_relation/property_value_scalar
- SuperTags: Tags can define which properties apply to tagged nodes
- Links are parsed from [[page]] and ((block)) references
"""

from .entities import *
from .services import *
from .errors import *
