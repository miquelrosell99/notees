"""Nodes router package - split into logical modules.

This package handles all node (page, block, tag) CRUD operations.
The monolithic nodes.py has been split into:
- models.py: Pydantic request/response models
- helpers.py: Helper functions and _get_node_service
- crud.py: Basic CRUD operations (create, get, update, delete, move, archive)
- daily.py: Daily/monthly/yearly date page endpoints
- classes.py: Class-related endpoints
- search.py: Search, list, and graph endpoints
- favorites.py: Favorites management
- links.py: Backlinks, linked references, tag links, properties
- comments.py: Comments endpoints
- settings.py: Settings endpoints (date format, etc.)
"""
from fastapi import APIRouter

from .crud import router as crud_router
from .daily import router as daily_router
from .classes import router as classes_router
from .search import router as search_router
from .favorites import router as favorites_router
from .links import router as links_router
from .comments import router as comments_router
from .settings import router as settings_router
from .views import router as views_router
from ..properties.values import router as property_values_router

# Re-export models for external use
from .models import (
    NodeResponse,
    NodeCreateRequest,
    NodeUpdateRequest,
    MoveNodeRequest,
    ClassRequest,
    PropertyRequest,
    BacklinkResponse,
    LinkedReferenceResponse,
    BreadcrumbSegment,
    PropertyValueResponse,
    TagLinkRequest,
    NodeLinkResponse,
    InlineClassResponse,
    PropertyBacklinkResponse,
    CommentCreateRequest,
    CommentResponse,
    CommentsResponse,
    DateFormatUpdateRequest,
)

# Re-export helpers that may be used elsewhere
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_class_ids,
    _get_class_ids_batch,
    _get_tag_ids,
    _get_tag_ids_batch,
)


# Create the main router
router = APIRouter(prefix="/api/nodes", tags=["Nodes"])

# Include all sub-routers
# Order matters! More specific routes must come before parameterized routes.
# Routes with fixed paths like /graph, /search, /classes must come before /{node_id}

# Search and graph endpoints (GET /graph, GET /search, GET "")
router.include_router(search_router)

# Class endpoints (GET /classes, GET /classes/search, GET /classes/{class_id}/nodes)
router.include_router(classes_router)

# Daily endpoints (GET /daily/list, POST /daily, POST /monthly, POST /yearly)
router.include_router(daily_router)

# Favorites endpoints (GET/PUT /favorites, POST/DELETE /favorites/{node_id})
router.include_router(favorites_router)

# Settings endpoints (POST /settings/update-date-format)
router.include_router(settings_router)

# Property values endpoints (GET/POST/DELETE /{node_id}/properties/...)
router.include_router(property_values_router)

# Views endpoints (NodeViews for dynamic query tabs)
router.include_router(views_router, prefix="/views")

# CRUD endpoints (POST "", POST /page, GET /recents, GET /archived, GET/PUT/DELETE /{node_id}, etc.)
router.include_router(crud_router)

# Links endpoints (GET/POST/DELETE /{node_id}/text-links, backlinks, etc.)
router.include_router(links_router)

# Comments endpoints (GET/POST/DELETE /{node_id}/comments)
router.include_router(comments_router)
