#!/usr/bin/env python3
"""Find and optionally fix orphaned inline links in node AST content.

An orphaned link is a `node_link` AST node whose `link_id` references a UUID
that no longer exists in the `node` table. These are typically created when
nodes are hard-deleted without updating the AST content of nodes that linked
to them.

Usage:
    # Dry-run: report orphans without fixing
    python scripts/find_and_fix_orphaned_links.py --dry-run

    # Fix orphans (replace node_link with plain text)
    python scripts/find_and_fix_orphaned_links.py --fix

    # Target a specific workspace
    python scripts/find_and_fix_orphaned_links.py --fix --workspace-id 5
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any, Dict, List, Optional, Set, Tuple

# Add project root to path so we can import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load .env before importing app modules so DATABASE_URL is available
from dotenv import load_dotenv
load_dotenv()

import asyncpg

from app.db.connection import get_database_url


async def get_pool():
    """Create an asyncpg connection pool."""
    return await asyncpg.create_pool(
        get_database_url(),
        min_size=1,
        max_size=5,
    )


def extract_link_targets(ast: Any) -> Set[str]:
    """Recursively extract all link_id targets from an AST document."""
    targets: Set[str] = set()

    def walk(nodes: Any) -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "node_link":
                link_id = str(node.get("link_id", ""))
                if link_id:
                    # link_id format: "nodeUuid:linkUuid" or just "nodeUuid"
                    target_uuid = link_id.split(":", 1)[0]
                    if target_uuid:
                        targets.add(target_uuid)
            if "children" in node:
                walk(node["children"])

    walk(ast)
    return targets


def replace_orphaned_links(
    ast: List[dict],
    orphaned_uuids: Set[str],
) -> Tuple[List[dict], bool]:
    """Return a new AST with orphaned node_link nodes replaced by broken_link nodes.

    Preserves the original link_id (and label if any) so the UUID is not lost.
    Returns (new_ast, changed).
    """
    changed = False

    def walk(nodes: List[dict]) -> List[dict]:
        nonlocal changed
        result: List[dict] = []
        for node in nodes:
            if not isinstance(node, dict):
                result.append(node)
                continue

            if node.get("type") == "node_link":
                link_id = str(node.get("link_id", ""))
                target_uuid = link_id.split(":", 1)[0] if link_id else ""
                if target_uuid in orphaned_uuids:
                    changed = True
                    broken = {"type": "broken_link", "link_id": link_id}
                    if node.get("label"):
                        broken["label"] = node["label"]
                    result.append(broken)
                    continue

            if "children" in node:
                new_children = walk(node["children"])
                if new_children is not node["children"]:
                    node = {**node, "children": new_children}

            result.append(node)
        return result

    return walk(ast), changed


async def find_orphans(
    conn: asyncpg.Connection,
    workspace_id: Optional[int] = None,
) -> List[Tuple[int, str, Set[str]]]:
    """Find nodes containing orphaned inline links.

    Returns a list of (node_id, node_uuid, orphaned_target_uuids) tuples.
    """
    # 1. Fetch all active nodes with non-empty name fields
    if workspace_id is not None:
        rows = await conn.fetch(
            """
            SELECT id, uuid, name
            FROM node
            WHERE workspace_id = $1
              AND active = TRUE
              AND (is_deleted = FALSE OR is_deleted IS NULL)
              AND name IS NOT NULL
              AND name != ''
            """,
            workspace_id,
        )
    else:
        rows = await conn.fetch(
            """
            SELECT id, uuid, name
            FROM node
            WHERE active = TRUE
              AND (is_deleted = FALSE OR is_deleted IS NULL)
              AND name IS NOT NULL
              AND name != ''
            """
        )

    # 2. Collect all unique target UUIDs from node_link AST nodes
    all_targets: Set[str] = set()
    node_targets: Dict[int, Set[str]] = {}
    ast_by_node: Dict[int, Any] = {}

    for row in rows:
        node_id = row["id"]
        name = row["name"]
        try:
            ast = json.loads(name)
            if not isinstance(ast, list):
                continue
        except (json.JSONDecodeError, TypeError):
            continue

        targets = extract_link_targets(ast)
        if targets:
            all_targets.update(targets)
            node_targets[node_id] = targets
            ast_by_node[node_id] = ast

    if not all_targets:
        return []

    # 3. Check which target UUIDs still exist in the node table
    existing_rows = await conn.fetch(
        """
        SELECT uuid FROM node WHERE uuid = ANY($1)
        """,
        list(all_targets),
    )
    # asyncpg returns uuid.UUID objects — convert to strings for comparison
    existing_uuids = {str(r["uuid"]) for r in existing_rows}
    orphaned_uuids = all_targets - existing_uuids

    if not orphaned_uuids:
        return []

    # 4. Build result list
    uuid_by_id = {row["id"]: row["uuid"] for row in rows}
    results = []
    for node_id, targets in node_targets.items():
        node_orphans = targets & orphaned_uuids
        if node_orphans:
            results.append((node_id, uuid_by_id[node_id], node_orphans))

    return results


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find and fix orphaned inline links in node AST content."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report orphans without modifying the database (default behavior).",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Actually fix orphans by replacing node_link AST nodes with plain text.",
    )
    parser.add_argument(
        "--workspace-id",
        type=int,
        default=None,
        help="Limit scan to a specific workspace (default: all workspaces).",
    )
    args = parser.parse_args()

    pool = await get_pool()
    async with pool.acquire() as conn:
        print("Scanning for orphaned inline links...")
        orphans = await find_orphans(conn, workspace_id=args.workspace_id)

        if not orphans:
            print("No orphaned inline links found.")
            return 0

        total_orphaned_uuids = sum(len(uuids) for _, _, uuids in orphans)
        print(
            f"Found {len(orphans)} node(s) with {total_orphaned_uuids} orphaned link reference(s).\n"
        )

        for node_id, node_uuid, uuids in orphans:
            print(f"  Node {node_id} (uuid={node_uuid}):")
            for u in sorted(uuids):
                print(f"    -> references missing uuid {u}")

        if not args.fix:
            print("\nRun with --fix to repair these nodes.")
            return 0

        # Fix mode
        print("\nFixing orphaned links...")
        fixed_count = 0

        for node_id, node_uuid, uuids in orphans:
            row = await conn.fetchrow(
                "SELECT name FROM node WHERE id = $1", node_id
            )
            if not row:
                continue

            try:
                ast = json.loads(row["name"])
            except (json.JSONDecodeError, TypeError):
                continue

            new_ast, changed = replace_orphaned_links(ast, uuids)
            if not changed:
                continue

            new_name = json.dumps(new_ast, ensure_ascii=False)
            await conn.execute(
                """
                UPDATE node
                SET name = $1, write_date = NOW(), version = version + 1
                WHERE id = $2
                """,
                new_name,
                node_id,
            )
            fixed_count += 1
            print(f"  Fixed node {node_id} (uuid={node_uuid})")

        print(f"\nDone. Fixed {fixed_count} node(s).")

    await pool.close()
    return 0


if __name__ == "__main__":
    asyncio.run(main())
