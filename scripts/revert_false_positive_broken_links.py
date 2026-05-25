#!/usr/bin/env python3
"""Revert false-positive broken_link nodes back to node_link.

Scans all active nodes for `broken_link` AST nodes whose target UUID
actually exists in the node table (false positives from the buggy
find_and_fix_orphaned_links.py run) and converts them back to `node_link`.

Usage:
    # Dry-run: report candidates without fixing
    python scripts/revert_false_positive_broken_links.py --dry-run

    # Actually fix
    python scripts/revert_false_positive_broken_links.py --fix

    # Target a specific workspace
    python scripts/revert_false_positive_broken_links.py --fix --workspace-id 5
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid as uuid_module
from typing import Any, Dict, List, Optional, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

import asyncpg

from app.db.connection import get_database_url


async def get_pool():
    return await asyncpg.create_pool(
        get_database_url(),
        min_size=1,
        max_size=5,
    )


def extract_broken_link_targets(ast: Any) -> Set[str]:
    """Recursively extract target UUIDs from broken_link AST nodes."""
    targets: Set[str] = set()

    def walk(nodes: Any) -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "broken_link":
                link_id = str(node.get("link_id", ""))
                if link_id:
                    target_uuid = link_id.split(":", 1)[0]
                    if target_uuid:
                        targets.add(target_uuid)
            if "children" in node:
                walk(node["children"])

    walk(ast)
    return targets


def revert_broken_links(
    ast: List[dict],
    existing_uuids: Set[str],
) -> Tuple[List[dict], bool]:
    """Return a new AST with false-positive broken_link nodes restored to node_link.

    Defaults ref_type to 'node' because broken_link does not store the original
    ref_type.  Returns (new_ast, changed).
    """
    changed = False

    def walk(nodes: List[dict]) -> List[dict]:
        nonlocal changed
        result: List[dict] = []
        for node in nodes:
            if not isinstance(node, dict):
                result.append(node)
                continue

            if node.get("type") == "broken_link":
                link_id = str(node.get("link_id", ""))
                target_uuid = link_id.split(":", 1)[0] if link_id else ""
                if target_uuid in existing_uuids:
                    changed = True
                    # Regenerate link_uuid to avoid unique constraint collisions
                    # when the same broken_link was duplicated across multiple nodes.
                    new_link_uuid = str(uuid_module.uuid4())
                    new_link_id = f"{target_uuid}:{new_link_uuid}"
                    restored = {
                        "type": "node_link",
                        "link_id": new_link_id,
                        "ref_type": "node",
                    }
                    if node.get("label"):
                        restored["label"] = node["label"]
                    result.append(restored)
                    continue

            if "children" in node:
                new_children = walk(node["children"])
                if new_children is not node["children"]:
                    node = {**node, "children": new_children}

            result.append(node)
        return result

    return walk(ast), changed


async def find_false_positives(
    conn: asyncpg.Connection,
    workspace_id: Optional[int] = None,
) -> List[Tuple[int, str, Set[str]]]:
    """Find nodes containing broken_link references that actually exist."""
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

        targets = extract_broken_link_targets(ast)
        if targets:
            all_targets.update(targets)
            node_targets[node_id] = targets
            ast_by_node[node_id] = ast

    if not all_targets:
        return []

    existing_rows = await conn.fetch(
        """
        SELECT uuid FROM node WHERE uuid = ANY($1)
        """,
        list(all_targets),
    )
    existing_uuids = {str(r["uuid"]) for r in existing_rows}

    if not existing_uuids:
        return []

    uuid_by_id = {row["id"]: row["uuid"] for row in rows}
    results = []
    for node_id, targets in node_targets.items():
        fixable = targets & existing_uuids
        if fixable:
            results.append((node_id, uuid_by_id[node_id], fixable))

    return results


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Revert false-positive broken_link AST nodes back to node_link."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report candidates without modifying the database (default behavior).",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Actually revert false-positive broken_link nodes to node_link.",
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
        print("Scanning for false-positive broken_link references...")
        candidates = await find_false_positives(conn, workspace_id=args.workspace_id)

        if not candidates:
            print("No false-positive broken_link references found.")
            return 0

        total_fixable = sum(len(uuids) for _, _, uuids in candidates)
        print(
            f"Found {len(candidates)} node(s) with {total_fixable} "
            f"false-positive broken_link reference(s).\n"
        )

        for node_id, node_uuid, uuids in candidates:
            print(f"  Node {node_id} (uuid={node_uuid}):")
            for u in sorted(uuids):
                print(f"    -> target exists: {u}")

        if not args.fix:
            print("\nRun with --fix to restore these references.")
            return 0

        print("\nRestoring false-positive broken_link references...")
        fixed_count = 0

        for node_id, node_uuid, uuids in candidates:
            row = await conn.fetchrow(
                "SELECT name FROM node WHERE id = $1", node_id
            )
            if not row:
                continue

            try:
                ast = json.loads(row["name"])
            except (json.JSONDecodeError, TypeError):
                continue

            new_ast, changed = revert_broken_links(ast, uuids)
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
