"""Unit tests for the Logseq importer plugin."""

from __future__ import annotations

import io
import zipfile

import pytest

from app.plugins.builtin.logseq_importer.importer import LogseqFolderImporter
from app.plugins.builtin.logseq_importer.parser import (
    LogseqMdBlock,
    collect_wiki_links,
    count_md_blocks,
    extract_asset_filename,
    parse_journal_date,
    parse_logseq_md,
    parse_logseq_zip,
)
from app.plugins.core.ports import ImportContext


@pytest.mark.unit
def test_parse_logseq_md_page_properties_and_blocks() -> None:
    """Page properties, nested blocks, and continuation lines are parsed."""
    content = """title:: My Page
author:: Tester

- First block
  - Child one
    - Grandchild
  - Child two
- Second block
  with a continuation line
"""
    page = parse_logseq_md("My Page.md", content)

    assert page.title == "My Page"
    assert page.properties == {"title": "My Page", "author": "Tester"}
    assert len(page.blocks) == 2

    first, second = page.blocks
    assert first.content == "First block"
    assert len(first.children) == 2
    assert first.children[0].content == "Child one"
    assert len(first.children[0].children) == 1
    assert first.children[0].children[0].content == "Grandchild"
    assert first.children[1].content == "Child two"

    # Trailing newline is preserved as a continuation line, matching TS behaviour.
    assert second.content == "Second block\nwith a continuation line\n"
    assert second.children == []


@pytest.mark.unit
def test_parse_logseq_md_continuation_without_blocks_is_ignored() -> None:
    """Continuation lines before the first block are ignored."""
    content = "Some leading text\n- First block\n  continuation"
    page = parse_logseq_md("page.md", content)
    assert len(page.blocks) == 1
    assert page.blocks[0].content == "First block\ncontinuation"


@pytest.mark.unit
def test_parse_journal_date_valid() -> None:
    """Journal filenames are parsed into ISO dates."""
    assert parse_journal_date("2025_06_04.md") == "2025-06-04"
    assert parse_journal_date("1999_12_31.md") == "1999-12-31"


@pytest.mark.unit
def test_parse_journal_date_invalid() -> None:
    """Non-journal filenames return None."""
    assert parse_journal_date("My Page.md") is None
    assert parse_journal_date("2025_13_04.md") is None
    assert parse_journal_date("2025_06_32.md") is None


@pytest.mark.unit
def test_collect_wiki_links() -> None:
    """Wiki-links are collected recursively from blocks."""
    blocks = [
        LogseqMdBlock(content="Link to [[Another Page]]"),
        LogseqMdBlock(
            content="See [[Project A]]",
            children=[LogseqMdBlock(content="Also [[Another Page]]")],
        ),
    ]
    links = collect_wiki_links(blocks)
    assert links == {"Another Page", "Project A"}


@pytest.mark.unit
def test_extract_asset_filename() -> None:
    """Pure asset references yield their filename."""
    assert (
        extract_asset_filename("![image.png](../assets/image.png)")
        == "image.png"
    )
    assert (
        extract_asset_filename(
            "![drawing](../assets/drawing.svg){:width 400}"
        )
        == "drawing.svg"
    )
    assert extract_asset_filename("Regular block text") is None
    assert (
        extract_asset_filename("Text before ![x](../assets/x.png)") is None
    )


