"""PostgreSQL implementation of Property repository.

Updated for workspace-based schema:
- workspace_id -> workspace_id
- target_node_id -> target_id in property_value_relation
- Removed: order fields from property_value_scalar, property_value_relation, property_value_selection
- Removed: property_selection_line.order
- Added: uuid, create_uid, write_uid fields to value tables

Property system with separate tables for:
- property: Property definitions
- node_property: Assignment of properties to nodes
- property_value_scalar: Scalar values (integer, float, boolean, date)
- property_value_relation: Relation values (node, text, image)
- property_selection_line: Selection options
- property_value_selection: Selection values
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List, Any

import asyncpg

from ..entities import (
    Property, PropertyType, PropertySelectionLine,
    PropertyClassFilter, ClassProperty,
    NodeProperty, PropertyValueScalar, PropertyValueRelation, PropertyValueSelection,
    SCALAR_TYPES, RELATION_TYPES, ALWAYS_SINGLE_TYPES,
    generate_uuid,
)
from .interfaces import PropertyRepository
from .base import normalize_timestamp
from ...utils import utc_now
from ...db.connection import acquire_connection
from ...logging_config import get_logger


logger = get_logger(__name__)


class PostgresPropertyRepository(PropertyRepository):
    """PostgreSQL implementation of the PropertyRepository.
    
    Updated for new schema:
    - workspace_id -> workspace_id
    - target_node_id -> target_id
    - Removed order fields from value tables
    """
    
    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: Optional[int] = None):
        """Initialize with connection pool and workspace context.
        
        Args:
            pool: asyncpg connection pool
            workspace_id: The workspace this repository operates on
            user_id: Optional current user ID for audit trails
        """
        self._pool = pool
        self._workspace_id = workspace_id
        self._user_id = user_id
    
    def _row_to_property(self, row: asyncpg.Record) -> Property:
        """Convert database row to Property entity."""
        create_date = row['create_date']
        write_date = row['write_date']
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
            
        return Property(
            id=row['id'],
            uuid=str(row['uuid']),
            name=row['name'],
            icon=row.get('icon'),
            type=PropertyType(row['type']),
            is_multi=row.get('is_multi', False),
            is_system=row.get('is_system', False),
            is_local=row.get('is_local', False),
            node_id=row.get('node_id'),
            icon_visibility=row.get('icon_visibility', 'hidden'),
            create_date=create_date,
            write_date=write_date,
        )
    
    def _row_to_node_property(self, row: asyncpg.Record) -> NodeProperty:
        """Convert database row to NodeProperty entity."""
        create_date = row['create_date']
        write_date = row['write_date']
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
            
        return NodeProperty(
            id=row['id'],
            uuid=str(row.get('uuid', '')) if row.get('uuid') else generate_uuid(),
            node_id=row['node_id'],
            property_id=row['property_id'],
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get('create_uid'),
            write_uid=row.get('write_uid'),
        )
    
    def _row_to_scalar_value(self, row: asyncpg.Record) -> PropertyValueScalar:
        """Convert database row to PropertyValueScalar entity."""
        create_date = row['create_date']
        write_date = row['write_date']
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
            
        return PropertyValueScalar(
            id=row['id'],
            uuid=str(row.get('uuid', '')) if row.get('uuid') else generate_uuid(),
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            value_text=row.get('value_text'),
            value_boolean=row.get('value_boolean'),
            value_float=row.get('value_float'),
            value_integer=row.get('value_integer'),
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get('create_uid'),
            write_uid=row.get('write_uid'),
        )
    
    def _row_to_relation_value(self, row: asyncpg.Record) -> PropertyValueRelation:
        """Convert database row to PropertyValueRelation entity."""
        create_date = row['create_date']
        write_date = row['write_date']
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
            
        return PropertyValueRelation(
            id=row['id'],
            uuid=str(row.get('uuid', '')) if row.get('uuid') else generate_uuid(),
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            target_id=row['target_id'],  # Changed from target_node_id
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get('create_uid'),
            write_uid=row.get('write_uid'),
        )
    
    def _row_to_selection_value(self, row: asyncpg.Record) -> PropertyValueSelection:
        """Convert database row to PropertyValueSelection entity."""
        create_date = row['create_date']
        write_date = row['write_date']
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
            
        return PropertyValueSelection(
            id=row['id'],
            uuid=str(row.get('uuid', '')) if row.get('uuid') else generate_uuid(),
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            selection_line_id=row['selection_line_id'],
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get('create_uid'),
            write_uid=row.get('write_uid'),
        )
    
    def _row_to_selection_line(self, row: asyncpg.Record) -> PropertySelectionLine:
        """Convert database row to PropertySelectionLine entity."""
        create_date = row['create_date']
        write_date = row['write_date']
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
            
        return PropertySelectionLine(
            id=row['id'],
            property_id=row['property_id'],
            name=row['name'],
            icon=row.get('icon'),
            order=row['sequence'] if 'sequence' in row.keys() else 0,
            create_date=create_date,
            write_date=write_date,
        )
    
    def _row_to_class_property(self, row: asyncpg.Record) -> ClassProperty:
        """Convert database row to ClassProperty entity."""
        return ClassProperty(
            id=row['id'],
            class_node_id=row['class_node_id'],
            property_id=row['property_id'],
            sequence=row.get('sequence', 0),
            hidden=row.get('hidden', False),
            default_integer=row.get('default_integer'),
            default_float=row.get('default_float'),
            default_text=row.get('default_text'),
            default_boolean=row.get('default_boolean'),
            default_node_id=row.get('default_node_id'),
            default_selection_id=row.get('default_selection_id'),
        )
    
    # ============== Property CRUD ==============
    
    async def create(self, property: Property) -> Property:
        """Create a new property definition."""
        now = utc_now()
        uuid = property.uuid if property.uuid else generate_uuid()
        
        # Enforce text/image single value constraint
        is_multi = property.is_multi
        if property.type in ALWAYS_SINGLE_TYPES:
            is_multi = False
        
        # Validate local property constraints
        if property.is_local:
            if not property.node_id:
                raise ValueError("Local properties must have a node_id")
            async with acquire_connection(self._pool) as conn:
                row = await conn.fetchrow(
                    "SELECT is_page FROM node WHERE id = $1 AND workspace_id = $2",
                    property.node_id, self._workspace_id
                )
                if not row or not row['is_page']:
                    raise ValueError("Local property node_id must reference a page node")
        
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, is_local, node_id, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $11)
                RETURNING id
            """, uuid, self._workspace_id if not property.is_system else None,
                property.name, property.icon, property.type.value,
                is_multi, property.is_system, property.is_local,
                property.node_id, now, self._user_id)
            
            if row is None:
                raise RuntimeError("Failed to create property - no row returned")
                
            property.id = row['id']
            property.uuid = uuid
            property.is_multi = is_multi
            property.create_date = now.isoformat()
            property.write_date = now.isoformat()
            
            return property
    
    async def get_by_id(self, property_id: int) -> Optional[Property]:
        """Get property by ID with type filters and selection lines."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT * FROM property WHERE id = $1 AND active = TRUE",
                property_id
            )
            if not row:
                return None
            
            prop = self._row_to_property(row)
            
            # Load class filters
            if prop.type in RELATION_TYPES:
                filter_rows = await conn.fetch(
                    "SELECT class_node_id FROM property_class_filter WHERE property_id = $1",
                    property_id
                )
                prop._class_filters = [f['class_node_id'] for f in filter_rows]
            
            # Load selection lines
            if prop.type == PropertyType.SELECTION:
                line_rows = await conn.fetch(
                    'SELECT * FROM property_selection_line WHERE property_id = $1 ORDER BY sequence, name',
                    property_id
                )
                prop._selection_lines = [self._row_to_selection_line(l) for l in line_rows]
            
            return prop
    
    async def get_by_uuid(self, uuid: str) -> Optional[Property]:
        """Get property by UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM property WHERE uuid = $1 AND active = TRUE",
                uuid
            )
            if not row:
                return None
            return await self.get_by_id(row['id'])
    
    async def get_by_name(self, name: str, node_id: Optional[int] = None) -> Optional[Property]:
        """Get property by name."""
        async with acquire_connection(self._pool) as conn:
            if node_id is not None:
                # Look for local property first
                row = await conn.fetchrow(
                    "SELECT id FROM property WHERE name = $1 AND is_local = TRUE AND node_id = $2 AND active = TRUE",
                    name, node_id
                )
                if row:
                    return await self.get_by_id(row['id'])
            
            # Fall back to global property
            row = await conn.fetchrow(
                "SELECT id FROM property WHERE name = $1 AND is_local = FALSE AND active = TRUE",
                name
            )
            if not row:
                return None
            return await self.get_by_id(row['id'])
    
    async def _load_property_extras(self, conn, properties: List[Property]) -> None:
        """Load class_filters and selection_lines for a list of properties in batch."""
        if not properties:
            return
        
        # Collect IDs by type
        relation_ids = [p.id for p in properties if p.type in RELATION_TYPES]
        selection_ids = [p.id for p in properties if p.type == PropertyType.SELECTION]
        
        # Batch load class filters
        if relation_ids:
            filter_rows = await conn.fetch(
                "SELECT property_id, class_node_id FROM property_class_filter WHERE property_id = ANY($1)",
                relation_ids
            )
            filters_by_prop: dict[int, list[int]] = {}
            for fr in filter_rows:
                filters_by_prop.setdefault(fr['property_id'], []).append(fr['class_node_id'])
            for p in properties:
                if p.id in filters_by_prop:
                    p._class_filters = filters_by_prop[p.id]
        
        # Batch load selection lines
        if selection_ids:
            line_rows = await conn.fetch(
                "SELECT * FROM property_selection_line WHERE property_id = ANY($1) ORDER BY sequence, name",
                selection_ids
            )
            lines_by_prop: dict[int, list] = {}
            for lr in line_rows:
                lines_by_prop.setdefault(lr['property_id'], []).append(self._row_to_selection_line(lr))
            for p in properties:
                if p.id in lines_by_prop:
                    p._selection_lines = lines_by_prop[p.id]

    async def get_all(self, include_local: bool = True) -> List[Property]:
        """Get all property definitions."""
        async with acquire_connection(self._pool) as conn:
            if include_local:
                rows = await conn.fetch(
                    "SELECT * FROM property WHERE (workspace_id = $1 OR workspace_id IS NULL) AND active = TRUE ORDER BY name",
                    self._workspace_id
                )
            else:
                rows = await conn.fetch(
                    "SELECT * FROM property WHERE (workspace_id = $1 OR workspace_id IS NULL) AND is_local = FALSE AND active = TRUE ORDER BY name",
                    self._workspace_id
                )
            properties = [self._row_to_property(row) for row in rows]
            await self._load_property_extras(conn, properties)
            return properties
    
    async def get_local_properties(self, node_id: int) -> List[Property]:
        """Get all local properties for a specific page node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM property WHERE is_local = TRUE AND node_id = $1 AND active = TRUE ORDER BY name",
                node_id
            )
            properties = [self._row_to_property(row) for row in rows]
            await self._load_property_extras(conn, properties)
            return properties
    
    async def update(self, property_id: int, name: Optional[str] = None,
                     icon: Optional[str] = None,
                     icon_visibility: Optional[str] = None) -> Optional[Property]:
        """Update a property definition."""
        prop = await self.get_by_id(property_id)
        if not prop:
            return None
        
        if prop.is_system:
            raise ValueError("Cannot modify system properties")
        
        now = utc_now()
        updates = []
        params = []
        param_idx = 1
        
        if name is not None:
            updates.append(f"name = ${param_idx}")
            params.append(name)
            param_idx += 1
        
        if icon is not None:
            updates.append(f"icon = ${param_idx}")
            params.append(icon)
            param_idx += 1
        
        if icon_visibility is not None:
            updates.append(f"icon_visibility = ${param_idx}")
            params.append(icon_visibility)
            param_idx += 1
        
        if updates:
            updates.append(f"write_date = ${param_idx}")
            params.append(now)
            param_idx += 1
            
            if self._user_id:
                updates.append(f"write_uid = ${param_idx}")
                params.append(self._user_id)
                param_idx += 1
            
            params.append(property_id)
            
            async with acquire_connection(self._pool) as conn:
                await conn.execute(
                    f"UPDATE property SET {', '.join(updates)} WHERE id = ${param_idx}",
                    *params
                )
        
        return await self.get_by_id(property_id)
    
    async def can_delete_property(self, property_id: int) -> tuple[bool, str]:
        """Check if a property can be deleted."""
        async with acquire_connection(self._pool) as conn:
            # Check for scalar values
            row = await conn.fetchrow(
                "SELECT COUNT(*) as cnt FROM property_value_scalar WHERE property_id = $1",
                property_id
            )
            if row and row['cnt'] > 0:
                return False, f"Property has {row['cnt']} scalar value(s)"
            
            # Check for relation values
            row = await conn.fetchrow(
                "SELECT COUNT(*) as cnt FROM property_value_relation WHERE property_id = $1",
                property_id
            )
            if row and row['cnt'] > 0:
                return False, f"Property has {row['cnt']} relation value(s)"
            
            # Check for selection values
            row = await conn.fetchrow(
                "SELECT COUNT(*) as cnt FROM property_value_selection WHERE property_id = $1",
                property_id
            )
            if row and row['cnt'] > 0:
                return False, f"Property has {row['cnt']} selection value(s)"
            
            return True, ""
    
    async def can_change_property_type(self, property_id: int, new_type: PropertyType) -> tuple[bool, str]:
        """Check if a property type can be changed."""
        can_delete, reason = await self.can_delete_property(property_id)
        if not can_delete:
            return False, f"Cannot change type: {reason}"
        return True, ""
    
    async def change_property_type(self, property_id: int, new_type: PropertyType,
                                    new_is_multi: Optional[bool] = None) -> Optional[Property]:
        """Change a property's type if no values exist."""
        prop = await self.get_by_id(property_id)
        if not prop:
            return None
        
        if prop.is_system:
            raise ValueError("Cannot modify system properties")
        
        can_change, reason = await self.can_change_property_type(property_id, new_type)
        if not can_change:
            raise ValueError(reason)
        
        now = utc_now()
        is_multi = new_is_multi if new_is_multi is not None else prop.is_multi
        
        if new_type in ALWAYS_SINGLE_TYPES:
            is_multi = False
        
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE property SET type = $1, is_multi = $2, write_date = $3, write_uid = $4 WHERE id = $5",
                new_type.value, is_multi, now, self._user_id, property_id
            )
            
            if new_type not in RELATION_TYPES:
                await conn.execute(
                    "DELETE FROM property_class_filter WHERE property_id = $1",
                    property_id
                )
            
            if new_type != PropertyType.SELECTION:
                await conn.execute(
                    "DELETE FROM property_selection_line WHERE property_id = $1",
                    property_id
                )
        
        return await self.get_by_id(property_id)
    
    async def delete(self, property_id: int) -> bool:
        """Delete a property (soft delete using active flag)."""
        prop = await self.get_by_id(property_id)
        if not prop:
            return False
        
        if prop.is_system:
            raise ValueError("Cannot delete system properties")
        
        can_delete, reason = await self.can_delete_property(property_id)
        if not can_delete:
            raise ValueError(reason)
        
        async with acquire_connection(self._pool) as conn:
            # Soft delete by setting active = FALSE
            await conn.execute(
                "UPDATE property SET active = FALSE, write_date = $1, write_uid = $2 WHERE id = $3",
                utc_now(), self._user_id, property_id
            )
        return True
    
    # ============== Node Property (Assignment) ==============
    
    async def assign_property_to_node(self, node_id: int, property_id: int) -> NodeProperty:
        """Assign a property to a node (without setting a value)."""
        now = utc_now()
        
        async with acquire_connection(self._pool) as conn:
            # Check if already assigned
            row = await conn.fetchrow(
                "SELECT * FROM node_property WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            if row:
                return self._row_to_node_property(row)
            
            row = await conn.fetchrow("""
                INSERT INTO node_property (uuid, node_id, property_id, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3, $4, $4, $5, $5)
                RETURNING *
            """, generate_uuid(), node_id, property_id, now, self._user_id)
            
            if row is None:
                raise RuntimeError("Failed to assign property to node - no row returned")
            return self._row_to_node_property(row)
    
    async def get_node_property(self, node_id: int, property_id: int) -> Optional[NodeProperty]:
        """Get a node_property assignment."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node_property WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return self._row_to_node_property(row) if row else None
    
    async def get_node_properties(self, node_id: int) -> List[NodeProperty]:
        """Get all property assignments for a node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_property WHERE node_id = $1 ORDER BY property_id",
                node_id
            )
            return [self._row_to_node_property(row) for row in rows]
    
    async def remove_property_from_node(self, node_id: int, property_id: int) -> bool:
        """Remove a property assignment from a node."""
        prop = await self.get_by_id(property_id)
        
        async with acquire_connection(self._pool) as conn:
            if prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE):
                # Delete target nodes for text/image types
                rows = await conn.fetch(
                    "SELECT target_id FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                    node_id, property_id
                )
                for row in rows:
                    await conn.execute("DELETE FROM node WHERE id = $1", row['target_id'])
            
            result = await conn.execute(
                "DELETE FROM node_property WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return result == "DELETE 1"
    
    async def get_node_ids_with_property(self, property_id: int) -> List[int]:
        """Get all node IDs that have a specific property assigned."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT node_id FROM node_property WHERE property_id = $1",
                property_id
            )
            return [row['node_id'] for row in rows]
    
    # ============== Scalar Values ==============
    
    async def set_scalar_value(self, node_id: int, property_id: int, value: Any) -> PropertyValueScalar:
        """Set a scalar property value for a node."""
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type not in SCALAR_TYPES:
            raise ValueError(f"Property {property_id} is not a scalar type")
        
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now()
        
        async with acquire_connection(self._pool) as conn:
            if not prop.is_multi:
                await conn.execute(
                    "DELETE FROM property_value_scalar WHERE node_property_id = $1",
                    np.id
                )
            
            value_text = None
            value_boolean = None
            value_float = None
            value_integer = None
            
            if prop.type == PropertyType.TEXT:
                value_text = str(value) if value is not None else None
            elif prop.type == PropertyType.INTEGER:
                value_integer = int(value) if value is not None else None
            elif prop.type == PropertyType.FLOAT:
                value_float = float(value) if value is not None else None
            elif prop.type == PropertyType.BOOLEAN:
                value_boolean = bool(value) if value is not None else None
            
            row = await conn.fetchrow("""
                INSERT INTO property_value_scalar 
                (uuid, node_property_id, property_id, node_id, value_text, value_boolean, value_float, value_integer, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $10)
                RETURNING *
            """, generate_uuid(), np.id, property_id, node_id, value_text, value_boolean, value_float, value_integer, now, self._user_id)
            
            if row is None:
                raise RuntimeError("Failed to set scalar value - no row returned")
            return self._row_to_scalar_value(row)
    
    async def get_scalar_values(self, node_id: int, property_id: int) -> List[PropertyValueScalar]:
        """Get all scalar values for a property on a node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                'SELECT * FROM property_value_scalar WHERE node_id = $1 AND property_id = $2',
                node_id, property_id
            )
            return [self._row_to_scalar_value(row) for row in rows]
    
    async def remove_scalar_value(self, value_id: int) -> bool:
        """Remove a specific scalar value."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM property_value_scalar WHERE id = $1",
                value_id
            )
            return result == "DELETE 1"
    
    async def clear_scalar_values(self, node_id: int, property_id: int) -> int:
        """Remove all scalar values for a property on a node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM property_value_scalar WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return int(result.split()[-1]) if result else 0
    
    # ============== Relation Values ==============
    
    async def set_relation_value(self, node_id: int, property_id: int, target_id: int) -> PropertyValueRelation:
        """Set a relation property value for a node."""
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type not in RELATION_TYPES:
            raise ValueError(f"Property {property_id} is not a relation type")
        
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now()
        
        async with acquire_connection(self._pool) as conn:
            if not prop.is_multi:
                await conn.execute(
                    "DELETE FROM property_value_relation WHERE node_property_id = $1",
                    np.id
                )
            
            row = await conn.fetchrow("""
                INSERT INTO property_value_relation 
                (uuid, node_property_id, property_id, node_id, target_id, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7)
                RETURNING *
            """, generate_uuid(), np.id, property_id, node_id, target_id, now, self._user_id)
            
            if row is None:
                raise RuntimeError("Failed to set relation value - no row returned")
            return self._row_to_relation_value(row)
    
    async def get_relation_values(self, node_id: int, property_id: int) -> List[PropertyValueRelation]:
        """Get all relation values for a property on a node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                'SELECT * FROM property_value_relation WHERE node_id = $1 AND property_id = $2',
                node_id, property_id
            )
            return [self._row_to_relation_value(row) for row in rows]
    
    async def remove_relation_value(self, value_id: int, delete_target_node: bool = False) -> bool:
        """Remove a specific relation value."""
        async with acquire_connection(self._pool) as conn:
            if delete_target_node:
                row = await conn.fetchrow(
                    "SELECT target_id FROM property_value_relation WHERE id = $1",
                    value_id
                )
                if row:
                    await conn.execute("DELETE FROM node WHERE id = $1", row['target_id'])
            
            result = await conn.execute(
                "DELETE FROM property_value_relation WHERE id = $1",
                value_id
            )
            return result == "DELETE 1"
    
    async def clear_relation_values(self, node_id: int, property_id: int, delete_target_nodes: bool = False) -> int:
        """Remove all relation values for a property on a node."""
        async with acquire_connection(self._pool) as conn:
            if delete_target_nodes:
                rows = await conn.fetch(
                    "SELECT target_id FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                    node_id, property_id
                )
                for row in rows:
                    await conn.execute("DELETE FROM node WHERE id = $1", row['target_id'])
            
            result = await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return int(result.split()[-1]) if result else 0
    
    # ============== Selection Lines ==============
    
    async def add_selection_line(self, property_id: int, name: str, icon: Optional[str] = None, sequence: int = 0) -> PropertySelectionLine:
        """Add an option to a selection-type property."""
        now = utc_now()
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                INSERT INTO property_selection_line (property_id, name, icon, sequence, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3, $4, $5, $5, $6, $6)
                RETURNING *
            """, property_id, name, icon, sequence, now, self._user_id)
            
            if row is None:
                raise RuntimeError("Failed to add selection line - no row returned")
            return self._row_to_selection_line(row)
    
    async def get_selection_lines(self, property_id: int) -> List[PropertySelectionLine]:
        """Get all selection options for a property."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                'SELECT * FROM property_selection_line WHERE property_id = $1 ORDER BY sequence, name',
                property_id
            )
            return [self._row_to_selection_line(row) for row in rows]
    
    async def update_selection_line(self, line_id: int, name: Optional[str] = None,
                                     icon: Optional[str] = None, order: Optional[int] = None) -> Optional[PropertySelectionLine]:
        """Update a selection option."""
        now = utc_now()
        updates = []
        params = []
        param_idx = 1
        
        if name is not None:
            updates.append(f"name = ${param_idx}")
            params.append(name)
            param_idx += 1
        
        if icon is not None:
            updates.append(f"icon = ${param_idx}")
            params.append(icon)
            param_idx += 1

        if order is not None:
            updates.append(f"sequence = ${param_idx}")
            params.append(order)
            param_idx += 1
        
        if not updates:
            async with acquire_connection(self._pool) as conn:
                row = await conn.fetchrow(
                    "SELECT * FROM property_selection_line WHERE id = $1",
                    line_id
                )
                return self._row_to_selection_line(row) if row else None
        
        updates.append(f"write_date = ${param_idx}")
        params.append(now)
        param_idx += 1
        
        if self._user_id:
            updates.append(f"write_uid = ${param_idx}")
            params.append(self._user_id)
            param_idx += 1
        
        params.append(line_id)
        
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                f"UPDATE property_selection_line SET {', '.join(updates)} WHERE id = ${param_idx} RETURNING *",
                *params
            )
            return self._row_to_selection_line(row) if row else None
    
    async def can_delete_selection_line(self, line_id: int) -> tuple[bool, str]:
        """Check if a selection line can be deleted."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT COUNT(*) as cnt FROM property_value_selection WHERE selection_line_id = $1",
                line_id
            )
            if row and row['cnt'] > 0:
                return False, f"Selection option is used by {row['cnt']} node(s)"
            return True, ""
    
    async def delete_selection_line(self, line_id: int) -> bool:
        """Delete a selection option if not in use."""
        can_delete, reason = await self.can_delete_selection_line(line_id)
        if not can_delete:
            raise ValueError(reason)
        
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM property_selection_line WHERE id = $1",
                line_id
            )
            return result == "DELETE 1"
    
    # ============== Selection Values ==============
    
    async def set_selection_value(self, node_id: int, property_id: int, selection_line_id: int) -> PropertyValueSelection:
        """Set a selection property value for a node."""
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now()
        
        prop = await self.get_by_id(property_id)
        
        async with acquire_connection(self._pool) as conn:
            if prop and not prop.is_multi:
                await conn.execute(
                    "DELETE FROM property_value_selection WHERE node_property_id = $1",
                    np.id
                )
            
            row = await conn.fetchrow("""
                INSERT INTO property_value_selection 
                (uuid, node_property_id, property_id, node_id, selection_line_id, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7)
                RETURNING *
            """, generate_uuid(), np.id, property_id, node_id, selection_line_id, now, self._user_id)
            
            if row is None:
                raise RuntimeError("Failed to set selection value - no row returned")
            return self._row_to_selection_value(row)
    
    async def get_selection_values(self, node_id: int, property_id: int) -> List[PropertyValueSelection]:
        """Get all selection values for a property on a node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                'SELECT * FROM property_value_selection WHERE node_id = $1 AND property_id = $2',
                node_id, property_id
            )
            return [self._row_to_selection_value(row) for row in rows]
    
    async def remove_selection_value(self, value_id: int) -> bool:
        """Remove a specific selection value."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM property_value_selection WHERE id = $1",
                value_id
            )
            return result == "DELETE 1"
    
    async def clear_selection_values(self, node_id: int, property_id: int) -> int:
        """Remove all selection values for a property on a node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return int(result.split()[-1]) if result else 0
    
    # ============== Class Filters ==============
    
    async def add_class_filter(self, property_id: int, class_node_id: int) -> PropertyClassFilter:
        """Add a class filter to a relation-type property."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                INSERT INTO property_class_filter (property_id, class_node_id)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
                RETURNING id
            """, property_id, class_node_id)
            
            return PropertyClassFilter(
                id=row['id'] if row else 0,
                property_id=property_id,
                class_node_id=class_node_id,
            )
    
    async def get_class_filters(self, property_id: int) -> List[int]:
        """Get all class filter node IDs for a property."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT class_node_id FROM property_class_filter WHERE property_id = $1",
                property_id
            )
            return [row['class_node_id'] for row in rows]
    
    async def remove_class_filter(self, property_id: int, class_node_id: int) -> bool:
        """Remove a class filter from a property."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM property_class_filter WHERE property_id = $1 AND class_node_id = $2",
                property_id, class_node_id
            )
            return result == "DELETE 1"
    
    # ============== Unified Value Access ==============
    
    async def get_all_property_values(self, node_id: int) -> dict[int, dict[str, Any]]:
        """Get all property values for a node, grouped by property_id.
        
        Returns a dict keyed by property_id with values:
        {
            'property': Property,
            'node_property': NodeProperty,
            'values': List[PropertyValueScalar | PropertyValueRelation | PropertyValueSelection]
        }
        """
        result: dict[int, dict[str, Any]] = {}
        
        async with acquire_connection(self._pool) as conn:
            # Get all node_property assignments for this node with property data
            np_rows = await conn.fetch("""
                SELECT np.*, p.uuid as p_uuid, p.name as p_name, p.icon as p_icon,
                       p.type as p_type, p.is_multi as p_is_multi, p.is_system as p_is_system,
                       p.is_local as p_is_local, p.node_id as p_node_id,
                       p.create_date as p_create_date, p.write_date as p_write_date
                FROM node_property np
                JOIN property p ON np.property_id = p.id
                WHERE np.node_id = $1 AND p.active = TRUE
            """, node_id)
            
            # Build property and node_property objects
            for np_row in np_rows:
                prop_id = np_row['property_id']
                
                # Create Property object
                p_create_date = np_row['p_create_date']
                p_write_date = np_row['p_write_date']
                if isinstance(p_create_date, datetime):
                    p_create_date = p_create_date.isoformat()
                if isinstance(p_write_date, datetime):
                    p_write_date = p_write_date.isoformat()
                    
                prop = Property(
                    id=prop_id,
                    uuid=str(np_row['p_uuid']),
                    name=np_row['p_name'],
                    icon=np_row['p_icon'],
                    type=PropertyType(np_row['p_type']),
                    is_multi=np_row['p_is_multi'],
                    is_system=np_row['p_is_system'],
                    is_local=np_row['p_is_local'],
                    node_id=np_row['p_node_id'],
                    create_date=p_create_date,
                    write_date=p_write_date,
                )
                
                # Create NodeProperty object
                node_property = self._row_to_node_property(np_row)
                
                result[prop_id] = {
                    'property': prop,
                    'node_property': node_property,
                    'values': [],
                }
            
            if not result:
                return result
            
            prop_ids = list(result.keys())
            
            # Get scalar values
            scalar_rows = await conn.fetch(
                "SELECT * FROM property_value_scalar WHERE node_id = $1 AND property_id = ANY($2)",
                node_id, prop_ids
            )
            for row in scalar_rows:
                prop_id = row['property_id']
                if prop_id in result:
                    result[prop_id]['values'].append(self._row_to_scalar_value(row))
            
            # Get relation values
            relation_rows = await conn.fetch(
                "SELECT * FROM property_value_relation WHERE node_id = $1 AND property_id = ANY($2)",
                node_id, prop_ids
            )
            logger.info(f"[GET_ALL_PROPERTY_VALUES] Node {node_id}: Found {len(relation_rows)} relation values")
            for row in relation_rows:
                prop_id = row['property_id']
                if prop_id in result:
                    relation_value = self._row_to_relation_value(row)
                    logger.info(f"[GET_ALL_PROPERTY_VALUES] Adding relation value for prop {prop_id}: target_id={relation_value.target_id}")
                    result[prop_id]['values'].append(relation_value)
            
            # Get selection values
            selection_rows = await conn.fetch(
                "SELECT * FROM property_value_selection WHERE node_id = $1 AND property_id = ANY($2)",
                node_id, prop_ids
            )
            for row in selection_rows:
                prop_id = row['property_id']
                if prop_id in result:
                    result[prop_id]['values'].append(self._row_to_selection_value(row))
        
        # Log the final result
        logger.info(f"[GET_ALL_PROPERTY_VALUES] Node {node_id}: Returning {len(result)} properties")
        for prop_id, data in result.items():
            logger.info(f"[GET_ALL_PROPERTY_VALUES]   Property {prop_id} ({data['property'].name}): {len(data['values'])} values")
        
        return result
    
    async def get_all_property_values_batch(self, node_ids: List[int]) -> dict[int, dict[int, dict[str, Any]]]:
        """Get all property values for multiple nodes in 3 queries (not N*3).
        
        Returns: {node_id -> {property_id -> {'property': ..., 'node_property': ..., 'values': [...]}}}
        """
        if not node_ids:
            return {}
        
        result: dict[int, dict[int, dict[str, Any]]] = {nid: {} for nid in node_ids}
        
        async with acquire_connection(self._pool) as conn:
            # 1. Get all node_property assignments for all nodes
            np_rows = await conn.fetch("""
                SELECT np.*, p.uuid as p_uuid, p.name as p_name, p.icon as p_icon,
                       p.type as p_type, p.is_multi as p_is_multi, p.is_system as p_is_system,
                       p.is_local as p_is_local, p.node_id as p_node_id,
                       p.create_date as p_create_date, p.write_date as p_write_date
                FROM node_property np
                JOIN property p ON np.property_id = p.id
                WHERE np.node_id = ANY($1) AND p.active = TRUE
            """, node_ids)
            
            # Collect all property IDs we need values for
            all_prop_ids: set[int] = set()
            
            for np_row in np_rows:
                nid = np_row['node_id']
                prop_id = np_row['property_id']
                all_prop_ids.add(prop_id)
                
                p_create_date = np_row['p_create_date']
                p_write_date = np_row['p_write_date']
                if isinstance(p_create_date, datetime):
                    p_create_date = p_create_date.isoformat()
                if isinstance(p_write_date, datetime):
                    p_write_date = p_write_date.isoformat()
                
                prop = Property(
                    id=prop_id,
                    uuid=str(np_row['p_uuid']),
                    name=np_row['p_name'],
                    icon=np_row['p_icon'],
                    type=PropertyType(np_row['p_type']),
                    is_multi=np_row['p_is_multi'],
                    is_system=np_row['p_is_system'],
                    is_local=np_row['p_is_local'],
                    node_id=np_row['p_node_id'],
                    create_date=p_create_date,
                    write_date=p_write_date,
                )
                node_property = self._row_to_node_property(np_row)
                
                result[nid][prop_id] = {
                    'property': prop,
                    'node_property': node_property,
                    'values': [],
                }
            
            if not all_prop_ids:
                return result
            
            prop_ids_list = list(all_prop_ids)
            
            # 2. Get all scalar values
            scalar_rows = await conn.fetch(
                "SELECT * FROM property_value_scalar WHERE node_id = ANY($1) AND property_id = ANY($2)",
                node_ids, prop_ids_list
            )
            for row in scalar_rows:
                nid, prop_id = row['node_id'], row['property_id']
                if nid in result and prop_id in result[nid]:
                    result[nid][prop_id]['values'].append(self._row_to_scalar_value(row))
            
            # 3. Get all relation values
            relation_rows = await conn.fetch(
                "SELECT * FROM property_value_relation WHERE node_id = ANY($1) AND property_id = ANY($2)",
                node_ids, prop_ids_list
            )
            for row in relation_rows:
                nid, prop_id = row['node_id'], row['property_id']
                if nid in result and prop_id in result[nid]:
                    result[nid][prop_id]['values'].append(self._row_to_relation_value(row))
            
            # 4. Get all selection values
            selection_rows = await conn.fetch(
                "SELECT * FROM property_value_selection WHERE node_id = ANY($1) AND property_id = ANY($2)",
                node_ids, prop_ids_list
            )
            for row in selection_rows:
                nid, prop_id = row['node_id'], row['property_id']
                if nid in result and prop_id in result[nid]:
                    result[nid][prop_id]['values'].append(self._row_to_selection_value(row))
        
        return result
    
    async def clear_all_property_values(self, node_id: int, property_id: int) -> None:
        """Clear all values for a property on a node (but keep the assignment)."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM property_value_scalar WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
    
    # ============== Class Properties ==============
    
    async def get_class_properties(self, class_node_id: int) -> List[ClassProperty]:
        """Get properties that a class applies to classed nodes."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM class_property WHERE class_node_id = $1 ORDER BY sequence",
                class_node_id
            )
            return [self._row_to_class_property(row) for row in rows]
    
    async def add_class_property(self, class_node_id: int, property_id: int,
                                 sequence: int = 0, default_value: Any = None) -> ClassProperty:
        """Link a property to a class."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, $3)
                ON CONFLICT (class_node_id, property_id) DO UPDATE SET sequence = $3
                RETURNING *
            """, class_node_id, property_id, sequence)
            
            if row is None:
                raise RuntimeError("Failed to add class property - no row returned")
            return self._row_to_class_property(row)
    
    async def remove_class_property(self, class_node_id: int, property_id: int) -> bool:
        """Remove a property from a class."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM class_property WHERE class_node_id = $1 AND property_id = $2",
                class_node_id, property_id
            )
            return result == "DELETE 1"
    
    async def get_all_inherited_properties(self, class_node_id: int) -> List[ClassProperty]:
        """Get all properties for a class including inherited ones."""
        async with acquire_connection(self._pool) as conn:
            # Use recursive CTE to get inherited properties
            # Note: class_extend uses target_id (child) and source_id (parent)
            rows = await conn.fetch("""
                WITH RECURSIVE class_hierarchy AS (
                    SELECT target_id, source_id, 0 as depth
                    FROM class_extend WHERE target_id = $1
                    UNION ALL
                    SELECT ce.target_id, ce.source_id, ch.depth + 1
                    FROM class_extend ce
                    JOIN class_hierarchy ch ON ce.target_id = ch.source_id
                    WHERE ch.depth < 10
                )
                SELECT DISTINCT cp.* FROM class_property cp
                WHERE cp.class_node_id = $1
                   OR cp.class_node_id IN (SELECT source_id FROM class_hierarchy)
                ORDER BY cp.sequence
            """, class_node_id)
            return [self._row_to_class_property(row) for row in rows]
