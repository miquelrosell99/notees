"""Class extension/inheritance service.

Handles class extension logic, including:
- Multi-level inheritance of class properties
- Circular reference detection
- Inherited property resolution with override support
"""
from __future__ import annotations

from typing import Optional, List, Dict, Set, Any, TYPE_CHECKING
from dataclasses import dataclass

from ...logging_config import get_logger
from ...db.schema.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS

if TYPE_CHECKING:
    from ..repositories import PropertyRepository
    import asyncpg

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


class CircularInheritanceError(Exception):
    """Raised when a circular inheritance is detected."""
    def __init__(self, cycle_path: List[int]):
        self.cycle_path = cycle_path
        super().__init__(f"Circular inheritance detected: {' -> '.join(map(str, cycle_path))}")


class ClassExtensionService:
    """Service for handling class extension/inheritance."""
    
    def __init__(
        self,
        pool: asyncpg.Pool,
        graph_id: int,
        property_repository: PropertyRepository,
    ):
        self._pool = pool
        self._graph_id = graph_id
        self._property_repo = property_repository
        self._extends_property_id: Optional[int] = None
    
    async def _get_extends_property_id(self) -> int:
        """Get the ID of the 'extends' system property."""
        if self._extends_property_id is None:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT id FROM property WHERE uuid = $1",
                    SYSTEM_PROPERTY_UUIDS["extends"]
                )
                if not row:
                    raise RuntimeError("extends system property not found")
                self._extends_property_id = row['id']
        # Type checker: after the above check, _extends_property_id is always int
        assert self._extends_property_id is not None
        return self._extends_property_id
    
    async def get_extended_classes(self, class_node_id: int) -> List[int]:
        """Get the list of class IDs that this class extends (direct only).
        
        Returns class IDs in the order they are defined.
        """
        extends_prop_id = await self._get_extends_property_id()
        
        async with self._pool.acquire() as conn:
            # Get the extends property values for this class
            rows = await conn.fetch("""
                SELECT pvr.target_id
                FROM node_property np
                JOIN property_value_relation pvr ON pvr.node_property_id = np.id
                WHERE np.node_id = $1 AND np.property_id = $2
                ORDER BY pvr.id
            """, class_node_id, extends_prop_id)
            
            return [row['target_id'] for row in rows]
    
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
            async with self._pool.acquire() as conn:
                class_row = await conn.fetchrow(
                    "SELECT name FROM node WHERE id = $1 AND graph_id = $2",
                    extended_class_id, self._graph_id
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
        # Temporarily simulate the new extends relationships
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
        extends_prop_id = await self._get_extends_property_id()
        
        async with self._pool.acquire() as conn:
            # Find all classes that reference this class in their extends property
            rows = await conn.fetch("""
                SELECT DISTINCT n.id, n.uuid, n.name, n.icon
                FROM node n
                JOIN node_property np ON np.node_id = n.id
                JOIN property_value_relation pvr ON pvr.node_property_id = np.id
                WHERE pvr.target_id = $1 
                  AND np.property_id = $2
                  AND n.graph_id = $3
                  AND n.active = TRUE
                  AND n.is_class = TRUE
                ORDER BY n.name
            """, class_node_id, extends_prop_id, self._graph_id)
            
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
        extends_prop_id = await self._get_extends_property_id()
        result = []
        
        async with self._pool.acquire() as conn:
            # Get direct subclasses
            rows = await conn.fetch("""
                SELECT DISTINCT n.id
                FROM node n
                JOIN node_property np ON np.node_id = n.id
                JOIN property_value_relation pvr ON pvr.node_property_id = np.id
                WHERE pvr.target_id = $1 
                  AND np.property_id = $2
                  AND n.graph_id = $3
                  AND n.active = TRUE
                  AND n.is_class = TRUE
            """, class_node_id, extends_prop_id, self._graph_id)
            
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
