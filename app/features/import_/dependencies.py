"""Dependency injection for the import feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Depends

from app.dependencies import get_node_repository, get_node_service, get_property_repository
from app.features.import_.service import ImportService
from app.features.nodes.node_service import NodeService
from app.features.nodes.port import NodeRepository
from app.features.properties.dependencies import get_property_service
from app.features.properties.port import PropertyRepository
from app.features.properties.service import PropertyService


async def get_import_service(
    node_service: NodeService = Depends(get_node_service),
    property_service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
) -> AsyncGenerator[ImportService, None]:
    """Yield an ImportService wired to the current user's workspace."""
    yield ImportService(
        node_service=node_service,
        property_service=property_service,
        node_repo=node_repo,
        property_repo=property_repo,
    )
