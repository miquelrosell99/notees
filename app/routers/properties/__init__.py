"""Properties router package - manages property definitions and values."""
from fastapi import APIRouter

from .crud import router as crud_router
from .selection_lines import router as selection_lines_router
from .values import router as values_router
from .types import router as types_router

# Main router that combines all sub-routers
router = APIRouter(prefix="/api/properties", tags=["Properties"])

# Include sub-routers with proper ordering
# Note: More specific routes must come before generic ones to avoid conflicts

# Values router - /nodes/{node_id}/properties/* routes (most specific prefix)
router.include_router(values_router)

# Types router - /types/{type_node_id}/* routes  
router.include_router(types_router)

# Selection lines router - /{property_id}/selection-lines/* routes
router.include_router(selection_lines_router)

# CRUD router - /{property_id}/* and base routes (most generic, must be last)
router.include_router(crud_router)

# Re-export models for convenience
from .models import (
    PropertyResponse,
    PropertyCreateRequest,
    PropertyUpdateRequest,
    PropertyTypeChangeRequest,
    SelectionLineResponse,
    SelectionLineRequest,
    SelectionLineUpdateRequest,
    NodePropertyResponse,
    ScalarValueResponse,
    ScalarValueRequest,
    RelationValueResponse,
    RelationValueRequest,
    SelectionValueResponse,
    SelectionValueRequest,
    TypePropertyResponse,
    TypePropertyRequest,
    TypeExtendsResponse,
    TypeExtendsRequest,
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
    "TypePropertyResponse",
    "TypeExtendsResponse",
    # Request models
    "PropertyCreateRequest",
    "PropertyUpdateRequest",
    "PropertyTypeChangeRequest",
    "SelectionLineRequest",
    "SelectionLineUpdateRequest",
    "ScalarValueRequest",
    "RelationValueRequest",
    "SelectionValueRequest",
    "TypePropertyRequest",
    "TypeExtendsRequest",
]
