"""PostgreSQL → ideal operation-log migration helpers.

This package exports the building blocks used by ``scripts/migrate_to_ideal.py``
to read the current mutable PostgreSQL schema and emit immutable operations for
the local-first, CRDT-driven architecture.
"""

from app.core.migration.assets import migrate_assets_for_workspace
from app.core.migration.connection import connect_postgres, postgres_dsn_from_env
from app.core.migration.links import (
    map_property_relation_targets,
    migrate_links_for_workspace,
)
from app.core.migration.nodes import (
    MigrationContext,
    create_migration_context,
    migrate_nodes_for_workspace,
)
from app.core.migration.properties import migrate_properties_for_workspace
from app.core.migration.relay_writer import PostgresOperationWriter
from app.core.migration.replay import replay_operations
from app.core.migration.validation import (
    DerivedCounts,
    ReconciliationReport,
    build_reconciliation_report,
    compare_derived_state,
    detect_duplicate_operations,
    detect_orphan_operations,
    format_report,
    get_derived_counts,
)
from app.core.migration.writer import (
    InMemoryOperationWriter,
    OperationWriter,
    SqliteOperationWriter,
)

__all__ = [
    "connect_postgres",
    "postgres_dsn_from_env",
    "create_migration_context",
    "migrate_nodes_for_workspace",
    "migrate_properties_for_workspace",
    "migrate_assets_for_workspace",
    "migrate_links_for_workspace",
    "map_property_relation_targets",
    "MigrationContext",
    "replay_operations",
    "DerivedCounts",
    "ReconciliationReport",
    "build_reconciliation_report",
    "compare_derived_state",
    "detect_duplicate_operations",
    "detect_orphan_operations",
    "format_report",
    "get_derived_counts",
    "InMemoryOperationWriter",
    "OperationWriter",
    "PostgresOperationWriter",
    "SqliteOperationWriter",
]
