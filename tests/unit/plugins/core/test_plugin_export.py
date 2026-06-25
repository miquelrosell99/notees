import pytest

from app.features.export.service import ExportService
from app.plugins.core.manager import PluginManager
from app.plugins.core.manifest import PluginManifest
from app.plugins.core.ports import ExportContext, ExporterAdapter, ExportResult
from app.plugins.core.registry import LoadedPlugin


class _FakeExportRepo:
    """Minimal in-memory stand-in for ExportRepository."""

    def __init__(self, node_ids=None):
        self._node_ids = node_ids or {"uuid-1": 1}

    async def get_export_node_tree(self, workspace_id, node_uuid, include_children, include_child_pages=False):
        if node_uuid in self._node_ids:
            return [{"uuid": node_uuid, "id": self._node_ids[node_uuid], "is_page": True, "name": "Hello"}]
        return []

    async def resolve_node_ids(self, workspace_id, node_uuids):
        return [self._node_ids[uuid] for uuid in node_uuids if uuid in self._node_ids]

    async def filter_text_property_node_ids(self, node_ids):
        return set()

    async def get_system_class_map(self, workspace_id, uuids):
        return {}

    async def resolve_link_targets(self, workspace_id, uuids):
        return []

    async def get_node_properties_data(self, node_ids):
        return []

    async def get_relation_target_names(self, target_ids):
        return {}

    async def get_node_class_and_tag_names(self, page_node_ids, workspace_id):
        return {}, {}

    async def get_text_property_subtrees(self, target_ids):
        return {}

    async def get_page_metadata(self, workspace_id, node_uuid, include_properties=True):
        return {}

    async def get_auto_export_metadata(self, workspace_id, node_uuid):
        return {}

    async def list_exportable_pages(self, workspace_id):
        return []


class _FakeRenderer:
    pass


class _HelloExporter(ExporterAdapter):
    format_id = "hello"
    label = "Hello"
    extension = "txt"
    mime_type = "text/plain"

    async def export_nodes(self, context: ExportContext) -> ExportResult:
        return ExportResult(
            content=b"hello",
            filename="hello.txt",
            mime_type="text/plain",
        )


@pytest.fixture
def plugin_manager(monkeypatch):
    manager = PluginManager()
    manifest = PluginManifest(
        id="notees.hello",
        name="Hello",
        version="1.0.0",
        permissions=["export"],
        backend={"entrypoint": "dummy:setup"},
    )
    plugin = LoadedPlugin(manifest=manifest, path="/tmp/hello")
    manager.registry.add_plugin(plugin)
    adapter = _HelloExporter()
    manager.registry.add_exporter("notees.hello", adapter)
    monkeypatch.setattr("app.features.export.service.plugin_manager", manager)
    return manager


@pytest.mark.unit
async def test_export_nodes_delegates_to_plugin_exporter(plugin_manager):
    service = ExportService(_FakeExportRepo(), _FakeRenderer())
    content, filename, mime_type = await service.export_nodes(
        workspace_id=1,
        node_uuids=["uuid-1"],
        format="hello",
        user_id=42,
    )

    assert content == b"hello"
    assert filename == "hello.txt"
    assert mime_type == "text/plain"
