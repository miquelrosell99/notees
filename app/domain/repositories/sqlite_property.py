"""SQLite implementation of Property repository.

New property system with separate tables for:
- property: Property definitions
- node_property: Assignment of properties to nodes
- property_value_scalar: Scalar values (integer, float, boolean)
- property_value_relation: Relation values (node references)
- property_selection_line: Selection options
- property_value_selection: Selection values
"""
from __future__ import annotations

from typing import Optional, List, Any, Union

import aiosqlite

from ..entities import (
    Property, PropertyType, PropertySelectionLine,
    PropertyTypeFilter, TypeProperty, TypeExtends,
    NodeProperty, PropertyValueScalar, PropertyValueRelation, PropertyValueSelection,
    SCALAR_TYPES, RELATION_TYPES, ALWAYS_SINGLE_TYPES,
    generate_uuid, utc_now_iso,
)
from .interfaces import PropertyRepository


class SQLitePropertyRepository(PropertyRepository):
    """SQLite implementation of the PropertyRepository."""
    
    def __init__(self, connection: aiosqlite.Connection):
        """Initialize with database connection."""
        self._conn = connection
    
    def _row_to_property(self, row: aiosqlite.Row) -> Property:
        """Convert database row to Property entity."""
        return Property(
            id=row['id'],
            uuid=row['uuid'],
            name=row['name'],
            icon=row['icon'] if 'icon' in row.keys() else None,
            type=PropertyType(row['type']),
            is_multi=bool(row['is_multi']),
            is_system=bool(row['is_system']),
            is_local=bool(row['is_local']) if 'is_local' in row.keys() else False,
            node_id=row['node_id'] if 'node_id' in row.keys() else None,
            create_date=row['create_date'],
            write_date=row['write_date'],
        )
    
    def _row_to_node_property(self, row: aiosqlite.Row) -> NodeProperty:
        """Convert database row to NodeProperty entity."""
        return NodeProperty(
            id=row['id'],
            node_id=row['node_id'],
            property_id=row['property_id'],
            create_date=row['create_date'],
            write_date=row['write_date'],
        )
    
    def _row_to_scalar_value(self, row: aiosqlite.Row) -> PropertyValueScalar:
        """Convert database row to PropertyValueScalar entity."""
        return PropertyValueScalar(
            id=row['id'],
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            value_text=row['value_text'],
            value_boolean=bool(row['value_boolean']) if row['value_boolean'] is not None else None,
            value_float=row['value_float'],
            value_integer=row['value_integer'],
            order=row['order'],
            create_date=row['create_date'],
            write_date=row['write_date'],
        )
    
    def _row_to_relation_value(self, row: aiosqlite.Row) -> PropertyValueRelation:
        """Convert database row to PropertyValueRelation entity."""
        return PropertyValueRelation(
            id=row['id'],
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            target_node_id=row['target_node_id'],
            order=row['order'],
            create_date=row['create_date'],
            write_date=row['write_date'],
        )
    
    def _row_to_selection_value(self, row: aiosqlite.Row) -> PropertyValueSelection:
        """Convert database row to PropertyValueSelection entity."""
        return PropertyValueSelection(
            id=row['id'],
            node_property_id=row['node_property_id'],
            property_id=row['property_id'],
            node_id=row['node_id'],
            selection_line_id=row['selection_line_id'],
            order=row['order'],
            create_date=row['create_date'],
            write_date=row['write_date'],
        )
    
    def _row_to_selection_line(self, row: aiosqlite.Row) -> PropertySelectionLine:
        """Convert database row to PropertySelectionLine entity."""
        return PropertySelectionLine(
            id=row['id'],
            property_id=row['property_id'],
            name=row['name'],
            icon=row['icon'] if 'icon' in row.keys() else None,
            order=row['order'],
            create_date=row['create_date'],
            write_date=row['write_date'],
        )
    
    # ============== Property CRUD ==============
    
    async def create(self, property: Property) -> Property:
        """Create a new property definition.
        
        Validates:
        - Global properties must have unique names
        - Local properties must have unique names per node_id
        - node_id must reference a page node if is_local
        - text/image types force is_multi=False
        """
        now = utc_now_iso()
        uuid = property.uuid if property.uuid else generate_uuid()
        
        # Enforce text/image single value constraint
        is_multi = property.is_multi
        if property.type in ALWAYS_SINGLE_TYPES:
            is_multi = False
        
        # Validate local property constraints
        if property.is_local:
            if not property.node_id:
                raise ValueError("Local properties must have a node_id")
            # Verify node_id is a page
            cursor = await self._conn.execute(
                "SELECT is_page FROM node WHERE id = ?",
                (property.node_id,)
            )
            row = await cursor.fetchone()
            if not row or not row['is_page']:
                raise ValueError("Local property node_id must reference a page node")
        
        cursor = await self._conn.execute("""
            INSERT INTO property (uuid, name, icon, type, is_multi, is_system, is_local, node_id, create_date, write_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            uuid, property.name, property.icon, property.type.value,
            int(is_multi), int(property.is_system), int(property.is_local),
            property.node_id, now, now
        ))
        
        property.id = cursor.lastrowid
        property.uuid = uuid
        property.is_multi = is_multi
        property.create_date = now
        property.write_date = now
        
        await self._conn.commit()
        return property
    
    async def get_by_id(self, property_id: int) -> Optional[Property]:
        """Get property by ID with type filters and selection lines."""
        cursor = await self._conn.execute(
            "SELECT * FROM property WHERE id = ?",
            (property_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        
        prop = self._row_to_property(row)
        
        # Load type filters for relation-type properties
        if prop.type in RELATION_TYPES:
            cursor = await self._conn.execute(
                "SELECT type_node_id FROM property_type_filter WHERE property_id = ?",
                (property_id,)
            )
            filters = await cursor.fetchall()
            prop._type_filters = [f['type_node_id'] for f in filters]
        
        # Load selection lines for selection-type properties
        if prop.type == PropertyType.SELECTION:
            cursor = await self._conn.execute(
                'SELECT * FROM property_selection_line WHERE property_id = ? ORDER BY "order"',
                (property_id,)
            )
            lines = await cursor.fetchall()
            prop._selection_lines = [self._row_to_selection_line(l) for l in lines]
        
        return prop
    
    async def get_by_uuid(self, uuid: str) -> Optional[Property]:
        """Get property by UUID."""
        cursor = await self._conn.execute(
            "SELECT id FROM property WHERE uuid = ?",
            (uuid,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        return await self.get_by_id(row['id'])
    
    async def get_by_name(self, name: str, node_id: Optional[int] = None) -> Optional[Property]:
        """Get property by name.
        
        For global properties, node_id should be None.
        For local properties, node_id specifies the page context.
        """
        if node_id is not None:
            # Look for local property first
            cursor = await self._conn.execute(
                "SELECT id FROM property WHERE name = ? AND is_local = 1 AND node_id = ?",
                (name, node_id)
            )
            row = await cursor.fetchone()
            if row:
                return await self.get_by_id(row['id'])
        
        # Fall back to global property
        cursor = await self._conn.execute(
            "SELECT id FROM property WHERE name = ? AND is_local = 0",
            (name,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        return await self.get_by_id(row['id'])
    
    async def get_all(self, include_local: bool = True) -> List[Property]:
        """Get all property definitions."""
        if include_local:
            cursor = await self._conn.execute(
                "SELECT * FROM property ORDER BY name"
            )
        else:
            cursor = await self._conn.execute(
                "SELECT * FROM property WHERE is_local = 0 ORDER BY name"
            )
        rows = await cursor.fetchall()
        return [self._row_to_property(row) for row in rows]
    
    async def get_local_properties(self, node_id: int) -> List[Property]:
        """Get all local properties for a specific page node."""
        cursor = await self._conn.execute(
            "SELECT * FROM property WHERE is_local = 1 AND node_id = ? ORDER BY name",
            (node_id,)
        )
        rows = await cursor.fetchall()
        return [self._row_to_property(row) for row in rows]
    
    async def update(self, property_id: int, name: Optional[str] = None, 
                     icon: Optional[str] = None) -> Optional[Property]:
        """Update a property definition.
        
        Only name and icon can be updated. Type changes require no values exist.
        """
        prop = await self.get_by_id(property_id)
        if not prop:
            return None
        
        if prop.is_system:
            raise ValueError("Cannot modify system properties")
        
        updates = []
        params = []
        now = utc_now_iso()
        
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        
        if icon is not None:
            updates.append("icon = ?")
            params.append(icon)
        
        if updates:
            updates.append("write_date = ?")
            params.append(now)
            params.append(property_id)
            
            await self._conn.execute(
                f"UPDATE property SET {', '.join(updates)} WHERE id = ?",
                params
            )
            await self._conn.commit()
        
        return await self.get_by_id(property_id)
    
    async def can_delete_property(self, property_id: int) -> tuple[bool, str]:
        """Check if a property can be deleted.
        
        Properties cannot be deleted if they have values assigned.
        Returns (can_delete, reason).
        """
        # Check for scalar values
        cursor = await self._conn.execute(
            "SELECT COUNT(*) as cnt FROM property_value_scalar WHERE property_id = ?",
            (property_id,)
        )
        row = await cursor.fetchone()
        if row['cnt'] > 0:
            return False, f"Property has {row['cnt']} scalar value(s)"
        
        # Check for relation values
        cursor = await self._conn.execute(
            "SELECT COUNT(*) as cnt FROM property_value_relation WHERE property_id = ?",
            (property_id,)
        )
        row = await cursor.fetchone()
        if row['cnt'] > 0:
            return False, f"Property has {row['cnt']} relation value(s)"
        
        # Check for selection values
        cursor = await self._conn.execute(
            "SELECT COUNT(*) as cnt FROM property_value_selection WHERE property_id = ?",
            (property_id,)
        )
        row = await cursor.fetchone()
        if row['cnt'] > 0:
            return False, f"Property has {row['cnt']} selection value(s)"
        
        return True, ""
    
    async def can_change_property_type(self, property_id: int, new_type: PropertyType) -> tuple[bool, str]:
        """Check if a property type can be changed.
        
        Type changes are only allowed if no values exist for this property.
        """
        can_delete, reason = await self.can_delete_property(property_id)
        if not can_delete:
            return False, f"Cannot change type: {reason}"
        return True, ""
    
    async def change_property_type(self, property_id: int, new_type: PropertyType, 
                                    new_is_multi: Optional[bool] = None) -> Optional[Property]:
        """Change a property's type if no values exist.
        
        This will remove all node_property assignments and recreate them
        as needed with the new type.
        """
        prop = await self.get_by_id(property_id)
        if not prop:
            return None
        
        if prop.is_system:
            raise ValueError("Cannot modify system properties")
        
        can_change, reason = await self.can_change_property_type(property_id, new_type)
        if not can_change:
            raise ValueError(reason)
        
        now = utc_now_iso()
        is_multi = new_is_multi if new_is_multi is not None else prop.is_multi
        
        # Enforce text/image single value constraint
        if new_type in ALWAYS_SINGLE_TYPES:
            is_multi = False
        
        await self._conn.execute(
            "UPDATE property SET type = ?, is_multi = ?, write_date = ? WHERE id = ?",
            (new_type.value, int(is_multi), now, property_id)
        )
        
        # Clean up type filters if no longer a relation type
        if new_type not in RELATION_TYPES:
            await self._conn.execute(
                "DELETE FROM property_type_filter WHERE property_id = ?",
                (property_id,)
            )
        
        # Clean up selection lines if no longer a selection type
        if new_type != PropertyType.SELECTION:
            await self._conn.execute(
                "DELETE FROM property_selection_line WHERE property_id = ?",
                (property_id,)
            )
        
        await self._conn.commit()
        return await self.get_by_id(property_id)
    
    async def delete(self, property_id: int) -> bool:
        """Delete a property if no values exist.
        
        Will cascade delete:
        - node_property assignments
        - property_type_filter entries
        - property_selection_line entries (which cascade to property_value_selection)
        """
        prop = await self.get_by_id(property_id)
        if not prop:
            return False
        
        if prop.is_system:
            raise ValueError("Cannot delete system properties")
        
        can_delete, reason = await self.can_delete_property(property_id)
        if not can_delete:
            raise ValueError(reason)
        
        # Delete property (cascades to node_property, type_filter, selection_line)
        await self._conn.execute(
            "DELETE FROM property WHERE id = ?",
            (property_id,)
        )
        await self._conn.commit()
        return True
    
    # ============== Node Property (Assignment) ==============
    
    async def assign_property_to_node(self, node_id: int, property_id: int) -> NodeProperty:
        """Assign a property to a node (without setting a value)."""
        now = utc_now_iso()
        
        # Check if already assigned
        cursor = await self._conn.execute(
            "SELECT * FROM node_property WHERE node_id = ? AND property_id = ?",
            (node_id, property_id)
        )
        row = await cursor.fetchone()
        if row:
            return self._row_to_node_property(row)
        
        cursor = await self._conn.execute("""
            INSERT INTO node_property (node_id, property_id, create_date, write_date)
            VALUES (?, ?, ?, ?)
        """, (node_id, property_id, now, now))
        
        await self._conn.commit()
        
        return NodeProperty(
            id=cursor.lastrowid,
            node_id=node_id,
            property_id=property_id,
            create_date=now,
            write_date=now,
        )
    
    async def get_node_property(self, node_id: int, property_id: int) -> Optional[NodeProperty]:
        """Get a node_property assignment."""
        cursor = await self._conn.execute(
            "SELECT * FROM node_property WHERE node_id = ? AND property_id = ?",
            (node_id, property_id)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        return self._row_to_node_property(row)
    
    async def get_node_property_by_id(self, node_property_id: int) -> Optional[NodeProperty]:
        """Get a node_property by its ID."""
        cursor = await self._conn.execute(
            "SELECT * FROM node_property WHERE id = ?",
            (node_property_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        return self._row_to_node_property(row)
    
    async def get_node_properties(self, node_id: int) -> List[NodeProperty]:
        """Get all property assignments for a node."""
        cursor = await self._conn.execute(
            "SELECT * FROM node_property WHERE node_id = ? ORDER BY property_id",
            (node_id,)
        )
        rows = await cursor.fetchall()
        return [self._row_to_node_property(row) for row in rows]
    
    async def remove_property_from_node(self, node_id: int, property_id: int) -> bool:
        """Remove a property assignment from a node.
        
        For text/image types, also deletes the target nodes to avoid floating blocks.
        Cascades to delete all values.
        """
        # For text/image types, we need to delete the target nodes first
        prop = await self.get_by_id(property_id)
        if prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE):
            # Get all target node IDs for this property on this node
            cursor = await self._conn.execute(
                "SELECT target_node_id FROM property_value_relation WHERE node_id = ? AND property_id = ?",
                (node_id, property_id)
            )
            rows = await cursor.fetchall()
            target_node_ids = [row['target_node_id'] for row in rows]
            
            # Delete the target nodes (the property_value_relation will cascade delete)
            for target_id in target_node_ids:
                await self._conn.execute(
                    "DELETE FROM node WHERE id = ?",
                    (target_id,)
                )
        
        cursor = await self._conn.execute(
            "DELETE FROM node_property WHERE node_id = ? AND property_id = ?",
            (node_id, property_id)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    async def get_node_ids_with_property(self, property_id: int) -> List[int]:
        """Get all node IDs that have a specific property assigned."""
        cursor = await self._conn.execute(
            "SELECT DISTINCT node_id FROM node_property WHERE property_id = ?",
            (property_id,)
        )
        rows = await cursor.fetchall()
        return [row['node_id'] for row in rows]
    
    # ============== Scalar Values ==============
    
    async def set_scalar_value(
        self,
        node_id: int,
        property_id: int,
        value: Any,
        order: int = 0
    ) -> PropertyValueScalar:
        """Set a scalar property value for a node.
        
        For non-multi properties, replaces any existing value.
        For multi properties, adds a new value at the specified order.
        """
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type not in SCALAR_TYPES:
            raise ValueError(f"Property {property_id} is not a scalar type")
        
        # Ensure node_property exists
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now_iso()
        
        # For non-multi, remove existing values
        if not prop.is_multi:
            await self._conn.execute(
                "DELETE FROM property_value_scalar WHERE node_property_id = ?",
                (np.id,)
            )
        
        # Determine value column
        value_text = None
        value_boolean = None
        value_float = None
        value_integer = None
        
        if prop.type == PropertyType.INTEGER:
            value_integer = int(value) if value is not None else None
        elif prop.type == PropertyType.FLOAT:
            value_float = float(value) if value is not None else None
        elif prop.type == PropertyType.BOOLEAN:
            value_boolean = int(bool(value)) if value is not None else None
        
        cursor = await self._conn.execute("""
            INSERT INTO property_value_scalar 
            (node_property_id, property_id, node_id, value_text, value_boolean, value_float, value_integer, "order", create_date, write_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (np.id, property_id, node_id, value_text, value_boolean, value_float, value_integer, order, now, now))
        
        await self._conn.commit()
        
        return PropertyValueScalar(
            id=cursor.lastrowid,
            node_property_id=np.id,
            property_id=property_id,
            node_id=node_id,
            value_text=value_text,
            value_boolean=bool(value_boolean) if value_boolean is not None else None,
            value_float=value_float,
            value_integer=value_integer,
            order=order,
            create_date=now,
            write_date=now,
        )
    
    async def get_scalar_values(self, node_id: int, property_id: int) -> List[PropertyValueScalar]:
        """Get all scalar values for a property on a node."""
        cursor = await self._conn.execute(
            'SELECT * FROM property_value_scalar WHERE node_id = ? AND property_id = ? ORDER BY "order"',
            (node_id, property_id)
        )
        rows = await cursor.fetchall()
        return [self._row_to_scalar_value(row) for row in rows]
    
    async def remove_scalar_value(self, value_id: int) -> bool:
        """Remove a specific scalar value."""
        cursor = await self._conn.execute(
            "DELETE FROM property_value_scalar WHERE id = ?",
            (value_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    async def clear_scalar_values(self, node_id: int, property_id: int) -> int:
        """Remove all scalar values for a property on a node."""
        cursor = await self._conn.execute(
            "DELETE FROM property_value_scalar WHERE node_id = ? AND property_id = ?",
            (node_id, property_id)
        )
        await self._conn.commit()
        return cursor.rowcount
    
    # ============== Relation Values ==============
    
    async def set_relation_value(
        self,
        node_id: int,
        property_id: int,
        target_node_id: int,
        order: int = 0
    ) -> PropertyValueRelation:
        """Set a relation property value for a node.
        
        For non-multi properties, replaces any existing value.
        For multi properties, adds a new value at the specified order.
        """
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type not in RELATION_TYPES:
            raise ValueError(f"Property {property_id} is not a relation type")
        
        # For text/image types, enforce that target_node_id can only be used once
        if prop.type in (PropertyType.TEXT, PropertyType.IMAGE):
            cursor = await self._conn.execute(
                "SELECT id FROM property_value_relation WHERE target_node_id = ?",
                (target_node_id,)
            )
            existing = await cursor.fetchone()
            if existing:
                raise ValueError(f"Target node {target_node_id} is already used by another property value (text/image blocks can only be used once)")
        
        # Ensure node_property exists
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now_iso()
        
        # For non-multi, remove existing values
        # For text/image types, also delete the old target nodes
        if not prop.is_multi:
            if prop.type in (PropertyType.TEXT, PropertyType.IMAGE):
                # Get old target node IDs before deleting
                cursor = await self._conn.execute(
                    "SELECT target_node_id FROM property_value_relation WHERE node_property_id = ?",
                    (np.id,)
                )
                old_rows = await cursor.fetchall()
                old_target_ids = [row['target_node_id'] for row in old_rows]
                
                # Delete the property_value_relation first
                await self._conn.execute(
                    "DELETE FROM property_value_relation WHERE node_property_id = ?",
                    (np.id,)
                )
                
                # Then delete the old target nodes
                for old_target_id in old_target_ids:
                    await self._conn.execute(
                        "DELETE FROM node WHERE id = ?",
                        (old_target_id,)
                    )
            else:
                await self._conn.execute(
                    "DELETE FROM property_value_relation WHERE node_property_id = ?",
                    (np.id,)
                )
        
        cursor = await self._conn.execute("""
            INSERT INTO property_value_relation 
            (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (np.id, property_id, node_id, target_node_id, order, now, now))
        
        await self._conn.commit()
        
        return PropertyValueRelation(
            id=cursor.lastrowid,
            node_property_id=np.id,
            property_id=property_id,
            node_id=node_id,
            target_node_id=target_node_id,
            order=order,
            create_date=now,
            write_date=now,
        )
    
    async def get_relation_values(self, node_id: int, property_id: int) -> List[PropertyValueRelation]:
        """Get all relation values for a property on a node."""
        cursor = await self._conn.execute(
            'SELECT * FROM property_value_relation WHERE node_id = ? AND property_id = ? ORDER BY "order"',
            (node_id, property_id)
        )
        rows = await cursor.fetchall()
        return [self._row_to_relation_value(row) for row in rows]
    
    async def remove_relation_value(self, value_id: int, delete_target_node: bool = False) -> bool:
        """Remove a specific relation value.
        
        Args:
            value_id: The ID of the property_value_relation to delete
            delete_target_node: If True, also delete the target node (for text/image types)
        """
        if delete_target_node:
            # Get the target node ID and property type before deleting
            cursor = await self._conn.execute(
                """SELECT pvr.target_node_id, p.type 
                   FROM property_value_relation pvr 
                   JOIN property p ON pvr.property_id = p.id 
                   WHERE pvr.id = ?""",
                (value_id,)
            )
            row = await cursor.fetchone()
            if row and row['type'] in ('text', 'image'):
                target_node_id = row['target_node_id']
                # Delete the node (will cascade delete the property_value_relation)
                await self._conn.execute(
                    "DELETE FROM node WHERE id = ?",
                    (target_node_id,)
                )
                await self._conn.commit()
                return True
        
        cursor = await self._conn.execute(
            "DELETE FROM property_value_relation WHERE id = ?",
            (value_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    async def clear_relation_values(self, node_id: int, property_id: int, delete_target_nodes: bool = False) -> int:
        """Remove all relation values for a property on a node.
        
        Args:
            node_id: The node to clear values from
            property_id: The property to clear values for
            delete_target_nodes: If True and property is text/image type, also delete target nodes
        """
        if delete_target_nodes:
            prop = await self.get_by_id(property_id)
            if prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE):
                # Get all target node IDs before deleting
                cursor = await self._conn.execute(
                    "SELECT target_node_id FROM property_value_relation WHERE node_id = ? AND property_id = ?",
                    (node_id, property_id)
                )
                rows = await cursor.fetchall()
                count = len(rows)
                
                # Delete the target nodes (will cascade delete property_value_relation)
                for row in rows:
                    await self._conn.execute(
                        "DELETE FROM node WHERE id = ?",
                        (row['target_node_id'],)
                    )
                await self._conn.commit()
                return count
        
        cursor = await self._conn.execute(
            "DELETE FROM property_value_relation WHERE node_id = ? AND property_id = ?",
            (node_id, property_id)
        )
        await self._conn.commit()
        return cursor.rowcount
    
    # ============== Selection Lines (Options) ==============
    
    async def add_selection_line(
        self,
        property_id: int,
        name: str,
        icon: Optional[str] = None,
        order: int = 0
    ) -> PropertySelectionLine:
        """Add an option to a selection-type property."""
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type != PropertyType.SELECTION:
            raise ValueError(f"Property {property_id} is not a selection type")
        
        now = utc_now_iso()
        cursor = await self._conn.execute("""
            INSERT INTO property_selection_line (property_id, name, icon, "order", create_date, write_date)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (property_id, name, icon, order, now, now))
        
        await self._conn.commit()
        
        return PropertySelectionLine(
            id=cursor.lastrowid,
            property_id=property_id,
            name=name,
            icon=icon,
            order=order,
            create_date=now,
            write_date=now,
        )
    
    async def get_selection_lines(self, property_id: int) -> List[PropertySelectionLine]:
        """Get all selection options for a property."""
        cursor = await self._conn.execute(
            'SELECT * FROM property_selection_line WHERE property_id = ? ORDER BY "order"',
            (property_id,)
        )
        rows = await cursor.fetchall()
        return [self._row_to_selection_line(row) for row in rows]
    
    async def update_selection_line(
        self,
        line_id: int,
        name: Optional[str] = None,
        icon: Optional[str] = None,
        order: Optional[int] = None
    ) -> Optional[PropertySelectionLine]:
        """Update a selection option."""
        updates = []
        params = []
        now = utc_now_iso()
        
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if icon is not None:
            updates.append("icon = ?")
            params.append(icon)
        if order is not None:
            updates.append('"order" = ?')
            params.append(order)
        
        if updates:
            updates.append("write_date = ?")
            params.append(now)
            params.append(line_id)
            
            await self._conn.execute(
                f"UPDATE property_selection_line SET {', '.join(updates)} WHERE id = ?",
                params
            )
            await self._conn.commit()
        
        cursor = await self._conn.execute(
            "SELECT * FROM property_selection_line WHERE id = ?",
            (line_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        return self._row_to_selection_line(row)
    
    async def can_delete_selection_line(self, line_id: int) -> tuple[bool, str]:
        """Check if a selection line can be deleted.
        
        Cannot delete if used in property_value_selection.
        """
        cursor = await self._conn.execute(
            "SELECT COUNT(*) as cnt FROM property_value_selection WHERE selection_line_id = ?",
            (line_id,)
        )
        row = await cursor.fetchone()
        if row['cnt'] > 0:
            return False, f"Selection option is used in {row['cnt']} value(s)"
        return True, ""
    
    async def delete_selection_line(self, line_id: int) -> bool:
        """Delete a selection option if not in use."""
        can_delete, reason = await self.can_delete_selection_line(line_id)
        if not can_delete:
            raise ValueError(reason)
        
        cursor = await self._conn.execute(
            "DELETE FROM property_selection_line WHERE id = ?",
            (line_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    # ============== Selection Values ==============
    
    async def set_selection_value(
        self,
        node_id: int,
        property_id: int,
        selection_line_id: int,
        order: int = 0
    ) -> PropertyValueSelection:
        """Set a selection property value for a node.
        
        For non-multi properties, replaces any existing value.
        For multi properties, adds a new value at the specified order.
        """
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type != PropertyType.SELECTION:
            raise ValueError(f"Property {property_id} is not a selection type")
        
        # Verify selection_line belongs to this property
        cursor = await self._conn.execute(
            "SELECT id FROM property_selection_line WHERE id = ? AND property_id = ?",
            (selection_line_id, property_id)
        )
        if not await cursor.fetchone():
            raise ValueError(f"Selection line {selection_line_id} does not belong to property {property_id}")
        
        # Ensure node_property exists
        np = await self.assign_property_to_node(node_id, property_id)
        now = utc_now_iso()
        
        # For non-multi, remove existing values
        if not prop.is_multi:
            await self._conn.execute(
                "DELETE FROM property_value_selection WHERE node_property_id = ?",
                (np.id,)
            )
        
        cursor = await self._conn.execute("""
            INSERT INTO property_value_selection 
            (node_property_id, property_id, node_id, selection_line_id, "order", create_date, write_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (np.id, property_id, node_id, selection_line_id, order, now, now))
        
        await self._conn.commit()
        
        return PropertyValueSelection(
            id=cursor.lastrowid,
            node_property_id=np.id,
            property_id=property_id,
            node_id=node_id,
            selection_line_id=selection_line_id,
            order=order,
            create_date=now,
            write_date=now,
        )
    
    async def get_selection_values(self, node_id: int, property_id: int) -> List[PropertyValueSelection]:
        """Get all selection values for a property on a node."""
        cursor = await self._conn.execute(
            'SELECT * FROM property_value_selection WHERE node_id = ? AND property_id = ? ORDER BY "order"',
            (node_id, property_id)
        )
        rows = await cursor.fetchall()
        return [self._row_to_selection_value(row) for row in rows]
    
    async def remove_selection_value(self, value_id: int) -> bool:
        """Remove a specific selection value."""
        cursor = await self._conn.execute(
            "DELETE FROM property_value_selection WHERE id = ?",
            (value_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    async def clear_selection_values(self, node_id: int, property_id: int) -> int:
        """Remove all selection values for a property on a node."""
        cursor = await self._conn.execute(
            "DELETE FROM property_value_selection WHERE node_id = ? AND property_id = ?",
            (node_id, property_id)
        )
        await self._conn.commit()
        return cursor.rowcount
    
    # ============== Type Filters ==============
    
    async def add_type_filter(self, property_id: int, type_node_id: int) -> PropertyTypeFilter:
        """Add a type filter to a relation-type property."""
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        if prop.type not in RELATION_TYPES:
            raise ValueError(f"Property {property_id} is not a relation type")
        
        cursor = await self._conn.execute("""
            INSERT OR IGNORE INTO property_type_filter (property_id, type_node_id)
            VALUES (?, ?)
        """, (property_id, type_node_id))
        await self._conn.commit()
        
        return PropertyTypeFilter(
            id=cursor.lastrowid,
            property_id=property_id,
            type_node_id=type_node_id,
        )
    
    async def get_type_filters(self, property_id: int) -> List[int]:
        """Get all type filter node IDs for a property."""
        cursor = await self._conn.execute(
            "SELECT type_node_id FROM property_type_filter WHERE property_id = ?",
            (property_id,)
        )
        rows = await cursor.fetchall()
        return [row['type_node_id'] for row in rows]
    
    async def remove_type_filter(self, property_id: int, type_node_id: int) -> bool:
        """Remove a type filter from a property."""
        cursor = await self._conn.execute(
            "DELETE FROM property_type_filter WHERE property_id = ? AND type_node_id = ?",
            (property_id, type_node_id)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    # ============== Unified Value Access ==============
    
    async def get_all_property_values(
        self, node_id: int
    ) -> dict[int, dict[str, Any]]:
        """Get all property values for a node, grouped by property_id.
        
        Returns a dict mapping property_id to a dict with:
        - 'property': the Property object
        - 'node_property': the NodeProperty assignment
        - 'values': list of value objects (scalar, relation, or selection)
        """
        result = {}
        
        # Get all node_property assignments
        node_properties = await self.get_node_properties(node_id)
        
        for np in node_properties:
            prop = await self.get_by_id(np.property_id)
            if not prop:
                continue
            
            values = []
            if prop.type in SCALAR_TYPES:
                values = await self.get_scalar_values(node_id, prop.id)
            elif prop.type in RELATION_TYPES:
                values = await self.get_relation_values(node_id, prop.id)
            elif prop.type == PropertyType.SELECTION:
                values = await self.get_selection_values(node_id, prop.id)
            
            result[prop.id] = {
                'property': prop,
                'node_property': np,
                'values': values,
            }
        
        return result
    
    async def clear_all_property_values(self, node_id: int, property_id: int) -> None:
        """Clear all values for a property on a node (but keep the assignment)."""
        prop = await self.get_by_id(property_id)
        if not prop:
            return
        
        if prop.type in SCALAR_TYPES:
            await self.clear_scalar_values(node_id, property_id)
        elif prop.type in RELATION_TYPES:
            await self.clear_relation_values(node_id, property_id)
        elif prop.type == PropertyType.SELECTION:
            await self.clear_selection_values(node_id, property_id)

    # ============== Type Properties (for Types/Classes) ==============
    
    async def get_type_properties(self, type_node_id: int) -> List[TypeProperty]:
        """Get properties that a type/class applies to nodes with that type."""
        cursor = await self._conn.execute(
            "SELECT * FROM type_property WHERE type_node_id = ? ORDER BY sequence",
            (type_node_id,)
        )
        rows = await cursor.fetchall()
        return [
            TypeProperty(
                id=row['id'],
                type_node_id=row['type_node_id'],
                property_id=row['property_id'],
                sequence=row['sequence'],
                hidden=bool(row['hidden']) if row['hidden'] is not None else False,
                default_integer=row['default_integer'],
                default_float=row['default_float'],
                default_text=row['default_text'],
                default_boolean=bool(row['default_boolean']) if row['default_boolean'] is not None else None,
                default_node_id=row['default_node_id'],
                default_selection_id=row['default_selection_id'],
            )
            for row in rows
        ]
    
    async def add_type_property(
        self,
        type_node_id: int,
        property_id: int,
        sequence: int = 0,
        default_value: Any = None
    ) -> TypeProperty:
        """Link a property to a type/class."""
        prop = await self.get_by_id(property_id)
        if not prop:
            raise ValueError(f"Property {property_id} not found")
        
        # Determine default value column
        columns = {
            PropertyType.INTEGER: "default_integer",
            PropertyType.FLOAT: "default_float",
            PropertyType.BOOLEAN: "default_boolean",
            PropertyType.NODE: "default_node_id",
            PropertyType.TEXT: "default_node_id",
            PropertyType.IMAGE: "default_node_id",
            PropertyType.DATE: "default_node_id",
            PropertyType.SELECTION: "default_selection_id",
        }
        
        column = columns.get(prop.type, "default_text")
        db_value = default_value
        if prop.type == PropertyType.BOOLEAN:
            db_value = int(default_value) if default_value is not None else None
        
        cursor = await self._conn.execute(f"""
            INSERT OR REPLACE INTO type_property (type_node_id, property_id, sequence, {column})
            VALUES (?, ?, ?, ?)
        """, (type_node_id, property_id, sequence, db_value))
        await self._conn.commit()
        
        tp = TypeProperty(
            id=cursor.lastrowid,
            type_node_id=type_node_id,
            property_id=property_id,
            sequence=sequence,
        )
        
        if prop.type == PropertyType.INTEGER:
            tp.default_integer = default_value
        elif prop.type == PropertyType.FLOAT:
            tp.default_float = default_value
        elif prop.type == PropertyType.BOOLEAN:
            tp.default_boolean = default_value
        elif prop.type in RELATION_TYPES:
            tp.default_node_id = default_value
        elif prop.type == PropertyType.SELECTION:
            tp.default_selection_id = default_value
        
        return tp
    
    async def remove_type_property(self, type_node_id: int, property_id: int) -> bool:
        """Remove a property from a type/class."""
        cursor = await self._conn.execute(
            "DELETE FROM type_property WHERE type_node_id = ? AND property_id = ?",
            (type_node_id, property_id)
        )
        await self._conn.commit()
        return cursor.rowcount > 0

    # ============== Type Extends (Inheritance) ==============
    
    async def get_type_extends(self, type_node_id: int) -> List[TypeExtends]:
        """Get all types that a type extends (parents)."""
        cursor = await self._conn.execute(
            "SELECT * FROM type_extends WHERE type_node_id = ? ORDER BY sequence",
            (type_node_id,)
        )
        rows = await cursor.fetchall()
        return [
            TypeExtends(
                id=row['id'],
                type_node_id=row['type_node_id'],
                extends_type_node_id=row['extends_type_node_id'],
                sequence=row['sequence'],
            )
            for row in rows
        ]
    
    async def add_type_extends(
        self,
        type_node_id: int,
        extends_type_node_id: int,
        sequence: int = 0
    ) -> TypeExtends:
        """Add a type that this type extends (inheritance)."""
        # Prevent self-extension
        if type_node_id == extends_type_node_id:
            raise ValueError("A type cannot extend itself")
        
        # Check for circular inheritance
        if await self._would_create_cycle(type_node_id, extends_type_node_id):
            raise ValueError("Adding this extension would create a circular inheritance chain")
        
        cursor = await self._conn.execute("""
            INSERT OR REPLACE INTO type_extends (type_node_id, extends_type_node_id, sequence)
            VALUES (?, ?, ?)
        """, (type_node_id, extends_type_node_id, sequence))
        await self._conn.commit()
        
        return TypeExtends(
            id=cursor.lastrowid,
            type_node_id=type_node_id,
            extends_type_node_id=extends_type_node_id,
            sequence=sequence,
        )
    
    async def remove_type_extends(self, type_node_id: int, extends_type_node_id: int) -> bool:
        """Remove a type extension (inheritance link)."""
        cursor = await self._conn.execute(
            "DELETE FROM type_extends WHERE type_node_id = ? AND extends_type_node_id = ?",
            (type_node_id, extends_type_node_id)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    async def _would_create_cycle(self, type_node_id: int, new_parent_id: int) -> bool:
        """Check if adding new_parent_id as parent of type_node_id would create a cycle."""
        # BFS to check if type_node_id is reachable from new_parent_id's ancestry
        visited = set()
        to_check = [new_parent_id]
        
        while to_check:
            current = to_check.pop(0)
            if current in visited:
                continue
            visited.add(current)
            
            # Get parents of current
            cursor = await self._conn.execute(
                "SELECT extends_type_node_id FROM type_extends WHERE type_node_id = ?",
                (current,)
            )
            rows = await cursor.fetchall()
            for row in rows:
                parent_id = row['extends_type_node_id']
                if parent_id == type_node_id:
                    return True  # Would create a cycle
                to_check.append(parent_id)
        
        return False
    
    async def get_all_inherited_properties(self, type_node_id: int) -> List[TypeProperty]:
        """Get all properties for a type including inherited ones from extended types.
        
        Uses breadth-first search to collect properties from the inheritance chain.
        Properties from child types override those from parent types.
        """
        # Collect all types in inheritance chain (using BFS)
        type_chain = []
        visited = set()
        to_check = [type_node_id]
        
        while to_check:
            current = to_check.pop(0)
            if current in visited:
                continue
            visited.add(current)
            type_chain.append(current)
            
            # Get parents
            extends = await self.get_type_extends(current)
            for ext in extends:
                to_check.append(ext.extends_type_node_id)
        
        # Collect properties, with child types having priority
        # (iterate in reverse so parents are processed first, then overwritten by children)
        property_map: dict[int, TypeProperty] = {}
        for type_id in reversed(type_chain):
            props = await self.get_type_properties(type_id)
            for prop in props:
                property_map[prop.property_id] = prop
        
        return list(property_map.values())
