"""PostgreSQL implementation of WorkspaceIORepository."""

from __future__ import annotations

from datetime import UTC, datetime

import asyncpg

from ...db.connection import acquire_connection
from ...logging_config import get_logger
from ..services.workspace_io_service import build_import_records
from .interfaces import WorkspaceIORepository

logger = get_logger(__name__)


class PostgresWorkspaceIORepository(WorkspaceIORepository):
    """PostgreSQL adapter for workspace import/export and restore."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def export_workspace_full(self, workspace_id: int) -> dict:
        """Create a comprehensive dump of all workspace data."""
        async with acquire_connection(self._pool) as conn:
            workspace = await conn.fetchrow("SELECT uuid, name FROM workspace WHERE id = $1", workspace_id)
            if not workspace:
                raise ValueError(f"Workspace {workspace_id} not found")

            nodes = await conn.fetch(
                """
                SELECT id, uuid, name, icon, color, parent_id, page_id, sequence,
                       collapsed, active, version, is_class, is_page, is_day,
                       is_month, is_year, is_asset, is_template, is_comment,
                       class_ids, tag_ids, classes_path, open_date, create_date, write_date,
                       aliased_id, is_deleted, deleted_at
                FROM node WHERE workspace_id = $1
            """,
                workspace_id,
            )

            links = await conn.fetch(
                """
                SELECT id, uuid, source_id, target_id, property_id, position,
                       is_inline_class, name, create_date
                FROM node_link WHERE workspace_id = $1
            """,
                workspace_id,
            )

            properties = await conn.fetch(
                """
                SELECT id, uuid, name, icon, type, is_multi, is_system, scope,
                       node_id, icon_visibility, active, create_date, write_date
                FROM property WHERE workspace_id = $1
            """,
                workspace_id,
            )

            selection_lines = await conn.fetch(
                """
                SELECT psl.id, psl.uuid, psl.property_id, psl.name, psl.icon,
                       psl.create_date, psl.write_date
                FROM property_selection_line psl
                JOIN property p ON psl.property_id = p.id
                WHERE p.workspace_id = $1
            """,
                workspace_id,
            )

            node_properties = await conn.fetch(
                """
                SELECT np.id, np.uuid, np.node_id, np.property_id,
                       np.create_date, np.write_date
                FROM node_property np
                JOIN node n ON np.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            value_scalars = await conn.fetch(
                """
                SELECT pvs.id, pvs.uuid, pvs.node_property_id, pvs.property_id,
                       pvs.node_id, pvs.value_text, pvs.value_boolean,
                       pvs.value_float, pvs.value_integer,
                       pvs.create_date, pvs.write_date
                FROM property_value_scalar pvs
                JOIN node n ON pvs.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            value_relations = await conn.fetch(
                """
                SELECT pvr.id, pvr.uuid, pvr.node_property_id, pvr.property_id,
                       pvr.node_id, pvr.target_id, pvr."order",
                       pvr.create_date, pvr.write_date
                FROM property_value_relation pvr
                JOIN node n ON pvr.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            value_selections = await conn.fetch(
                """
                SELECT pvsel.id, pvsel.uuid, pvsel.node_property_id,
                       pvsel.property_id, pvsel.node_id, pvsel.selection_line_id,
                       pvsel.create_date, pvsel.write_date
                FROM property_value_selection pvsel
                JOIN node n ON pvsel.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            class_properties = await conn.fetch(
                """
                SELECT cp.id, cp.class_node_id, cp.property_id, cp.sequence,
                       cp.hidden, cp.default_integer, cp.default_float,
                       cp.default_text, cp.default_boolean,
                       cp.default_node_id, cp.default_selection_id
                FROM class_property cp
                JOIN node n ON cp.class_node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            class_extends = await conn.fetch(
                """
                SELECT ce.id, ce.target_id, ce.source_id, ce.sequence
                FROM class_extend ce
                JOIN node n ON ce.target_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            class_filters = await conn.fetch(
                """
                SELECT pcf.id, pcf.property_id, pcf.class_node_id
                FROM property_class_filter pcf
                JOIN property p ON pcf.property_id = p.id
                WHERE p.workspace_id = $1
            """,
                workspace_id,
            )

            node_views = await conn.fetch(
                """
                SELECT nv.id, nv.uuid, nv.node_id, nv.name, nv.query_json,
                       nv.view_type, nv.order_index, nv.is_default, nv.active,
                       nv.shown_properties, nv.group_by,
                       nv.create_date, nv.write_date
                FROM node_view nv
                JOIN node n ON nv.node_id = n.id
                WHERE n.workspace_id = $1
            """,
                workspace_id,
            )

            settings = await conn.fetch(
                "SELECT key, value FROM setting_workspace WHERE workspace_id = $1",
                workspace_id,
            )

        return {
            "version": 3,
            "workspace": {
                "uuid": str(workspace["uuid"]),
                "name": workspace["name"],
            },
            "nodes": [dict(r) for r in nodes],
            "links": [dict(r) for r in links],
            "properties": [dict(r) for r in properties],
            "property_selection_lines": [dict(r) for r in selection_lines],
            "node_properties": [dict(r) for r in node_properties],
            "property_value_scalars": [dict(r) for r in value_scalars],
            "property_value_relations": [dict(r) for r in value_relations],
            "property_value_selections": [dict(r) for r in value_selections],
            "class_properties": [dict(r) for r in class_properties],
            "class_extends": [dict(r) for r in class_extends],
            "property_class_filters": [dict(r) for r in class_filters],
            "node_views": [dict(r) for r in node_views],
            "settings": [dict(r) for r in settings],
        }

    async def create_workspace_for_import(self, name: str, owner_id: int) -> dict:
        """Insert a workspace for import and return the inserted row.

        Raises ValueError if the owner already has an active workspace with the
        same name, matching the original import behavior.
        """
        async with acquire_connection(self._pool) as conn, conn.transaction():
            existing = await conn.fetchrow(
                "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
                owner_id,
                name,
            )
            if existing:
                raise ValueError(f"Workspace '{name}' already exists")

            row = await conn.fetchrow(
                """
                INSERT INTO workspace (name, create_uid, write_uid, is_shared, active)
                VALUES ($1, $2, $2, FALSE, TRUE)
                RETURNING id, uuid, name, create_date
            """,
                name,
                owner_id,
            )
            if row is None:
                raise RuntimeError("Failed to create workspace")
            return dict(row)

    async def get_workspace_by_name_for_user(self, name: str, user_id: int) -> dict | None:
        """Get workspace row with id/uuid/name by name for a user."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT g.id, g.uuid::text as uuid, g.name
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.name = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
            """,
                user_id,
                name,
            )
            return dict(row) if row else None

    async def get_workspace_by_uuid_for_user(self, uuid: str, user_id: int) -> dict | None:
        """Get workspace row with id/uuid/name by uuid for a user."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT g.id, g.uuid::text as uuid, g.name
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.uuid::text = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
            """,
                user_id,
                uuid,
            )
            return dict(row) if row else None

    async def import_dump(
        self, workspace_id: int, user_id: int, dump_data: dict, remap_uuids: bool
    ) -> tuple[dict, dict[str, str]]:
        """Run the entire multi-phase import inside a single DB transaction."""
        stats = {
            "nodes": 0,
            "links": 0,
            "properties": 0,
            "property_selection_lines": 0,
            "node_properties": 0,
            "property_values": 0,
            "class_properties": 0,
            "class_extends": 0,
            "property_class_filters": 0,
            "node_views": 0,
            "settings": 0,
        }

        now = datetime.now(UTC)
        async with acquire_connection(self._pool) as conn, conn.transaction():
            logger.info("Disabling node triggers for bulk import")
            await conn.execute("ALTER TABLE node DISABLE TRIGGER node_search_update")
            await conn.execute("ALTER TABLE node DISABLE TRIGGER node_write_date")
            await conn.execute("ALTER TABLE node DISABLE TRIGGER node_update_workspace_write_date")
            await conn.execute("""
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_node_version_capture') THEN
                        ALTER TABLE node DISABLE TRIGGER trg_node_version_capture;
                    END IF;
                END $$;
            """)

            # Phase 1: nodes
            bundle = build_import_records(dump_data, workspace_id, user_id, remap_uuids, now=now)
            node_id_map: dict[int, int] = {}

            if bundle.node_records:
                logger.info(f"Importing {len(bundle.node_records)} nodes (phase 1: batch insert)")
                await conn.executemany(
                    """
                    INSERT INTO node (
                        uuid, workspace_id, name, icon, color,
                        sequence, collapsed, active, version,
                        is_class, is_page, is_day, is_month, is_year,
                        is_asset, is_template, is_comment,
                        classes_path, tag_ids, open_date, create_date, write_date,
                        is_deleted, deleted_at,
                        create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5,
                        $6, $7, $8, $9,
                        $10, $11, $12, $13, $14,
                        $15, $16, $17,
                        $18::jsonb, $19, $20, $21, $22,
                        $23, $24,
                        $25, $25
                    )
                """,
                    bundle.node_records,
                    timeout=None,
                )

                rows = await conn.fetch(
                    "SELECT id, uuid::text AS uuid_str FROM node WHERE workspace_id = $1",
                    workspace_id,
                )
                for row in rows:
                    old_id = bundle.node_uuid_to_old_id.get(row["uuid_str"])
                    if old_id is not None:
                        node_id_map[old_id] = row["id"]

            stats["nodes"] = len(node_id_map)

            # Phase 2-3: node refs + properties
            bundle = build_import_records(
                dump_data, workspace_id, user_id, remap_uuids, node_id_map=node_id_map, now=now
            )

            if bundle.node_update_records:
                logger.info("Importing nodes (phase 2: batch update references)")
                await conn.executemany(
                    """
                    UPDATE node
                    SET parent_id = $1, page_id = $2, aliased_id = $3,
                        class_ids = $4, tag_ids = $5, classes_path = $6::jsonb
                    WHERE id = $7
                """,
                    bundle.node_update_records,
                    timeout=None,
                )

            property_id_map: dict[int, int] = {}
            if bundle.property_records:
                logger.info(f"Importing {len(bundle.property_records)} properties")
                await conn.executemany(
                    """
                    INSERT INTO property (
                        uuid, workspace_id, name, icon, type, is_multi, is_system,
                        scope, node_id, icon_visibility, active,
                        create_date, write_date, create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5, $6, $7,
                        $8, $9, $10, $11,
                        $12, $13, $14, $14
                    )
                """,
                    bundle.property_records,
                    timeout=None,
                )

                rows = await conn.fetch(
                    "SELECT id, uuid::text AS uuid_str FROM property WHERE workspace_id = $1",
                    workspace_id,
                )
                for row in rows:
                    old_id = bundle.property_uuid_to_old_id.get(row["uuid_str"])
                    if old_id is not None:
                        property_id_map[old_id] = row["id"]

            stats["properties"] = len(property_id_map)

            # Phase 4-6: selection lines + class filters + node properties
            bundle = build_import_records(
                dump_data,
                workspace_id,
                user_id,
                remap_uuids,
                node_id_map=node_id_map,
                property_id_map=property_id_map,
                now=now,
            )

            selection_line_id_map: dict[int, int] = {}
            if bundle.selection_line_records:
                logger.info(f"Importing {len(bundle.selection_line_records)} property selection lines")
                await conn.executemany(
                    """
                    INSERT INTO property_selection_line (
                        uuid, property_id, name, icon, create_date, write_date,
                        create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5, $6, $7, $7
                    )
                """,
                    bundle.selection_line_records,
                    timeout=None,
                )

                rows = await conn.fetch(
                    """
                    SELECT psl.id, psl.uuid::text AS uuid_str
                    FROM property_selection_line psl
                    JOIN property p ON psl.property_id = p.id
                    WHERE p.workspace_id = $1
                """,
                    workspace_id,
                )
                for row in rows:
                    old_id = bundle.selection_line_uuid_to_old_id.get(row["uuid_str"])
                    if old_id is not None:
                        selection_line_id_map[old_id] = row["id"]

            stats["property_selection_lines"] = len(selection_line_id_map)

            if bundle.class_filter_records:
                logger.info(f"Importing {len(bundle.class_filter_records)} property class filters")
                await conn.executemany(
                    """
                    INSERT INTO property_class_filter (property_id, class_node_id)
                    VALUES ($1, $2)
                    ON CONFLICT (property_id, class_node_id) DO NOTHING
                """,
                    bundle.class_filter_records,
                    timeout=None,
                )
            stats["property_class_filters"] = len(bundle.class_filter_records)

            node_property_id_map: dict[int, int] = {}
            if bundle.node_property_records:
                logger.info(f"Importing {len(bundle.node_property_records)} node properties")
                await conn.executemany(
                    """
                    INSERT INTO node_property (
                        uuid, node_id, property_id, create_date, write_date,
                        create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5, $6, $6
                    )
                """,
                    bundle.node_property_records,
                    timeout=None,
                )

                rows = await conn.fetch(
                    """
                    SELECT np.id, np.uuid::text AS uuid_str
                    FROM node_property np
                    JOIN node n ON np.node_id = n.id
                    WHERE n.workspace_id = $1
                """,
                    workspace_id,
                )
                for row in rows:
                    old_id = bundle.node_property_uuid_to_old_id.get(row["uuid_str"])
                    if old_id is not None:
                        node_property_id_map[old_id] = row["id"]

            stats["node_properties"] = len(node_property_id_map)

            # Phase 7-14: values, class extends, class properties, links, views, settings
            bundle = build_import_records(
                dump_data,
                workspace_id,
                user_id,
                remap_uuids,
                node_id_map=node_id_map,
                property_id_map=property_id_map,
                selection_line_id_map=selection_line_id_map,
                node_property_id_map=node_property_id_map,
                now=now,
            )

            if bundle.scalar_value_records:
                logger.info(f"Importing {len(bundle.scalar_value_records)} property value scalars")
                await conn.executemany(
                    """
                    INSERT INTO property_value_scalar (
                        uuid, node_property_id, property_id, node_id,
                        value_text, value_boolean, value_float, value_integer,
                        create_date, write_date, create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4,
                        $5, $6, $7, $8,
                        $9, $10, $11, $11
                    )
                """,
                    bundle.scalar_value_records,
                    timeout=None,
                )
            stats["property_values"] = len(bundle.scalar_value_records)

            if bundle.relation_value_records:
                logger.info(f"Importing {len(bundle.relation_value_records)} property value relations")
                await conn.executemany(
                    """
                    INSERT INTO property_value_relation (
                        uuid, node_property_id, property_id, node_id, target_id,
                        "order", create_date, write_date, create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5,
                        $6, $7, $8, $9, $9
                    )
                """,
                    bundle.relation_value_records,
                    timeout=None,
                )
            stats["property_values"] += len(bundle.relation_value_records)

            if bundle.selection_value_records:
                logger.info(f"Importing {len(bundle.selection_value_records)} property value selections")
                await conn.executemany(
                    """
                    INSERT INTO property_value_selection (
                        uuid, node_property_id, property_id, node_id,
                        selection_line_id, create_date, write_date,
                        create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4,
                        $5, $6, $7,
                        $8, $8
                    )
                """,
                    bundle.selection_value_records,
                    timeout=None,
                )
            stats["property_values"] += len(bundle.selection_value_records)

            if bundle.class_extend_records:
                logger.info(f"Importing {len(bundle.class_extend_records)} class extends")
                await conn.executemany(
                    """
                    INSERT INTO class_extend (target_id, source_id, sequence)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (target_id, source_id) DO NOTHING
                """,
                    bundle.class_extend_records,
                    timeout=None,
                )
            stats["class_extends"] = len(bundle.class_extend_records)

            if bundle.class_property_records:
                logger.info(f"Importing {len(bundle.class_property_records)} class properties")
                await conn.executemany(
                    """
                    INSERT INTO class_property (
                        class_node_id, property_id, sequence, hidden,
                        default_integer, default_float, default_text,
                        default_boolean, default_node_id, default_selection_id
                    ) VALUES (
                        $1, $2, $3, $4,
                        $5, $6, $7,
                        $8, $9, $10
                    )
                    ON CONFLICT (class_node_id, property_id) DO NOTHING
                """,
                    bundle.class_property_records,
                    timeout=None,
                )
            stats["class_properties"] = len(bundle.class_property_records)

            if bundle.link_records:
                logger.info(f"Importing {len(bundle.link_records)} node links")
                await conn.executemany(
                    """
                    INSERT INTO node_link (
                        uuid, source_id, target_id, workspace_id, property_id,
                        position, is_inline_class, name, create_date,
                        create_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4, $5,
                        $6, $7, $8, $9,
                        $10
                    )
                """,
                    bundle.link_records,
                    timeout=None,
                )

            if bundle.tag_links_by_source:
                tag_update_records = [(list(targets), source_id) for source_id, targets in bundle.tag_links_by_source.items()]
                await conn.executemany(
                    """
                    UPDATE node
                    SET tag_ids = (
                        SELECT ARRAY_AGG(DISTINCT x ORDER BY x)
                        FROM unnest(COALESCE(tag_ids, '{}') || $1::INTEGER[]) AS x
                    )
                    WHERE id = $2
                """,
                    tag_update_records,
                    timeout=None,
                )
            stats["links"] = len(bundle.link_records)

            if bundle.node_view_records:
                logger.info(f"Importing {len(bundle.node_view_records)} node views")
                await conn.executemany(
                    """
                    INSERT INTO node_view (
                        uuid, node_id, name, query_json, view_type,
                        order_index, is_default, active,
                        shown_properties, group_by,
                        create_date, write_date, create_uid, write_uid
                    ) VALUES (
                        $1::uuid, $2, $3, $4::jsonb, $5,
                        $6, $7, $8,
                        $9::jsonb, $10,
                        $11, $12, $13, $13
                    )
                    ON CONFLICT (uuid) DO UPDATE SET
                        node_id = EXCLUDED.node_id,
                        name = EXCLUDED.name,
                        query_json = EXCLUDED.query_json,
                        view_type = EXCLUDED.view_type,
                        order_index = EXCLUDED.order_index,
                        is_default = EXCLUDED.is_default,
                        active = EXCLUDED.active,
                        shown_properties = EXCLUDED.shown_properties,
                        group_by = EXCLUDED.group_by,
                        write_date = EXCLUDED.write_date,
                        write_uid = EXCLUDED.write_uid
                """,
                    bundle.node_view_records,
                    timeout=None,
                )
            stats["node_views"] = len(bundle.node_view_records)

            if bundle.settings_records:
                logger.info(f"Importing {len(bundle.settings_records)} workspace settings")
                await conn.executemany(
                    """
                    INSERT INTO setting_workspace (workspace_id, key, value,
                                                   create_date, write_date,
                                                   create_uid, write_uid)
                    VALUES ($1, $2, $3::jsonb, $4, $4, $5, $5)
                    ON CONFLICT (workspace_id, key) DO UPDATE
                        SET value = EXCLUDED.value, write_date = EXCLUDED.write_date
                """,
                    bundle.settings_records,
                    timeout=None,
                )
            stats["settings"] = len(bundle.settings_records)

            logger.info("Re-enabling node triggers")
            await conn.execute("ALTER TABLE node ENABLE TRIGGER node_search_update")
            await conn.execute("ALTER TABLE node ENABLE TRIGGER node_write_date")
            await conn.execute("ALTER TABLE node ENABLE TRIGGER node_update_workspace_write_date")
            await conn.execute("""
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_node_version_capture') THEN
                        ALTER TABLE node ENABLE TRIGGER trg_node_version_capture;
                    END IF;
                END $$;
            """)

            logger.info("Rebuilding search vectors for imported nodes")
            await conn.execute(
                """
                UPDATE node SET search_vector = to_tsvector(
                    COALESCE(search_language, 'english')::regconfig,
                    COALESCE(name, '')
                ) WHERE workspace_id = $1
            """,
                workspace_id,
                timeout=None,
            )

        logger.info(f"Import complete: {stats}")
        return stats, bundle.uuid_map

    async def delete_all_workspace_data(self, workspace_id: int) -> None:
        """Delete all data in a workspace."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            await conn.execute(
                """
                DELETE FROM node_view
                WHERE node_id IN (SELECT id FROM node WHERE workspace_id = $1)
            """,
                workspace_id,
            )
            await conn.execute("DELETE FROM node_link WHERE workspace_id = $1", workspace_id)
            await conn.execute("DELETE FROM setting_workspace WHERE workspace_id = $1", workspace_id)
            await conn.execute("DELETE FROM node WHERE workspace_id = $1", workspace_id)
            await conn.execute("DELETE FROM property WHERE workspace_id = $1", workspace_id)

    async def restore_workspace(self, workspace_id: int, user_id: int, dump_data: dict) -> dict:
        """Delete all data then import with remap_uuids=False."""
        await self.delete_all_workspace_data(workspace_id)
        stats, _ = await self.import_dump(workspace_id, user_id, dump_data, remap_uuids=False)
        return stats

    async def list_page_uuids(self, workspace_id: int) -> list[dict]:
        """List active page UUIDs and names."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT uuid::text as uuid, name
                FROM node
                WHERE workspace_id = $1 AND is_page = TRUE
                  AND is_deleted = FALSE AND active = TRUE
                ORDER BY sequence, id
            """,
                workspace_id,
            )
            return [dict(r) for r in rows]

    async def list_asset_uuids(self, workspace_id: int) -> list[dict]:
        """List active asset UUIDs and names."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT n.uuid::text as uuid, n.name
                FROM node n
                WHERE n.workspace_id = $1 AND n.is_asset = TRUE
                  AND n.is_deleted = FALSE AND n.active = TRUE
            """,
                workspace_id,
            )
            return [dict(r) for r in rows]
