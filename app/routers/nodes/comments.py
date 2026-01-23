"""Comments endpoints for nodes."""
from fastapi import APIRouter, HTTPException, Depends

from ...domain.entities import NodeCreateData
from ...db.schema import utc_now_iso
from ..auth import get_current_user
from ...models import User
from .models import CommentCreateRequest, CommentsResponse
from .helpers import _get_node_service, _node_to_comment_response


router = APIRouter()


@router.get("/{node_id}/comments")
async def get_comments(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all comments for a node.
    
    Comments are stored as nodes tagged with 'comment' and linked via node_comment table.
    Each comment can have children (nested bullet points).
    """
    service = await _get_node_service(user)
    
    # Verify node exists
    node = await service._node_repo.get_by_id(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    
    # Get comment nodes for this node
    pool = service._node_repo.get_connection()
    rows = await pool.fetch("""
        SELECT nc.comment_node_id, nc.sequence
        FROM node_comment nc
        WHERE nc.node_id = $1
        ORDER BY nc.sequence, nc.create_date
    """, node_id)
    
    comments = []
    for row in rows:
        comment_node = await service._node_repo.get_by_id(row['comment_node_id'])
        if comment_node and comment_node.id is not None:
            # Get children of comment node
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
    
    Creates a new node typed as 'comment' and links it to the target node.
    Links in the comment content are parsed and tracked globally.
    """
    service = await _get_node_service(user)
    
    # Verify target node exists
    target_node = await service._node_repo.get_by_id(node_id)
    if not target_node:
        raise HTTPException(404, "Node not found")
    
    # Get the 'comment' type ID
    pool = service._node_repo.get_connection()
    row = await pool.fetchrow(
        "SELECT id FROM node WHERE name = 'comment' AND is_type = TRUE LIMIT 1"
    )
    
    if not row:
        raise HTTPException(500, "Comment type not found - database may need reinitialization")
    
    comment_type_id = row['id']
    
    # Create the comment node (typed as 'comment')
    # Comments are not pages - they are attached to other nodes
    data = NodeCreateData(
        name=request.name,
        types=[comment_type_id],
        is_comment=True,
    )
    
    comment_node = await service.create_node(data, user_id=None)
    
    if not comment_node.id:
        raise HTTPException(500, "Failed to create comment node")
    
    # Get the next sequence number
    seq_row = await pool.fetchrow("""
        SELECT COALESCE(MAX(sequence), -1) + 1 as next_seq
        FROM node_comment WHERE node_id = $1
    """, node_id)
    next_seq = seq_row['next_seq'] if seq_row else 0
    
    # Link the comment to the target node
    await pool.execute("""
        INSERT INTO node_comment (node_id, comment_node_id, sequence, create_date)
        VALUES ($1, $2, $3, $4)
    """, node_id, comment_node.id, next_seq, utc_now_iso())
    
    return _node_to_comment_response(comment_node)


@router.delete("/{node_id}/comments/{comment_id}")
async def delete_comment(
    node_id: int,
    comment_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a comment from a node.
    
    This removes the comment link and deletes the comment node and all its children.
    """
    service = await _get_node_service(user)
    
    # Verify the comment link exists
    pool = service._node_repo.get_connection()
    row = await pool.fetchrow("""
        SELECT id FROM node_comment 
        WHERE node_id = $1 AND comment_node_id = $2
    """, node_id, comment_id)
    
    if not row:
        raise HTTPException(404, "Comment not found for this node")
    
    # Remove the comment link
    await pool.execute("""
        DELETE FROM node_comment WHERE node_id = $1 AND comment_node_id = $2
    """, node_id, comment_id)
    
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
        SELECT COUNT(*) as count FROM node_comment WHERE node_id = $1
    """, node_id)
    
    return {"count": row['count'] if row else 0}
