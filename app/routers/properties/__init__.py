"""Properties router package - manages property definitions.

This router handles:
- Property CRUD (create, read, update, delete property definitions)
- Class properties (properties attached to types/classes)
- Selection lines (options for selection-type properties)

NOTE: Property VALUE operations (setting/getting property values on nodes)
are handled by the nodes router at /api/nodes/{node_id}/properties,
not here. The values.py module exists but is not included because its routes
start with /nodes/ which would create incorrect paths under /api/properties.
"""

from fastapi import APIRouter

from .classes import router as classes_router
from .crud import router as crud_router
from .selection_lines import router as selection_lines_router

# Main router that combines all sub-routers
router = APIRouter(prefix="/properties", tags=["Properties"])

# Include sub-routers with proper ordering
# Note: More specific routes must come before generic ones to avoid conflicts

# Classes router - /classes/{class_node_id}/* routes
router.include_router(classes_router)

# Selection lines router - /{property_id}/selection-lines/* routes
router.include_router(selection_lines_router)

# CRUD router - /{property_id}/* and base routes (most generic, must be last)
router.include_router(crud_router)

# Re-export models for convenience
from .models import (
    ClassExtendsRequest,
    ClassExtendsResponse,
    ClassPropertyRequest,
    ClassPropertyResponse,
    NodePropertyResponse,
    PropertyCreateRequest,
    PropertyResponse,
    PropertyTypeChangeRequest,
    PropertyUpdateRequest,
    RelationValueRequest,
    RelationValueResponse,
    ScalarValueRequest,
    ScalarValueResponse,
    SelectionLineRequest,
    SelectionLineResponse,
    SelectionLineUpdateRequest,
    SelectionValueRequest,
    SelectionValueResponse,
)

__all__ = [
    "router",
    # Response models
    "PropertyResponse",
    "SelectionLineResponse",
    "NodePropertyResponse",
    "ScalarValueResponse",
    "RelationValueResponse",
    "SelectionValueResponse",
    "ClassPropertyResponse",
    "ClassExtendsResponse",
    # Request models
    "PropertyCreateRequest",
    "PropertyUpdateRequest",
    "PropertyTypeChangeRequest",
    "SelectionLineRequest",
    "SelectionLineUpdateRequest",
    "ScalarValueRequest",
    "RelationValueRequest",
    "SelectionValueRequest",
    "ClassPropertyRequest",
    "ClassExtendsRequest",
]
