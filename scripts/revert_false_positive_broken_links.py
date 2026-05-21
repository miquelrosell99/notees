#!/usr/bin/env python3
"""Revert false-positive broken_link conversions back to node_link.

The original find_and_fix_orphaned_links.py had a bug: asyncpg returns
uuid.UUID objects for UUID columns, but the script compared them to strings.
This caused ALL node_link nodes to be incorrectly converted to broken_link.

This script:
1. Scans all nodes for broken_link AST nodes
2. Checks if the target UUID exists in the node table
3. If the target exists, converts broken_link back to node_link
4. If the target is truly missing, keeps broken_link
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
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
    """Recursively extract all link_id targets from broken_link AST nodes."""
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


def fix_false_positives(
    ast: List[dict],
    existing_uuids: Set[str],
) -> Tuple[List[dict], bool]:
    """Convert broken_link back to node_link where the target exists.

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

            if node.get("type") == "broken_link":
                link_id = str(node.get("link_id", ""))
                target_uuid = link_id.split(":", 1)[0] if link_id else ""
                if target_uuid in existing_uuids:
                    # Target exists — convert back to node_link
                    changed = True
                    restored = {
                        "type": "node_link",
                        "link_id": link_id,
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


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Revert false-positive broken_link conversions."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be reverted without modifying the database.",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Actually perform the revert.",
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
        print("Scanning for false-positive broken_link conversions...")

        # Fetch all active nodes with broken_link AST nodes
        if args.workspace_id is not None:
            rows = await conn.fetch(
                """
                SELECT id, uuid, name
                FROM node
                WHERE workspace_id = $1
                  AND active = TRUE
                  AND (is_deleted = FALSE OR is_deleted IS NULL)
                  AND name IS NOT NULL
                  AND name LIKE '%broken_link%'
                """,
                args.workspace_id,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, uuid, name
                FROM node
                WHERE active = TRUE
                  AND (is_deleted = FALSE OR is_deleted IS NULL)
                  AND name IS NOT NULL
                  AND name LIKE '%broken_link%'
                """
            )

        # Collect all unique target UUIDs from broken_link AST nodes
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
            print("No broken_link nodes found.")
            return 0

        print(f"Found {len(rows)} node(s) with broken_link AST nodes.")
        print(f"Collected {len(all_targets)} unique target UUIDs to check.")

        # Check which target UUIDs exist in the node table
        # CRITICAL FIX: convert asyncpg UUID objects to strings
        existing_rows = await conn.fetch(
            "SELECT uuid FROM node WHERE uuid = ANY($1)",
            list(all_targets),
        )
        existing_uuids = {str(r["uuid"]) for r in existing_rows}

        print(f"Found {len(existing_uuids)} target UUID(s) that still exist in the database.")

        # Build result list
        results = []
        for node_id in node_targets:
            node_orphans = node_targets[node_id] - existing_uuids
            node_restorable = node_targets[node_id] & existing_uuids
            if node_restorable:
                results.append((node_id, node_restorable, node_orphans))

        if not results:
            print("No false positives found (all broken_link targets are truly missing).")
            return 0

        total_restorable = sum(len(r) for _, r, _ in results)
        total_truly_orphaned = sum(len(o) for _, _, o in results)
        print(
            f"Found {len(results)} node(s) with {total_restorable} restorable link(s) "
            f"and {total_truly_orphaned} truly orphaned link(s).\n"
        )

        for node_id, restorable, orphaned in results:
            print(f"  Node {node_id}:")
            for u in sorted(restorable):
                print(f"    -> will restore link to existing uuid {u}")
            for u in sorted(orphaned):
                print(f"    -> keeping broken_link for missing uuid {u}")

        if not args.fix:
            print("\nRun with --fix to perform the revert.")
            return 0

        # Fix mode
        print("\nReverting false positives...")
        fixed_count = 0
        kept_broken_count = 0

        for node_id, restorable, orphaned in results:
            row = await conn.fetchrow(
                "SELECT name FROM node WHERE id = $1", node_id
            )
            if not row:
                continue

            try:
                ast = json.loads(row["name"])
            except (json.JSONDecodeError, TypeError):
                continue

            new_ast, changed = fix_false_positives(ast, existing_uuids)
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
            if orphaned:
                kept_broken_count += 1
            print(f"  Fixed node {node_id} (restored {len(restorable)}, kept {len(orphaned)} broken)")

        print(f"\nDone. Reverted {fixed_count} node(s). {kept_broken_count} still have some truly broken links.")

    await pool.close()
    return 0


if __name__ == "__main__":
    asyncio.run(main())
