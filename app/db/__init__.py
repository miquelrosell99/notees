"""Database operations package for Notees.

This package now uses the domain layer for most operations.
Legacy modules are kept for backward compatibility during migration.
"""

from .connection import (
    get_db,
    get_db_path,
    init_db,
    get_active_db_name,
    set_active_db,
    get_user_data_dir,
    get_databases_dir,
    get_export_dir
)

from .schema import (
    init_database,
    get_database,
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
    parse_date_uuid,
    SYSTEM_TYPES,
)

from .export import (
    get_node_tree,
    export_nodes,
    auto_export_page_to_markdown,
    export_all_pages_to_markdown
)

from .sync import (
    get_changes_since,
    apply_remote_changes,
    get_sync_status,
    set_last_sync_time
)

from .graph import (
    get_graph_data
)

from .database_mgmt import (
    list_databases,
    create_database,
    switch_database,
    delete_database,
    import_database,
    export_database
)

from .utils import (
    generate_uuid,
    format_date_display
)

__all__ = [
    # Connection
    'get_db',
    'get_db_path',
    'init_db',
    'get_active_db_name',
    'set_active_db',
    'get_user_data_dir',
    'get_databases_dir',
    'get_export_dir',
    
    # Schema
    'init_database',
    'get_database',
    'generate_day_uuid',
    'generate_month_uuid', 
    'generate_year_uuid',
    'parse_date_uuid',
    'SYSTEM_TYPES',
    
    # Export
    'get_node_tree',
    'export_nodes',
    'auto_export_page_to_markdown',
    'export_all_pages_to_markdown',
    
    # Sync
    'get_changes_since',
    'apply_remote_changes',
    'get_sync_status',
    'set_last_sync_time',
    
    # Graph
    'get_graph_data',
    
    # Database Management
    'list_databases',
    'create_database',
    'switch_database',
    'delete_database',
    'import_database',
    'export_database',
    
    # Utils
    'generate_uuid',
    'format_date_display',
]
