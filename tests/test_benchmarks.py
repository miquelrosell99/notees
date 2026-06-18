"""Performance benchmarks for Notees.

Run inside the backend container:
    docker exec -e TEST_DATABASE_URL=postgresql://notees:YOUR_PASSWORD@postgres:5432/notees_test \
        notees-backend-dev pytest tests/test_benchmarks.py -v -s

These tests measure:
- Page content loading with large block counts (virtualization stress)
- Search response times at various node counts
"""

import time

import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_ast(name: str) -> str:
    """Build a minimal stringified AST for a block name."""
    return f'[{{"type":"text","text":"{name}"}}]'


# ---------------------------------------------------------------------------
# Virtualization Stress Test
# ---------------------------------------------------------------------------


@pytest.mark.slow
@pytest.mark.parametrize("block_count", [100, 500, 1000, 5000])
async def test_page_content_load_time(
    authenticated_client,
    node_service,
    block_count: int,
):
    """Measure GET /api/nodes/page/{id}/content response time for large pages."""
    # Create a test page
    page = await node_service.create_page(name=_build_ast("Benchmark Page"))
    page_id = page.id

    # Batch-create blocks under the page via API
    batch_size = 500
    created = 0
    while created < block_count:
        chunk = min(batch_size, block_count - created)
        nodes = [
            {
                "name": _build_ast(f"Block {created + i}"),
                "parent_id": page_id,
                "sequence": created + i,
            }
            for i in range(chunk)
        ]
        resp = await authenticated_client.post(
            "/api/nodes/batch",
            json={"nodes": nodes},
        )
        assert resp.status_code == 200
        created += chunk

    # Warm-up query (populates caches)
    await authenticated_client.get(f"/api/nodes/page/{page_id}/content")

    # Measure
    times = []
    for _ in range(5):
        start = time.perf_counter()
        resp = await authenticated_client.get(f"/api/nodes/page/{page_id}/content")
        elapsed = (time.perf_counter() - start) * 1000
        times.append(elapsed)
        assert resp.status_code == 200

    times_ms = [round(t, 2) for t in times]
    avg_ms = round(sum(times) / len(times), 2)
    min_ms = round(min(times), 2)
    max_ms = round(max(times), 2)

    print(
        f"\n[Virtualization] {block_count:>5} blocks | "
        f"avg={avg_ms:>7.2f}ms | min={min_ms:>7.2f}ms | max={max_ms:>7.2f}ms | "
        f"all={times_ms}"
    )


# ---------------------------------------------------------------------------
# Search Benchmark
# ---------------------------------------------------------------------------


@pytest.mark.slow
@pytest.mark.parametrize("node_count", [1000, 5000, 10000])
async def test_search_response_time(
    authenticated_client,
    node_service,
    node_count: int,
):
    """Measure GET /api/nodes/search response time at scale."""
    # Create many pages with unique searchable text via API
    batch_size = 500
    created = 0
    while created < node_count:
        chunk = min(batch_size, node_count - created)
        nodes = [
            {
                "name": _build_ast(f"Benchmark search node {created + i} alpha beta gamma"),
                "is_page": True,
                "sequence": created + i,
            }
            for i in range(chunk)
        ]
        resp = await authenticated_client.post(
            "/api/nodes/batch",
            json={"nodes": nodes},
        )
        assert resp.status_code == 200
        created += chunk

    queries = [
        ("alpha", "single token"),
        ("alpha beta", "multi-token"),
        ("node 500", "prefix match"),
        ("benchmark search node", "common terms"),
        ("zzzznonexistent", "no results"),
    ]

    print(f"\n[Search] {node_count:>6} nodes")
    for q, desc in queries:
        # Warm-up
        await authenticated_client.get(f"/api/nodes/search?q={q}&limit=50")

        times = []
        for _ in range(5):
            start = time.perf_counter()
            resp = await authenticated_client.get(f"/api/nodes/search?q={q}&limit=50")
            elapsed = (time.perf_counter() - start) * 1000
            times.append(elapsed)
            assert resp.status_code == 200

        avg_ms = round(sum(times) / len(times), 2)
        min_ms = round(min(times), 2)
        max_ms = round(max(times), 2)
        print(
            f"  query={q:>25} ({desc:>15}) | "
            f"avg={avg_ms:>7.2f}ms | min={min_ms:>7.2f}ms | max={max_ms:>7.2f}ms"
        )


# ---------------------------------------------------------------------------
# Empty-query / Suggestions Benchmark
# ---------------------------------------------------------------------------


@pytest.mark.slow
@pytest.mark.parametrize("node_count", [1000, 5000, 10000])
async def test_suggestions_response_time(
    authenticated_client,
    node_service,
    node_count: int,
):
    """Measure GET /api/nodes/suggestions (empty query) response time."""
    batch_size = 500
    created = 0
    while created < node_count:
        chunk = min(batch_size, node_count - created)
        nodes = [
            {
                "name": _build_ast(f"Suggestion node {created + i}"),
                "is_page": True,
                "sequence": created + i,
            }
            for i in range(chunk)
        ]
        resp = await authenticated_client.post(
            "/api/nodes/batch",
            json={"nodes": nodes},
        )
        assert resp.status_code == 200
        created += chunk

    times = []
    for _ in range(5):
        start = time.perf_counter()
        resp = await authenticated_client.get("/api/nodes/suggestions?limit=20")
        elapsed = (time.perf_counter() - start) * 1000
        times.append(elapsed)
        assert resp.status_code == 200

    avg_ms = round(sum(times) / len(times), 2)
    min_ms = round(min(times), 2)
    max_ms = round(max(times), 2)
    print(
        f"\n[Suggestions] {node_count:>6} nodes | "
        f"avg={avg_ms:>7.2f}ms | min={min_ms:>7.2f}ms | max={max_ms:>7.2f}ms"
    )
