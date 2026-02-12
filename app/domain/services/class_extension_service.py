"""Class extension/inheritance service.

Handles class extension logic using the class_extend table, including:
- Multi-level inheritance of class properties
- Circular reference detection
- Inherited property resolution with override support

The class_extend table stores inheritance relationships:
- target_id: The child class that extends another class
- source_id: The parent class being extended
- sequence: Order when extending multiple classes
"""
from __future__ import annotations

from typing import Optional, List, Dict, Set, Any, TYPE_CHECKING
from dataclasses import dataclass

from ...logging_config import get_logger

if TYPE_CHECKING:
    from ..repositories import PropertyRepository
    import asyncpg
from ...db.connection import acquire_connection

logger = get_logger(__name__)


@dataclass
class InheritedProperty:
    """Represents a property inherited from an extended class."""
    property_id: int
    property_name: str
    property_type: str
    from_class_id: int
    from_class_name: str
    sequence: int
    default_value: Any
    hidden: bool
    is_overridden: bool = False  # True if the property exists as a dedicated class property


@dataclass
class ClassExtend:
    """Represents a class extension relationship."""
    id: int
    target_id: int  # The child class
    source_id: int  # The parent class being extended
    sequence: int
    source_name: str = ""
    source_icon: Optional[str] = None


class CircularInheritanceError(Exception):
    """Raised when a circular inheritance is detected."""
    def __init__(self, cycle_path: List[int]):
        self.cycle_path = cycle_path
        super().__init__(f"Circular inheritance detected: {' -> '.join(map(str, cycle_path))}")