@pytest.mark.unit
def test_parse_logseq_zip() -> None:
    """A ZIP with pages, journals, and assets is parsed correctly."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "Graph/pages/My Page.md",
            "prop:: value\n\n- block one\n  - nested\n- block two",
        )
        archive.writestr(
            "Graph/journals/2025_06_04.md",
            "- journal block\n  - [[Linked Page]]",
        )
        archive.writestr("Graph/assets/image.png", "fake image bytes")
        archive.writestr("Graph/assets/other.pdf", "fake pdf bytes")

    result = parse_logseq_zip(buffer.getvalue())

    assert len(result.pages) == 1
    assert result.pages[0].title == "My Page"
    assert count_md_blocks(result.pages[0].blocks) == 3

    assert len(result.journals) == 1
    assert result.journals[0].journal_date == "2025-06-04"
    assert count_md_blocks(result.journals[0].blocks) == 2

    assert result.asset_count == 2
    assert "Linked Page" in result.all_links


@pytest.mark.unit
def test_parse_logseq_zip_invalid() -> None:
    """Invalid ZIP bytes raise ValueError."""
    with pytest.raises(ValueError):
        parse_logseq_zip(b"not a zip")


class _FakePluginContext:
    """Minimal stand-in for PluginContext in importer tests."""

    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []
        self._existing_pages: set[str] = set()
        self._counter = 0

    async def ensure_class(
        self, workspace_uuid: str, actor_uuid: str, name: str, icon: str | None = None
    ) -> str:
        self.calls.append(("ensure_class", name))
        return "class-source-logseq"

    async def create_page(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        name: str,
        class_uuids: list[str] | None = None,
        property_values: dict[str, object] | None = None,
        icon: str | None = None,
    ) -> str:
        self._counter += 1
        uuid = f"page-{self._counter:03d}"
        self.calls.append(("create_page", name))
        self._existing_pages.add(name)
        return uuid

    async def create_node(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        node_id: str,
        kind: str,
        parent_id: str | None = None,
        index: int = 0,
        initial_content: list[dict[str, object]] | None = None,
        class_uuids: list[str] | None = None,
    ) -> str:
        self.calls.append(("create_node", kind, parent_id, index))
        return node_id

    async def find_page_by_name(
        self, workspace_uuid: str, actor_uuid: str, name: str
    ) -> str | None:
        self.calls.append(("find_page_by_name", name))
        return None

    async def update_content(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        node_id: str,
        content: list[dict[str, object]],
    ) -> None:
        self.calls.append(("update_content", node_id))

    async def move_node(
        self,
        workspace_uuid: str,
        actor_uuid: str,
        node_id: str,
        new_parent_id: str | None = None,
        new_index: int = 0,
    ) -> None:
        self.calls.append(("move_node", node_id))


def _build_logseq_zip() -> bytes:
    """Build a sample Logseq ZIP for importer tests."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "Graph/pages/Project.md",
            "type:: project\n\n- Task A\n  - [[Subtask]] detail\n- Task B",
        )
        archive.writestr(
            "Graph/journals/2025_06_04.md",
            "- Morning standup\n  - Discuss [[Project]]",
        )
        archive.writestr("Graph/assets/diagram.png", "bytes")
    return buffer.getvalue()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_logseq_importer_creates_pages_blocks_and_stubs() -> None:
    """The importer creates pages, blocks, and wiki-link stubs."""
    importer = LogseqFolderImporter()
    plugin_ctx = _FakePluginContext()
    context = ImportContext(
        workspace_id=1,
        user_id=2,
        workspace_uuid="ws-uuid",
        actor_uuid="actor-uuid",
        plugin_context=plugin_ctx,  # type: ignore[arg-type]
        filename="graph.zip",
    )

    result = await importer.import_data(_build_logseq_zip(), None, context)

    assert result.error_count == 0
    assert len(result.created_node_ids) > 0

    create_page_calls = [c for c in plugin_ctx.calls if c[0] == "create_page"]
    create_node_calls = [c for c in plugin_ctx.calls if c[0] == "create_node"]

    # Two real pages plus two unique wiki-link stubs (Subtask, Project).
    assert len(create_page_calls) == 4
    page_names = {c[1] for c in create_page_calls}
    assert {"Project", "2025_06_04", "Subtask"} <= page_names

    # Project: 2 top blocks + 1 nested = 3; journal: 1 top + 1 nested = 2.
    assert len(create_node_calls) == 5

    # First child of the Project page should be a block under the page.
    project_block = create_node_calls[0]
    assert project_block[1] == "block"
    assert project_block[2] == "page-001"
    assert project_block[3] == 0

    assert any("Imported" in msg for msg in result.messages)
