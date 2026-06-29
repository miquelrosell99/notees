"""Tests for PluginContext property and external-id mapping helpers."""

from __future__ import annotations

from typing import Any

import pytest

from app.domain.entities import Node, NodeCreateData, NodeUpdateData, Property
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.domain.entities.property import PropertyScope, PropertyType
from app.plugins.core.context import PluginContext
from app.plugins.core.exceptions import PluginPermissionError
from app.plugins.core.registry import PluginRegistry
from tests.fakes import FakeNodeRepository, FakePropertyRepository


class FakePropertyService:
    """Minimal property service backed by FakePropertyRepository."""

    def __init__(self, repo: FakePropertyRepository) -> None:
        self._repo = repo

    async def list_properties(self, include_local: bool = True) -> list[Property]:
        return await self._repo.get_all(include_local=include_local)

    async def create_property(
        self,
        name: str,
        prop_type: PropertyType,
        scope: PropertyScope,
        is_multi: bool = False,
        icon: str | None = None,
        **kwargs: Any,
    ) -> Property:
        prop = Property(id=self._repo._bump_id(), name=name, type=prop_type, icon=icon)
        return await self._repo.create(prop)

    async def get_nodes_with_property(self, property_id: int) -> list[dict[str, Any]]:
        node_ids = await self._repo.get_node_ids_with_property(property_id)
        result = []
        for node_id in node_ids:
            values = await self._repo.get_all_property_values(node_id)
            result.append({
                "node_id": node_id,
                "is_page": True,
                "properties": values,
            })
        return result


class FakeNodeService:
    """Minimal node service that creates pages with the page system class."""

    def __init__(
        self,
        node_repo: FakeNodeRepository,
        prop_repo: FakePropertyRepository,
        page_class_id: int,
    ) -> None:
        self._node_repo = node_repo
        self._prop_repo = prop_repo
        self._page_class_id = page_class_id

    async def create_node(
        self,
        data: NodeCreateData,
        user_id: int | None = None,
    ) -> Node:
        return await self._node_repo.create(data, user_id)

    async def create_page(
        self,
        name: str,
        icon: str | None = None,
        color: str | None = None,
        additional_classes: list[int] | None = None,
        user_id: int | None = None,
    ) -> Node:
        classes = [self._page_class_id]
        if additional_classes:
            classes.extend(additional_classes)
        data = NodeCreateData(name=name, icon=icon, color=color, classes=classes)
        return await self._node_repo.create(data, user_id)

    async def get_node_by_id(self, node_id: int) -> Node | None:
        return await self._node_repo.get_by_id(node_id)

    async def update_node(
        self,
        node_id: int,
        data: NodeUpdateData,
        user_id: int | None = None,
        classes: list[int] | None = None,
        tags: list[int] | None = None,
        properties: dict[int, Any] | None = None,
    ) -> Node | None:
        node = await self._node_repo.update(node_id, data, user_id)
        if node is None:
            return None
        if properties:
            for prop_id, value in properties.items():
                await self._prop_repo.set_scalar_value(node_id, prop_id, value)
        return node

    async def apply_node_extras(
        self,
        node_id: int,
        classes: list[int] | None,
        tags: list[int] | None,
        properties: dict[int, Any] | None,
    ) -> None:
        if properties:
            for prop_id, value in properties.items():
                await self._prop_repo.set_scalar_value(node_id, prop_id, value)


def _seed_system_classes(node_repo: FakeNodeRepository) -> tuple[int, int]:
    """Seed class and page system class nodes."""
    class_class = Node(
        id=node_repo._bump_id(),
        uuid=SYSTEM_CLASS_UUIDS["class"],
        name="Class",
        is_class=True,
        is_page=True,
    )
    node_repo.add_node(class_class)

    page_class = Node(
        id=node_repo._bump_id(),
        uuid=SYSTEM_CLASS_UUIDS["page"],
        name="Page",
        is_page=True,
    )
    node_repo.add_node(page_class)
    return class_class.id, page_class.id


def _factory(value):
    async def _make(_ws: int, _uid: int):
        return value
    return _make


def _make_context(
    node_repo: FakeNodeRepository,
    prop_repo: FakePropertyRepository,
    page_class_id: int,
    permissions: set[str] | None = None,
) -> PluginContext:
    permissions = {"write_nodes", "read_properties", "write_properties"} if permissions is None else permissions
    node_svc = FakeNodeService(node_repo, prop_repo, page_class_id)
    prop_svc = FakePropertyService(prop_repo)
    return PluginContext(
        plugin_id="notees.test",
        permissions=permissions,
        registry=PluginRegistry(),
        port_factories={
            "NodeService": _factory(node_svc),
            "NodeRepository": _factory(node_repo),
            "PropertyService": _factory(prop_svc),
        },
    )


