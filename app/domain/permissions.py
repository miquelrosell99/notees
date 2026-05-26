"""Permission checking for workspace and node access.

This module provides permission checking logic based on:
1. Ownership (create_uid field)
2. Workspace-level sharing (workspace_share table)
3. Node-level sharing (node_share table)

Permission Flags:
- can_read: Can view the resource
- can_write: Can modify the resource
- can_create: Can create children/related resources
- can_delete: Can delete the resource
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, List, TYPE_CHECKING

import asyncpg

from ..db.connection import acquire_connection
from ..domain.errors import PermissionDeniedError

if TYPE_CHECKING:
    pass


@dataclass
class Permissions:
    """Permission flags for a resource."""
    can_read: bool = False
    can_write: bool = False
    can_create: bool = False
    can_delete: bool = False
    
    @property
    def has_any(self) -> bool:
        """Check if any permission is granted."""
        return self.can_read or self.can_write or self.can_create or self.can_delete
    
    @classmethod
    def owner(cls) -> 'Permissions':
        """Return full permissions (for owners)."""
        return cls(can_read=True, can_write=True, can_create=True, can_delete=True)
    
    @classmethod
    def none(cls) -> 'Permissions':
        """Return no permissions."""
        return cls()
    
    @classmethod
    def read_only(cls) -> 'Permissions':
        """Return read-only permissions."""
        return cls(can_read=True)
    
    def merge(self, other: 'Permissions') -> 'Permissions':
        """Merge with another permission set (OR operation)."""
        return Permissions(
            can_read=self.can_read or other.can_read,
            can_write=self.can_write or other.can_write,
            can_create=self.can_create or other.can_create,
            can_delete=self.can_delete or other.can_delete,
        )


class PermissionChecker:
    """Checks permissions for workspaces and nodes.
    
    Permission resolution order:
    1. If user is the owner (create_uid), they have full permissions
    2. Check workspace_share for workspace-level permissions
    3. Check node_share for node-level permissions (can override workspace)
    """
    
    def __init__(self, pool: asyncpg.Pool, user_id: int):
        """Initialize with connection pool and current user.
        
        Args:
            pool: asyncpg connection pool
            user_id: Current authenticated user ID
        """
        self._pool = pool
        self._user_id = user_id
        # Cache for workspace permissions
        self._workspace_cache: dict[int, Permissions] = {}
        # Cache for node permissions
        self._node_cache: dict[int, Permissions] = {}
    
    def clear_cache(self) -> None:
        """Clear permission caches."""
        self._workspace_cache.clear()
        self._node_cache.clear()
    
    async def get_workspace_permissions(self, workspace_id: int) -> Permissions:
        """Get permissions for a workspace.
        
        Returns full permissions if user is owner, otherwise checks workspace_share.
        """
        # Check cache
        if workspace_id in self._workspace_cache:
            return self._workspace_cache[workspace_id]
        
        async with acquire_connection(self._pool) as conn:
            # Check if user is owner
            row = await conn.fetchrow("""
                SELECT create_uid FROM workspace 
                WHERE id = $1 AND active = TRUE
            """, workspace_id)
            
            if not row:
                # Workspace doesn't exist or is inactive
                perms = Permissions.none()
            elif row['create_uid'] == self._user_id:
                # User is owner
                perms = Permissions.owner()
            else:
                # Check workspace_share
                share_row = await conn.fetchrow("""
                    SELECT can_read, can_write, can_create, can_delete
                    FROM workspace_share
                    WHERE workspace_id = $1 AND user_id = $2 AND active = TRUE
                """, workspace_id, self._user_id)
                
                if share_row:
                    perms = Permissions(
                        can_read=share_row['can_read'],
                        can_write=share_row['can_write'],
                        can_create=share_row['can_create'],
                        can_delete=share_row['can_delete'],
                    )
                else:
                    perms = Permissions.none()
        
        self._workspace_cache[workspace_id] = perms
        return perms
    
    async def get_node_permissions(self, node_id: int) -> Permissions:
        """Get permissions for a node.
        
        Resolution order:
        1. If user is node owner (create_uid), full permissions
        2. Check node_share for explicit permissions
        3. Fall back to workspace permissions
        """
        return await self._get_node_permissions_impl(node_id, active_only=True)
    
    async def get_node_permissions_for_delete(self, node_id: int) -> Permissions:
        """Get permissions for deleting a node (works on archived nodes too)."""
        return await self._get_node_permissions_impl(node_id, active_only=False)
    
    async def _get_node_permissions_impl(self, node_id: int, active_only: bool = True) -> Permissions:
        """Internal implementation of get_node_permissions.
        
        Args:
            node_id: The node to check permissions for
            active_only: If True, only check active nodes. If False, include archived.
        """
        # Check cache (only for active_only=True to avoid stale cache issues)
        if active_only and node_id in self._node_cache:
            return self._node_cache[node_id]
        
        async with acquire_connection(self._pool) as conn:
            # Get node info including workspace_id and create_uid
            if active_only:
                row = await conn.fetchrow("""
                    SELECT workspace_id, create_uid, is_shared FROM node 
                    WHERE id = $1 AND active = TRUE
                """, node_id)
            else:
                row = await conn.fetchrow("""
                    SELECT workspace_id, create_uid, is_shared FROM node 
                    WHERE id = $1
                """, node_id)
            
            if not row:
                # Node doesn't exist or is inactive
                perms = Permissions.none()
                if active_only:
                    self._node_cache[node_id] = perms
                return perms
            
            workspace_id = row['workspace_id']
            
            # Check if user is node owner
            if row['create_uid'] == self._user_id:
                perms = Permissions.owner()
                if active_only:
                    self._node_cache[node_id] = perms
                return perms
            
            # Check node_share for explicit permissions on this node
            share_row = await conn.fetchrow("""
                SELECT can_read, can_write, can_create, can_delete
                FROM node_share
                WHERE node_id = $1 AND user_id = $2 AND active = TRUE
            """, node_id, self._user_id)
            
            if share_row:
                perms = Permissions(
                    can_read=share_row['can_read'],
                    can_write=share_row['can_write'],
                    can_create=share_row['can_create'],
                    can_delete=share_row['can_delete'],
                )
                self._node_cache[node_id] = perms
                return perms
            
            # Check ancestor page shares — child blocks inherit permissions
            # from their closest parent page that has an explicit share
            ancestor_share_row = await conn.fetchrow("""
                SELECT ns.can_read, ns.can_write, ns.can_create, ns.can_delete
                FROM node_path np
                JOIN node n ON n.id = np.ancestor_id
                JOIN node_share ns ON ns.node_id = n.id
                WHERE np.descendant_id = $1
                  AND np.depth > 0
                  AND n.is_page = TRUE
                  AND ns.user_id = $2
                  AND ns.active = TRUE
                ORDER BY np.depth ASC
                LIMIT 1
            """, node_id, self._user_id)
            
            if ancestor_share_row:
                perms = Permissions(
                    can_read=ancestor_share_row['can_read'],
                    can_write=ancestor_share_row['can_write'],
                    can_create=ancestor_share_row['can_create'],
                    can_delete=ancestor_share_row['can_delete'],
                )
                self._node_cache[node_id] = perms
                return perms
            
            # Fall back to workspace permissions
            perms = await self.get_workspace_permissions(workspace_id)
        
        if active_only:
            self._node_cache[node_id] = perms
        return perms
    
    async def can_read_workspace(self, workspace_id: int) -> bool:
        """Check if user can read a workspace."""
        perms = await self.get_workspace_permissions(workspace_id)
        return perms.can_read
    
    async def can_write_workspace(self, workspace_id: int) -> bool:
        """Check if user can write to a workspace."""
        perms = await self.get_workspace_permissions(workspace_id)
        return perms.can_write
    
    async def can_create_in_workspace(self, workspace_id: int) -> bool:
        """Check if user can create in a workspace."""
        perms = await self.get_workspace_permissions(workspace_id)
        return perms.can_create
    
    async def can_delete_workspace(self, workspace_id: int) -> bool:
        """Check if user can delete a workspace."""
        perms = await self.get_workspace_permissions(workspace_id)
        return perms.can_delete
    
    async def can_read_node(self, node_id: int) -> bool:
        """Check if user can read a node."""
        perms = await self.get_node_permissions(node_id)
        return perms.can_read
    
    async def can_write_node(self, node_id: int) -> bool:
        """Check if user can write to a node."""
        perms = await self.get_node_permissions(node_id)
        return perms.can_write
    
    async def can_create_in_node(self, node_id: int) -> bool:
        """Check if user can create children in a node."""
        perms = await self.get_node_permissions(node_id)
        return perms.can_create
    
    async def can_delete_node(self, node_id: int) -> bool:
        """Check if user can delete a node."""
        perms = await self.get_node_permissions(node_id)
        return perms.can_delete
    
    async def can_delete_node_including_archived(self, node_id: int) -> bool:
        """Check if user can delete a node (including archived nodes)."""
        perms = await self.get_node_permissions_for_delete(node_id)
        return perms.can_delete
    
    async def get_accessible_workspace_ids(self) -> List[int]:
        """Get all workspace IDs the user can access (read).
        
        Returns workspaces owned by the user plus workspaces shared with them.
        """
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT DISTINCT id FROM (
                    -- Workspaces owned by user
                    SELECT id FROM workspace WHERE create_uid = $1 AND active = TRUE
                    UNION
                    -- Workspaces shared with user (with read permission)
                    SELECT g.id FROM workspace g
                    JOIN workspace_share gs ON g.id = gs.workspace_id
                    WHERE gs.user_id = $1 AND gs.can_read = TRUE AND gs.active = TRUE AND g.active = TRUE
                ) AS accessible_workspaces
                ORDER BY id
            """, self._user_id)
            return [row['id'] for row in rows]
    
    async def require_workspace_read(self, workspace_id: int) -> None:
        """Require read permission on a workspace, raise if not allowed."""
        if not await self.can_read_workspace(workspace_id):
            raise PermissionDeniedError(f"User {self._user_id} cannot read workspace {workspace_id}")
    
    async def require_workspace_write(self, workspace_id: int) -> None:
        """Require write permission on a workspace, raise if not allowed."""
        if not await self.can_write_workspace(workspace_id):
            raise PermissionDeniedError(f"User {self._user_id} cannot write to workspace {workspace_id}")
    
    async def require_workspace_create(self, workspace_id: int) -> None:
        """Require create permission on a workspace, raise if not allowed."""
        if not await self.can_create_in_workspace(workspace_id):
            raise PermissionDeniedError(f"User {self._user_id} cannot create in workspace {workspace_id}")
    
    async def require_workspace_delete(self, workspace_id: int) -> None:
        """Require delete permission on a workspace, raise if not allowed."""
        if not await self.can_delete_workspace(workspace_id):
            raise PermissionDeniedError(f"User {self._user_id} cannot delete workspace {workspace_id}")
    
    async def require_node_read(self, node_id: int) -> None:
        """Require read permission on a node, raise if not allowed."""
        if not await self.can_read_node(node_id):
            raise PermissionDeniedError(f"User {self._user_id} cannot read node {node_id}")
    
    async def require_node_write(self, node_id: int) -> None:
        """Require write permission on a node, raise if not allowed."""
        if not await self.can_write_node(node_id):
            raise PermissionDeniedError(f"User {self._user_id} cannot write to node {node_id}")
    
    async def require_node_create(self, node_id: int) -> None:
        """Require create permission on a node, raise if not allowed."""
        if not await self.can_create_in_node(node_id):
            raise PermissionDeniedError(f"User {self._user_id} cannot create in node {node_id}")
    
    async def require_node_delete(self, node_id: int) -> None:
        """Require delete permission on a node (works on archived nodes too)."""
        if not await self.can_delete_node_including_archived(node_id):
            raise PermissionDeniedError(f"User {self._user_id} cannot delete node {node_id}")


async def get_permission_checker(pool: asyncpg.Pool, user_id: int) -> PermissionChecker:
    """Factory function to create a permission checker.
    
    Args:
        pool: asyncpg connection pool
        user_id: Current authenticated user ID
        
    Returns:
        PermissionChecker instance
    """
    return PermissionChecker(pool, user_id)