class ClassExtensionService:
    """Service for handling class extension/inheritance using class_extend table."""
    
    def __init__(
        self,
        pool: asyncpg.Pool,
        workspace_id: int,
        property_repository: PropertyRepository,
    ):
        self._pool = pool
        self._workspace_id = workspace_id
        self._property_repo = property_repository
    
    async def get_extended_classes(self, class_node_id: int) -> List[int]:
        """Get the list of class IDs that this class extends (direct only).
        
        Returns class IDs in the order they are defined (by sequence).
        """
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT ce.source_id
                FROM class_extend ce
                JOIN node n ON n.id = ce.source_id
                WHERE ce.target_id = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                ORDER BY ce.sequence, ce.id
            """, class_node_id, self._workspace_id)
            
            return [row['source_id'] for row in rows]
    
    async def get_extended_classes_with_details(self, class_node_id: int) -> List[ClassExtend]:
        """Get the list of classes that this class extends with full details.
        
        Returns ClassExtend objects with source class name and icon.
        """
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT ce.id, ce.target_id, ce.source_id, ce.sequence, n.name, n.icon
                FROM class_extend ce
                JOIN node n ON n.id = ce.source_id
                WHERE ce.target_id = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                ORDER BY ce.sequence, ce.id
            """, class_node_id, self._workspace_id)
            
            return [
                ClassExtend(
                    id=row['id'],
                    target_id=row['target_id'],
                    source_id=row['source_id'],
                    sequence=row['sequence'],
                    source_name=row['name'],
                    source_icon=row['icon'],
                )
                for row in rows
            ]
    
    async def add_extends(self, class_node_id: int, extends_class_id: int, sequence: int = 0) -> ClassExtend:
        """Add an extends relationship between two classes.
        
        Args:
            class_node_id: The child class that will extend another
            extends_class_id: The parent class to extend
            sequence: Order when extending multiple classes
            
        Returns:
            The created ClassExtend relationship
            
        Raises:
            CircularInheritanceError: If this would create a cycle
            ValueError: If the relationship already exists
        """
        # First validate this won't create a cycle
        await self.validate_extends_acyclic(class_node_id, [extends_class_id])
        
        async with acquire_connection(self._pool) as conn:
            # Check if already exists
            existing = await conn.fetchrow("""
                SELECT id FROM class_extend 
                WHERE target_id = $1 AND source_id = $2
            """, class_node_id, extends_class_id)
            
            if existing:
                raise ValueError(f"Class {class_node_id} already extends {extends_class_id}")
            
            # Get the source class details
            source = await conn.fetchrow("""
                SELECT name, icon FROM node WHERE id = $1 AND workspace_id = $2
            """, extends_class_id, self._workspace_id)
            
            if not source:
                raise ValueError(f"Class {extends_class_id} not found")
            
            # Insert the relationship
            row = await conn.fetchrow("""
                INSERT INTO class_extend (target_id, source_id, sequence)
                VALUES ($1, $2, $3)
                RETURNING id, target_id, source_id, sequence
            """, class_node_id, extends_class_id, sequence)
            
            return ClassExtend(
                id=row['id'],
                target_id=row['target_id'],
                source_id=row['source_id'],
                sequence=row['sequence'],
                source_name=source['name'],
                source_icon=source['icon'],
            )
    
    async def remove_extends(self, class_node_id: int, extends_class_id: int) -> bool:
        """Remove an extends relationship.
        
        Returns True if deleted, False if not found.
        """
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute("""
                DELETE FROM class_extend
                WHERE target_id = $1 AND source_id = $2
            """, class_node_id, extends_class_id)
            
            return result == "DELETE 1"
    
    async def get_all_extended_classes(
        self,
        class_node_id: int,
        visited: Optional[Set[int]] = None
    ) -> List[int]:
        """Get all classes extended by this class (multi-level, depth-first).
        
        Returns a list of class IDs in the order they should be inherited from.
        Raises CircularInheritanceError if a cycle is detected.
        
        Inheritance order: [most derived -> least derived]
        Example: C extends B, B extends A -> [C, B, A]
        """
        if visited is None:
            visited = set()
        
        if class_node_id in visited:
            # Circular reference detected
            raise CircularInheritanceError(list(visited) + [class_node_id])
        
        visited.add(class_node_id)
        result = [class_node_id]
        
        # Get direct extensions
        direct_extends = await self.get_extended_classes(class_node_id)
        
        # Recursively get all extensions for each direct extension
        for extended_class_id in direct_extends:
            try:
                extended_chain = await self.get_all_extended_classes(
                    extended_class_id,
                    visited.copy()
                )
                # Add extended classes (excluding the base class_node_id which is already in result)
                for ext_id in extended_chain:
                    if ext_id not in result:
                        result.append(ext_id)
            except CircularInheritanceError:
                raise
        
        return result
    
    async def get_inherited_properties(
        self,
        class_node_id: int
    ) -> List[InheritedProperty]:
        """Get all properties inherited from extended classes.
        
        Properties from more derived classes take precedence.
        Returns properties with is_overridden flag set if they exist as dedicated properties.
        """
        try:
            # Get the inheritance chain
            extended_classes = await self.get_all_extended_classes(class_node_id)
        except CircularInheritanceError as e:
            logger.error(f"Circular inheritance detected for class {class_node_id}: {e}")
            return []
        
        # Remove the class itself from the chain (we only want inherited, not own)
        extended_classes = extended_classes[1:]
        
        if not extended_classes:
            return []
        
        # Get dedicated properties for this class
        dedicated_properties = await self._property_repo.get_class_properties(class_node_id)
        dedicated_prop_ids = {cp.property_id for cp in dedicated_properties}
        
        # Collect properties from all extended classes
        seen_property_ids: Set[int] = set()
        inherited_props: List[InheritedProperty] = []
        
        for extended_class_id in extended_classes:
            class_props = await self._property_repo.get_class_properties(extended_class_id)
            
            # Get class name
            async with acquire_connection(self._pool) as conn:
                class_row = await conn.fetchrow(
                    "SELECT name FROM node WHERE id = $1 AND workspace_id = $2",
                    extended_class_id, self._workspace_id
                )
                class_name = class_row['name'] if class_row else f"Class {extended_class_id}"
            
            for cp in class_props:
                # Skip if already seen (more derived class takes precedence)
                if cp.property_id in seen_property_ids:
                    continue
                
                seen_property_ids.add(cp.property_id)
                
                # Get property details
                property_details = await self._property_repo.get_by_id(cp.property_id)
                if not property_details:
                    logger.warning(f"Property {cp.property_id} not found")
                    continue
                
                # Determine default value based on property type
                default_value: Any = None
                if property_details.type == 'integer':
                    default_value = cp.default_integer
                elif property_details.type == 'float':
                    default_value = cp.default_float
                elif property_details.type in ('text', 'url', 'email', 'phone'):
                    default_value = cp.default_text
                elif property_details.type == 'boolean':
                    default_value = cp.default_boolean
                elif property_details.type == 'relation':
                    default_value = cp.default_node_id
                elif property_details.type == 'selection':
                    default_value = cp.default_selection_id
                
                inherited_props.append(InheritedProperty(
                    property_id=cp.property_id,
                    property_name=property_details.name,
                    property_type=property_details.type,
                    from_class_id=extended_class_id,
                    from_class_name=class_name,
                    sequence=cp.sequence,
                    default_value=default_value,
                    hidden=cp.hidden,
                    is_overridden=cp.property_id in dedicated_prop_ids,
                ))
        
        return inherited_props
    
    async def validate_extends_acyclic(
        self,
        class_node_id: int,
        new_extends_ids: List[int]
    ) -> bool:
        """Validate that adding these extends would not create a cycle.
        
        Returns True if valid, raises CircularInheritanceError if cycle detected.
        """
        # For each new extend, check if it would create a cycle
        for extend_id in new_extends_ids:
            # Check if extend_id itself extends class_node_id (directly or indirectly)
            try:
                extended_chain = await self.get_all_extended_classes(extend_id)
                if class_node_id in extended_chain:
                    raise CircularInheritanceError([class_node_id, extend_id, class_node_id])
            except CircularInheritanceError:
                raise
        
        return True
    
    async def get_classes_extended_by(self, class_node_id: int) -> List[Dict[str, Any]]:
        """Get all classes that extend this class (reverse lookup).
        
        Returns a flat list of classes (not hierarchical).
        """
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT DISTINCT n.id, n.uuid, n.name, n.icon
                FROM node n
                JOIN class_extend ce ON ce.target_id = n.id
                WHERE ce.source_id = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                  AND n.is_class = TRUE
                ORDER BY n.name
            """, class_node_id, self._workspace_id)
            
            return [
                {
                    "id": row['id'],
                    "uuid": str(row['uuid']),
                    "name": row['name'],
                    "icon": row['icon'],
                }
                for row in rows
            ]
    
    async def get_all_subclasses(self, class_node_id: int) -> List[int]:
        """Get all classes that extend this class (recursively).
        
        Returns all subclasses that directly or indirectly extend this class.
        Example: A <- B <- C means if we query A, we get [B, C]
        """
        result = []
        
        async with acquire_connection(self._pool) as conn:
            # Get direct subclasses using class_extend table
            rows = await conn.fetch("""
                SELECT DISTINCT n.id
                FROM node n
                JOIN class_extend ce ON ce.target_id = n.id
                WHERE ce.source_id = $1
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                  AND n.is_class = TRUE
            """, class_node_id, self._workspace_id)
            
            direct_subclasses = [row['id'] for row in rows]
        
        # Add direct subclasses
        result.extend(direct_subclasses)
        
        # Recursively get subclasses of each direct subclass
        for subclass_id in direct_subclasses:
            indirect_subclasses = await self.get_all_subclasses(subclass_id)
            for indirect_id in indirect_subclasses:
                if indirect_id not in result:
                    result.append(indirect_id)
        
        return result
