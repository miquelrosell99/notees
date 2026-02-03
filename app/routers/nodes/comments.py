"""Comments endpoints for nodes.

Comments are child nodes with is_comment=true, stored directly under the target node.
"""
from fastapi import APIRouter, HTTPException, Depends

from ...domain.entities import NodeCreateData
from ..auth import get_current_user
from ...models import User
from ...db.schema.constants import SYSTEM_CLASS_UUIDS
from .models import CommentCreateRequest, CommentsResponse
from .helpers import _get_node_service, _node_to_comment_response


router = APIRouter()


@router.get("/{node_id}/comments")
async def get_comments(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all comments for a node.
    
    Comments are child nodes with is_comment=true.
    """
    service = await _get_node_service(user)
    
    # Verify node exists
    node = await service._node_repo.get_by_id(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    
    # Get comment child nodes for this node
    pool = service._node_repo.get_connection()
    rows = await pool.fetch("""
        SELECT id FROM node
        WHERE parent_id = $1 AND is_comment = TRUE AND active = TRUE
              AND (is_deleted = FALSE OR is_deleted IS NULL)
        ORDER BY sequence, create_date
    """, node_id)
    
    comments = []
    for row in rows:
        comment_node = await service._node_repo.get_by_id(row['id'])
        if comment_node and comment_node.id is not None:
            # Get children of comment node (nested replies)
            children = await service._node_repo.get_children(comment_node.id)
            comments.append(_node_to_comment_response(comment_node, children))
    
    return CommentsResponse(comments=comments, comment_count=len(comments))


@router.post("/{node_id}/comments")
async def create_comment(
    node_id: int,
    request: CommentCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create a new comment on a node.
    
    Creates a child node with is_comment=true under the target node.
    """
    service = await _get_node_service(user)
    
    # Verify target node exists
    target_node = await service._node_repo.get_by_id(node_id)
    if not target_node:
        raise HTTPException(404, "Node not found")
    
    # Get the Comment class
    comment_class = await service._node_repo.get_by_uuid(SYSTEM_CLASS_UUIDS["comment"])
    if not comment_class:
        raise HTTPException(500, "Comment class not found")
    
    # Get the next sequence number for comments
    pool = service._node_repo.get_connection()
    seq_row = await pool.fetchrow("""
        SELECT COALESCE(MAX(sequence), -1) + 1 as next_seq
        FROM node WHERE parent_id = $1 AND is_comment = TRUE AND active = TRUE
              AND (is_deleted = FALSE OR is_deleted IS NULL)
    """, node_id)
    next_seq = seq_row['next_seq'] if seq_row else 0
    
    # Create the comment node as a child of target node with Comment class
    data = NodeCreateData(
        name=request.name,
        parent_id=node_id,
        classes=[comment_class.id],
        sequence=next_seq,
    )
    
    comment_node = await service.create_node(data, user_id=None)
    
    if not comment_node.id:
        raise HTTPException(500, "Failed to create comment node")
    
    return _node_to_comment_response(comment_node)


@router.delete("/{node_id}/comments/{comment_id}")
async def delete_comment(
    node_id: int,
    comment_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a comment from a node.
    
    Verifies the comment belongs to the node and deletes it.
    """
    service = await _get_node_service(user)
    
    # Verify the comment exists and belongs to this node
    comment_node = await service._node_repo.get_by_id(comment_id)
    if not comment_node:
        raise HTTPException(404, "Comment not found")
    
    if comment_node.parent_id != node_id or not comment_node.is_comment:
        raise HTTPException(404, "Comment not found for this node")
    
    # Delete the comment node (and children via cascade)
    await service.delete_node(comment_id)
    
    return {"status": "ok"}


@router.get("/{node_id}/comment-count")
async def get_comment_count(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get the count of comments for a node.
    
    Useful for showing comment indicators without loading all comments.
    """
    service = await _get_node_service(user)
    
    pool = service._node_repo.get_connection()
    row = await pool.fetchrow("""
        SELECT COUNT(*) as count FROM node 
        WHERE parent_id = $1 AND is_comment = TRUE AND active = TRUE
              AND (is_deleted = FALSE OR is_deleted IS NULL)
    """, node_id)
    
    return {"count": row['count'] if row else 0}
