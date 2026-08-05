#!/usr/bin/env python3
"""
Migration script: Convert normal node links to inline class links.

Finds all blocks where:
- The block is classed with a target class (target_id in block's class_ids)
- The target is a class (is_class = TRUE)
- The link is not a tag (is_tag = FALSE)

For each qualifying link:
1. Sets node_link.is_inline_class = TRUE
2. Updates the AST in node.name to change ref_type from "node" to "class"
   for node_link entries pointing to that class.

Handles both AST link_id formats:
- Simple: "target_uuid"
- Compound: "target_uuid:link_uuid"
"""

import asyncio
import json
import os

import asyncpg


async def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print(
            "Error: DATABASE_URL environment variable is required.\n"
            "Example:\n"
            "  DATABASE_URL=postgresql://notees:YOUR_PASSWORD@db:5432/notees "
            "python scripts/fix_inline_class_links.py"
        )
        raise SystemExit(1)

    conn = await asyncpg.connect(db_url)

    try:
        # Step 1: Find all nodes with qualifying links
        # A qualifying link is one where:
        # - target is a class
        # - source block's class_ids contains target_id
        # - link is not a tag
        rows = await conn.fetch(
            """
            SELECT DISTINCT n.id, n.name, n.class_ids
            FROM node n
            JOIN node_link nl ON nl.source_id = n.id
            JOIN node target ON nl.target_id = target.id
            WHERE target.is_class = TRUE
              AND n.class_ids @> ARRAY[nl.target_id]::integer[]
              AND nl.is_tag = FALSE
            """
        )

        print(f"Found {len(rows)} source nodes with qualifying links")

        if not rows:
            print("Nothing to do.")
            return

        # Step 2: For each node, get its class IDs and target UUIDs
        for row in rows:
            node_id = row["id"]
            node_name = row["name"]
            class_ids = row["class_ids"] or []

            if not class_ids:
                continue

            # Get the UUIDs of all classes this node belongs to
            class_rows = await conn.fetch(
                "SELECT id, uuid FROM node WHERE id = ANY($1) AND is_class = TRUE",
                class_ids
            )
            class_uuid_to_id = {str(r["uuid"]): r["id"] for r in class_rows}
            class_ids_set = set(class_ids)

            # Parse the AST
            try:
                ast = json.loads(node_name) if isinstance(node_name, str) else node_name
            except (json.JSONDecodeError, TypeError):
                print(f"  Skipping node {node_id}: invalid JSON in name")
                continue

            if not isinstance(ast, list):
                print(f"  Skipping node {node_id}: name is not a list")
                continue

            modified = False
            links_updated_in_ast = []

            # Walk the AST and update qualifying node_link entries
            for block in ast:
                if not isinstance(block, dict):
                    continue
                children = block.get("children", [])
                if not isinstance(children, list):
                    continue

                for child in children:
                    if not isinstance(child, dict):
                        continue
                    if child.get("type") != "node_link":
                        continue

                    link_id = child.get("link_id", "")
                    ref_type = child.get("ref_type", "node")

                    if ref_type == "class":
                        continue  # Already inline class

                    # Extract target UUID from link_id
                    # Format can be "target_uuid" or "target_uuid:link_uuid"
                    target_uuid = link_id.split(":")[0] if ":" in link_id else link_id

                    if target_uuid in class_uuid_to_id:
                        target_class_id = class_uuid_to_id[target_uuid]
                        if target_class_id in class_ids_set:
                            child["ref_type"] = "class"
                            modified = True
                            links_updated_in_ast.append({
                                "link_id": link_id,
                                "target_uuid": target_uuid,
                                "target_class_id": target_class_id,
                            })

            if modified:
                # Update the node's name in the database
                new_name = json.dumps(ast, ensure_ascii=False)
                await conn.execute(
                    "UPDATE node SET name = $1::jsonb WHERE id = $2",
                    new_name,
                    node_id
                )
                print(f"  Updated node {node_id}: {len(links_updated_in_ast)} AST link(s) -> class")

        # Step 3: Update node_link table for all qualifying links
        result = await conn.execute(
            """
            UPDATE node_link nl
            SET is_inline_class = TRUE
            FROM node n, node target
            WHERE nl.source_id = n.id
              AND nl.target_id = target.id
              AND target.is_class = TRUE
              AND n.class_ids @> ARRAY[nl.target_id]::integer[]
              AND nl.is_tag = FALSE
            """
        )
        print(f"\nnode_link table update result: {result}")

        # Verify
        remaining = await conn.fetchval(
            """
            SELECT count(*) FROM node_link nl
            JOIN node n ON nl.source_id = n.id
            JOIN node target ON nl.target_id = target.id
            WHERE target.is_class = TRUE
              AND n.class_ids @> ARRAY[nl.target_id]::integer[]
              AND nl.is_tag = FALSE
              AND nl.is_inline_class = FALSE
            """
        )
        print(f"Remaining qualifying links with is_inline_class=FALSE: {remaining}")

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
