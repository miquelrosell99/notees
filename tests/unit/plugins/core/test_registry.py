"""Unit tests for the plugin registry."""

import pytest
from fastapi import APIRouter

from app.plugins.core.ports import RouterRegistration
from app.plugins.core.registry import PluginRegistry


@pytest.mark.unit
def test_add_router_creates_registration() -> None:
    """Router registration must work at runtime (regression: RouterRegistration was TYPE_CHECKING-only)."""
    registry = PluginRegistry()
    router = APIRouter()

    registry.add_router("notees.logseq_importer", router, prefix="logseq")

    registration = registry.get_router_registration("notees.logseq_importer")
    assert registration is not None
    assert isinstance(registration, RouterRegistration)
    assert registration.plugin_id == "notees.logseq_importer"
    assert registration.router is router
    assert registration.prefix == "logseq"


@pytest.mark.unit
def test_get_router_returns_router() -> None:
    """get_router should return the underlying APIRouter."""
    registry = PluginRegistry()
    router = APIRouter()

    registry.add_router("notees.test", router, prefix="test")

    assert registry.get_router("notees.test") is router


@pytest.mark.unit
def test_remove_router() -> None:
    """remove_router should return the registration and clear it."""
    registry = PluginRegistry()
    router = APIRouter()

    registry.add_router("notees.test", router, prefix="test")
    removed = registry.remove_router("notees.test")

    assert removed is not None
    assert removed.router is router
    assert registry.get_router("notees.test") is None