@pytest.mark.unit
async def test_ensure_property_creates_when_missing() -> None:
    node_repo = FakeNodeRepository()
    prop_repo = FakePropertyRepository()
    _, page_class_id = _seed_system_classes(node_repo)
    context = _make_context(node_repo, prop_repo, page_class_id)

    prop_id = await context.ensure_property(1, 1, "External ID")

    assert prop_id is not None
    prop = await prop_repo.get_by_id(prop_id)
    assert prop is not None
    assert prop.name == "External ID"


@pytest.mark.unit
async def test_ensure_property_returns_existing_id() -> None:
    node_repo = FakeNodeRepository()
    prop_repo = FakePropertyRepository()
    _, page_class_id = _seed_system_classes(node_repo)
    context = _make_context(node_repo, prop_repo, page_class_id)

    first = await context.ensure_property(1, 1, "External ID")
    second = await context.ensure_property(1, 1, "External ID")

    assert first == second


@pytest.mark.unit
async def test_upsert_page_by_external_id_creates_page() -> None:
    node_repo = FakeNodeRepository()
    prop_repo = FakePropertyRepository()
    _, page_class_id = _seed_system_classes(node_repo)
    context = _make_context(node_repo, prop_repo, page_class_id)

    prop_id = await context.ensure_property(1, 1, "External ID")
    page = await context.upsert_page_by_external_id(
        1,
        1,
        "ext-123",
        external_id_property_id=prop_id,
        name="Imported Page",
    )

    assert page.name == "Imported Page"
    assert page.is_page is True

    values = await prop_repo.get_scalar_values(page.id, prop_id)
    assert len(values) == 1
    assert values[0].value_text == "ext-123"


@pytest.mark.unit
async def test_upsert_page_by_external_id_updates_existing_by_property() -> None:
    node_repo = FakeNodeRepository()
    prop_repo = FakePropertyRepository()
    _, page_class_id = _seed_system_classes(node_repo)
    context = _make_context(node_repo, prop_repo, page_class_id)

    prop_id = await context.ensure_property(1, 1, "External ID")
    first = await context.upsert_page_by_external_id(
        1, 1, "ext-123", external_id_property_id=prop_id, name="First"
    )
    second = await context.upsert_page_by_external_id(
        1, 1, "ext-123", external_id_property_id=prop_id, name="Updated"
    )

    assert first.id == second.id
    assert second.name == "Updated"


@pytest.mark.unit
async def test_upsert_page_by_external_id_falls_back_to_name_and_class() -> None:
    node_repo = FakeNodeRepository()
    prop_repo = FakePropertyRepository()
    _, page_class_id = _seed_system_classes(node_repo)
    context = _make_context(node_repo, prop_repo, page_class_id)

    # Create a Source class and a page named "@doe2023" without the external id property.
    source_class_id = await context.ensure_class(1, 1, "Source")
    existing = await context.create_page(1, 1, "@doe2023", additional_classes=[source_class_id])

    prop_id = await context.ensure_property(1, 1, "DOI")
    page = await context.upsert_page_by_external_id(
        1,
        1,
        "10.1000/xyz",
        external_id_property_id=prop_id,
        name="@doe2023",
        class_ids=[source_class_id],
    )

    assert page.id == existing.id
    values = await prop_repo.get_scalar_values(page.id, prop_id)
    assert values[0].value_text == "10.1000/xyz"


@pytest.mark.unit
async def test_create_page_applies_property_values() -> None:
    node_repo = FakeNodeRepository()
    prop_repo = FakePropertyRepository()
    _, page_class_id = _seed_system_classes(node_repo)
    context = _make_context(node_repo, prop_repo, page_class_id)

    prop_id = await context.ensure_property(1, 1, "External ID")
    page = await context.create_page(
        1,
        1,
        "My Page",
        property_values={prop_id: "abc"},
    )

    assert page.is_page is True
    values = await prop_repo.get_scalar_values(page.id, prop_id)
    assert values[0].value_text == "abc"


@pytest.mark.unit
async def test_ensure_property_requires_write_nodes_permission() -> None:
    node_repo = FakeNodeRepository()
    prop_repo = FakePropertyRepository()
    _, page_class_id = _seed_system_classes(node_repo)
    context = _make_context(node_repo, prop_repo, page_class_id, permissions=set())

    with pytest.raises(PluginPermissionError):
        await context.ensure_property(1, 1, "External ID")
