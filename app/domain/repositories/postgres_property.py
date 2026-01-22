"""PostgreSQL implementation of Property repository.

Property system with separate tables for:
- property: Property definitions
- node_property: Assignment of properties to nodes
- property_value_scalar: Scalar values (integer, float, boolean)
- property_value_relation: Relation values (node references)
- property_selection_line: Selection options
- property_value_selection: Selection values
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List, Any

import asyncpg

from ..entities import (
    Property, PropertyType, PropertySelectionLine,
    PropertyTypeFilter, TypeProperty, TypeExtends,
    NodeProperty, PropertyValueScalar, PropertyValueRelation, PropertyValueSelection,
    SCALAR_TYPES, RELATION_TYPES, ALWAYS_SINGLE_TYPES,
    generate_uuid,
)
from .interfaces import PropertyRepository


def utc_now() -> datetime:
    """Get current UTC datetime."""
    return datetime.now(timezone.utc)


class PostgresPropertyRepository(PropertyRepository):
    """PostgreSQL implementation of the PropertyRepository."""
    
    def __init__(self, pool: asyncpg.Pool, workspace_id: int):
        """Initialize with connection pool and workspace context."""
        self._pool = pool
        self._workspace_id = workspace_id
    
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
            node_id=row['node_id'],
            property_id=row['property_id'],
            create_date=create_date,
            write_date=write_date,
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
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            value_text=row.get('value_text'),
            value_boolean=row.get('value_boolean'),
            value_float=row.get('value_float'),
            value_integer=row.get('value_integer'),
            order=row.get('order', 0),
            create_date=create_date,
            write_date=write_date,
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
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            target_node_id=row['target_node_id'],
            order=row.get('order', 0),
            create_date=create_date,
            write_date=write_date,
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
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            selection_line_id=row['selection_line_id'],
            order=row.get('order', 0),
            create_date=create_date,
            write_date=write_date,
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
            order=row.get('order', 0),
            create_date=create_date,
            write_date=write_date,
        )
    
    def _row_to_type_property(self, row: asyncpg.Record) -> TypeProperty:
        """Convert database row to TypeProperty entity."""
        return TypeProperty(
            id=row['id'],
            type_node_id=row['type_node_id'],
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
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT is_page FROM node WHERE id = $1 AND workspace_id = $2",
                    property.node_id, self._workspace_id
                )
                if not row or not row['is_page']:
                    raise ValueError("Local property node_id must reference a page node")
        
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, is_local, node_id, create_date, write_date)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
                RETURNING id
            """, uuid, self._workspace_id if not property.is_system else None,
                property.name, property.icon, property.type.value,
                is_multi, property.is_system, property.is_local,
                property.node_id, now)
            
            property.id = row['id']
            property.uuid = uuid
            property.is_multi = is_multi
            property.create_date = now.isoformat()
            property.write_date = now.isoformat()
            
            return property
    
    async def get_by_id(self, property_id: int) -> Optional[Property]:
        """Get property by ID with type filters and selection lines."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM property WHERE id = $1",
                property_id
            )
            if not row:
                return None
            
            prop = self._row_to_property(row)
            
            # Load type filters
            if prop.type in RELATION_TYPES:
                filter_rows = await conn.fetch(
                    "SELECT type_node_id FROM property_type_filter WHERE property_id = $1",
                    property_id
                )
                prop._type_filters = [f['type_node_id'] for f in filter_rows]
            
            # Load selection lines
            if prop.type == PropertyType.SELECTION:
                line_rows = await conn.fetch(
                    'SELECT * FROM property_selection_line WHERE property_id = $1 ORDER BY "order"',
                    property_id
                )
                prop._selection_lines = [self._row_to_selection_line(l) for l in line_rows]
            
            return prop
    
    async def get_by_uuid(self, uuid: str) -> Optional[Property]:
        """Get property by UUID."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id FROM property WHERE uuid = $1",
                uuid
            )
            if not row:
                return None
            return await self.get_by_id(row['id'])
    
    async def get_by_name(self, name: str, node_id: Optional[int] = None) -> Optional[Property]:
        """Get property by name."""
        async with self._pool.acquire() as conn:
            if node_id is not None:
                # Look for local property first
                row = await conn.fetchrow(
                    "SELECT id FROM property WHERE name = $1 AND is_local = TRUE AND node_id = $2",
                    name, node_id
                )
                if row:
                    return await self.get_by_id(row['id'])
            
            # Fall back to global property
            row = await conn.fetchrow(
                "SELECT id FROM property WHERE name = $1 AND is_local = FALSE",
                name
            )
            if not row:
                return None
            return await self.get_by_id(row['id'])
    
    async def get_all(self, include_local: bool = True) -> List[Property]:
        """Get all property definitions."""
        async with self._pool.acquire() as conn:
            if include_local:
                rows = await conn.fetch(
                    "SELECT * FROM property WHERE workspace_id = $1 OR workspace_id IS NULL ORDER BY name",
                    self._workspace_id
                )
            else:
                rows = await conn.fetch(
                    "SELECT * FROM property WHERE (workspace_id = $1 OR workspace_id IS NULL) AND is_local = FALSE ORDER BY name",
                    self._workspace_id
                )
            return [self._row_to_property(row) for row in rows]
    
    async def get_local_properties(self, node_id: int) -> List[Property]:
        """Get all local properties for a specific page node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM property WHERE is_local = TRUE AND node_id = $1 ORDER BY name",
                node_id
            )
            return [self._row_to_property(row) for row in rows]
    
    async def update(self, property_id: int, name: Optional[str] = None,
                     icon: Optional[str] = None) -> Optional[Property]:
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
        
        if updates:
            updates.append(f"write_date = ${param_idx}")
            params.append(now)
            param_idx += 1
            params.append(property_id)
            
            async with self._pool.acquire() as conn:
                await conn.execute(
                    f"UPDATE property SET {', '.join(updates)} WHERE id = ${param_idx}",
                    *params
                )
        
        return await self.get_by_id(property_id)
    
    async def can_delete_property(self, property_id: int) -> tuple[bool, str]:
        """Check if a property can be deleted."""
        async with self._pool.acquire() as conn:
            # Check for scalar values
            row = await conn.fetchrow(
                "SELECT COUNT(*) as cnt FROM property_value_scalar WHERE property_id = $1",
                property_id
            )
            if row['cnt'] > 0:
                return False, f"Property has {row['cnt']} scalar value(s)"
            
            # Check for relation values
            row = await conn.fetchrow(
                "SELECT COUNT(*) as cnt FROM property_value_relation WHERE property_id = $1",
                property_id
            )
            if row['cnt'] > 0:
                return False, f"Property has {row['cnt']} relation value(s)"
            
            # Check for selection values
            row = await conn.fetchrow(
                "SELECT COUNT(*) as cnt FROM property_value_selection WHERE property_id = $1",
                property_id
            )
            if row['cnt'] > 0:
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
        
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE property SET type = $1, is_multi = $2, write_date = $3 WHERE id = $4",
                new_type.value, is_multi, now, property_id
            )
            
            if new_type not in RELATION_TYPES:
                await conn.execute(
                    "DELETE FROM property_type_filter WHERE property_id = $1",
                    property_id
                )
            
            if new_type != PropertyType.SELECTION:
                await conn.execute(
                    "DELETE FROM property_selection_line WHERE property_id = $1",
                    property_id
                )
        
        return await self.get_by_id(property_id)
    
    async def delete(self, property_id: int) -> bool:
        """Delete a property if no values exist."""
        prop = await self.get_by_id(property_id)
        if not prop:
            return False
        
        if prop.is_system:
            raise ValueError("Cannot delete system properties")
        
        can_delete, reason = await self.can_delete_property(property_id)
        if not can_delete:
            raise ValueError(reason)
        
        async with self._pool.acquire() as conn:
            await conn.execute("DELETE FROM property WHERE id = $1", property_id)
        return True
    
    # ============== Node Property (Assignment) ==============
    
    async def assign_property_to_node(self, node_id: int, property_id: int) -> NodeProperty:
        """Assign a property to a node (without setting a value)."""
        now = utc_now()
        
        async with self._pool.acquire() as conn:
            # Check if already assigned
            row = await conn.fetchrow(
                "SELECT * FROM node_property WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            if row:
                return self._row_to_node_property(row)
            
            row = await conn.fetchrow("""
                INSERT INTO node_property (node_id, property_id, create_date, write_date)
                VALUES ($1, $2, $3, $3)
                RETURNING *
            """, node_id, property_id, now)
            
            return self._row_to_node_property(row)
    
    async def get_node_property(self, node_id: int, property_id: int) -> Optional[NodeProperty]:
        """Get a node_property assignment."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node_property WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return self._row_to_node_property(row) if row else None
    
    async def get_node_properties(self, node_id: int) -> List[NodeProperty]:
        """Get all property assignments for a node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_property WHERE node_id = $1 ORDER BY property_id",
                node_id
            )
            return [self._row_to_node_property(row) for row in rows]
    
    async def remove_property_from_node(self, node_id: int, property_id: int) -> bool:
        """Remove a property assignment from a node."""
        prop = await self.get_by_id(property_id)
        
        async with self._pool.acquire() as conn:
            if prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE):
                # Delete target nodes for text/image types
                rows = await conn.fetch(
                    "SELECT target_node_id FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                    node_id, property_id
                )
                for row in rows:
                    await conn.execute("DELETE FROM node WHERE id = $1", row['target_node_id'])
            
            result = await conn.execute(
                "DELETE FROM node_property WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return result == "DELETE 1"
    
    async def get_node_ids_with_property(self, property_id: int) -> List[int]:
        """Get all node IDs that have a specific property assigned."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT node_id FROM node_property WHERE property_id = $1",
                property_id
            )
            return [row['node_id'] for row in rows]
    
    # ============== Scalar Values ==============
    
    async def set_scalar_value(self, node_id: int, property_id: int, value: Any, order: int = 0) -> PropertyValueScalar:
        """Set a scalar property value for a node."""
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type not in SCALAR_TYPES:
            raise ValueError(f"Property {property_id} is not a scalar type")
        
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now()
        
        async with self._pool.acquire() as conn:
            if not prop.is_multi:
                await conn.execute(
                    "DELETE FROM property_value_scalar WHERE node_property_id = $1",
                    np.id
                )
            
            value_text = None
            value_boolean = None
            value_float = None
            value_integer = None
            
            if prop.type == PropertyType.INTEGER:
                value_integer = int(value) if value is not None else None
            elif prop.type == PropertyType.FLOAT:
                value_float = float(value) if value is not None else None
            elif prop.type == PropertyType.BOOLEAN:
                value_boolean = bool(value) if value is not None else None
            
            row = await conn.fetchrow("""
                INSERT INTO property_value_scalar 
                (node_property_id, property_id, node_id, value_text, value_boolean, value_float, value_integer, "order", create_date, write_date)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
                RETURNING *
            """, np.id, property_id, node_id, value_text, value_boolean, value_float, value_integer, order, now)
            
            return self._row_to_scalar_value(row)
    
    async def get_scalar_values(self, node_id: int, property_id: int) -> List[PropertyValueScalar]:
        """Get all scalar values for a property on a node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                'SELECT * FROM property_value_scalar WHERE node_id = $1 AND property_id = $2 ORDER BY "order"',
                node_id, property_id
            )
            return [self._row_to_scalar_value(row) for row in rows]
    
    async def remove_scalar_value(self, value_id: int) -> bool:
        """Remove a specific scalar value."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM property_value_scalar WHERE id = $1",
                value_id
            )
            return result == "DELETE 1"
    
    async def clear_scalar_values(self, node_id: int, property_id: int) -> int:
        """Remove all scalar values for a property on a node."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM property_value_scalar WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return int(result.split()[-1]) if result else 0
    
    # ============== Relation Values ==============
    
    async def set_relation_value(self, node_id: int, property_id: int, target_node_id: int, order: int = 0) -> PropertyValueRelation:
        """Set a relation property value for a node."""
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type not in RELATION_TYPES:
            raise ValueError(f"Property {property_id} is not a relation type")
        
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now()
        
        async with self._pool.acquire() as conn:
            if not prop.is_multi:
                await conn.execute(
                    "DELETE FROM property_value_relation WHERE node_property_id = $1",
                    np.id
                )
            
            row = await conn.fetchrow("""
                INSERT INTO property_value_relation 
                (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
                VALUES ($1, $2, $3, $4, $5, $6, $6)
                RETURNING *
            """, np.id, property_id, node_id, target_node_id, order, now)
            
            return self._row_to_relation_value(row)
    
    async def get_relation_values(self, node_id: int, property_id: int) -> List[PropertyValueRelation]:
        """Get all relation values for a property on a node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                'SELECT * FROM property_value_relation WHERE node_id = $1 AND property_id = $2 ORDER BY "order"',
                node_id, property_id
            )
            return [self._row_to_relation_value(row) for row in rows]
    
    async def remove_relation_value(self, value_id: int, delete_target_node: bool = False) -> bool:
        """Remove a specific relation value."""
        async with self._pool.acquire() as conn:
            if delete_target_node:
                row = await conn.fetchrow(
                    "SELECT target_node_id FROM property_value_relation WHERE id = $1",
                    value_id
                )
                if row:
                    await conn.execute("DELETE FROM node WHERE id = $1", row['target_node_id'])
            
            result = await conn.execute(
                "DELETE FROM property_value_relation WHERE id = $1",
                value_id
            )
            return result == "DELETE 1"
    
    async def clear_relation_values(self, node_id: int, property_id: int, delete_target_nodes: bool = False) -> int:
        """Remove all relation values for a property on a node."""
        async with self._pool.acquire() as conn:
            if delete_target_nodes:
                rows = await conn.fetch(
                    "SELECT target_node_id FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                    node_id, property_id
                )
                for row in rows:
                    await conn.execute("DELETE FROM node WHERE id = $1", row['target_node_id'])
            
            result = await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return int(result.split()[-1]) if result else 0
    
    # ============== Selection Lines ==============
    
    async def add_selection_line(self, property_id: int, name: str, icon: Optional[str] = None, order: int = 0) -> PropertySelectionLine:
        """Add an option to a selection-type property."""
        now = utc_now()
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO property_selection_line (property_id, name, icon, "order", create_date, write_date)
                VALUES ($1, $2, $3, $4, $5, $5)
                RETURNING *
            """, property_id, name, icon, order, now)
            return self._row_to_selection_line(row)
    
    async def get_selection_lines(self, property_id: int) -> List[PropertySelectionLine]:
        """Get all selection options for a property."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                'SELECT * FROM property_selection_line WHERE property_id = $1 ORDER BY "order"',
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
            updates.append(f'"order" = ${param_idx}')
            params.append(order)
            param_idx += 1
        
        if not updates:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT * FROM property_selection_line WHERE id = $1",
                    line_id
                )
                return self._row_to_selection_line(row) if row else None
        
        updates.append(f"write_date = ${param_idx}")
        params.append(now)
        param_idx += 1
        params.append(line_id)
        
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"UPDATE property_selection_line SET {', '.join(updates)} WHERE id = ${param_idx} RETURNING *",
                *params
            )
            return self._row_to_selection_line(row) if row else None
    
    async def can_delete_selection_line(self, line_id: int) -> tuple[bool, str]:
        """Check if a selection line can be deleted."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT COUNT(*) as cnt FROM property_value_selection WHERE selection_line_id = $1",
                line_id
            )
            if row['cnt'] > 0:
                return False, f"Selection option is used by {row['cnt']} node(s)"
            return True, ""
    
    async def delete_selection_line(self, line_id: int) -> bool:
        """Delete a selection option if not in use."""
        can_delete, reason = await self.can_delete_selection_line(line_id)
        if not can_delete:
            raise ValueError(reason)
        
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM property_selection_line WHERE id = $1",
                line_id
            )
            return result == "DELETE 1"
    
    # ============== Selection Values ==============
    
    async def set_selection_value(self, node_id: int, property_id: int, selection_line_id: int, order: int = 0) -> PropertyValueSelection:
        """Set a selection property value for a node."""
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now()
        
        prop = await self.get_by_id(property_id)
        
        async with self._pool.acquire() as conn:
            if prop and not prop.is_multi:
                await conn.execute(
                    "DELETE FROM property_value_selection WHERE node_property_id = $1",
                    np.id
                )
            
            row = await conn.fetchrow("""
                INSERT INTO property_value_selection 
                (node_property_id, property_id, node_id, selection_line_id, "order", create_date, write_date)
                VALUES ($1, $2, $3, $4, $5, $6, $6)
                RETURNING *
            """, np.id, property_id, node_id, selection_line_id, order, now)
            
            return self._row_to_selection_value(row)
    
    async def get_selection_values(self, node_id: int, property_id: int) -> List[PropertyValueSelection]:
        """Get all selection values for a property on a node."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                'SELECT * FROM property_value_selection WHERE node_id = $1 AND property_id = $2 ORDER BY "order"',
                node_id, property_id
            )
            return [self._row_to_selection_value(row) for row in rows]
    
    async def remove_selection_value(self, value_id: int) -> bool:
        """Remove a specific selection value."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM property_value_selection WHERE id = $1",
                value_id
            )
            return result == "DELETE 1"
    
    async def clear_selection_values(self, node_id: int, property_id: int) -> int:
        """Remove all selection values for a property on a node."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id = $1 AND property_id = $2",
                node_id, property_id
            )
            return int(result.split()[-1]) if result else 0
    
    # ============== Type Filters ==============
    
    async def add_type_filter(self, property_id: int, type_node_id: int) -> PropertyTypeFilter:
        """Add a type filter to a relation-type property."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO property_type_filter (property_id, type_node_id)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
                RETURNING id
            """, property_id, type_node_id)
            
            return PropertyTypeFilter(
                id=row['id'] if row else 0,
                property_id=property_id,
                type_node_id=type_node_id,
            )
    
    async def get_type_filters(self, property_id: int) -> List[int]:
        """Get all type filter node IDs for a property."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT type_node_id FROM property_type_filter WHERE property_id = $1",
                property_id
            )
            return [row['type_node_id'] for row in rows]
    
    async def remove_type_filter(self, property_id: int, type_node_id: int) -> bool:
        """Remove a type filter from a property."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM property_type_filter WHERE property_id = $1 AND type_node_id = $2",
                property_id, type_node_id
            )
            return result == "DELETE 1"
    
    # ============== Unified Value Access ==============
    
    async def get_all_property_values(self, node_id: int) -> dict[int, dict[str, Any]]:
        """Get all property values for a node, grouped by property_id."""
        result: dict[int, dict[str, Any]] = {}
        
        async with self._pool.acquire() as conn:
            # Get scalar values
            scalar_rows = await conn.fetch(
                "SELECT * FROM property_value_scalar WHERE node_id = $1",
                node_id
            )
            for row in scalar_rows:
                prop_id = row['property_id']
                if prop_id not in result:
                    result[prop_id] = {'scalar': [], 'relation': [], 'selection': []}
                result[prop_id]['scalar'].append(self._row_to_scalar_value(row))
            
            # Get relation values
            relation_rows = await conn.fetch(
                "SELECT * FROM property_value_relation WHERE node_id = $1",
                node_id
            )
            for row in relation_rows:
                prop_id = row['property_id']
                if prop_id not in result:
                    result[prop_id] = {'scalar': [], 'relation': [], 'selection': []}
                result[prop_id]['relation'].append(self._row_to_relation_value(row))
            
            # Get selection values
            selection_rows = await conn.fetch(
                "SELECT * FROM property_value_selection WHERE node_id = $1",
                node_id
            )
            for row in selection_rows:
                prop_id = row['property_id']
                if prop_id not in result:
                    result[prop_id] = {'scalar': [], 'relation': [], 'selection': []}
                result[prop_id]['selection'].append(self._row_to_selection_value(row))
        
        return result
    
    async def clear_all_property_values(self, node_id: int, property_id: int) -> None:
        """Clear all values for a property on a node (but keep the assignment)."""
        async with self._pool.acquire() as conn:
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
    
    # ============== Type Properties ==============
    
    async def get_type_properties(self, type_node_id: int) -> List[TypeProperty]:
        """Get properties that a type applies to typed nodes."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM type_property WHERE type_node_id = $1 ORDER BY sequence",
                type_node_id
            )
            return [self._row_to_type_property(row) for row in rows]
    
    async def add_type_property(self, type_node_id: int, property_id: int,
                                 sequence: int = 0, default_value: Any = None) -> TypeProperty:
        """Link a property to a type/class."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO type_property (type_node_id, property_id, sequence)
                VALUES ($1, $2, $3)
                ON CONFLICT (type_node_id, property_id) DO UPDATE SET sequence = $3
                RETURNING *
            """, type_node_id, property_id, sequence)
            return self._row_to_type_property(row)
    
    async def remove_type_property(self, type_node_id: int, property_id: int) -> bool:
        """Remove a property from a type/class."""
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM type_property WHERE type_node_id = $1 AND property_id = $2",
                type_node_id, property_id
            )
            return result == "DELETE 1"
    
    async def get_all_inherited_properties(self, type_node_id: int) -> List[TypeProperty]:
        """Get all properties for a type including inherited ones."""
        async with self._pool.acquire() as conn:
            # Use recursive CTE to get inherited properties
            rows = await conn.fetch("""
                WITH RECURSIVE type_hierarchy AS (
                    SELECT type_node_id, extends_type_node_id, 0 as depth
                    FROM type_extends WHERE type_node_id = $1
                    UNION ALL
                    SELECT te.type_node_id, te.extends_type_node_id, th.depth + 1
                    FROM type_extends te
                    JOIN type_hierarchy th ON te.type_node_id = th.extends_type_node_id
                    WHERE th.depth < 10
                )
                SELECT DISTINCT tp.* FROM type_property tp
                WHERE tp.type_node_id = $1
                   OR tp.type_node_id IN (SELECT extends_type_node_id FROM type_hierarchy)
                ORDER BY tp.sequence
            """, type_node_id)
            return [self._row_to_type_property(row) for row in rows]
