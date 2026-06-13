"""Comments endpoints for nodes.

Comments are child nodes with is_comment=true, stored directly under the target node.
"""

from fastapi import APIRouter, Depends, HTTPException, Query

from ...db.schema.constants import SYSTEM_CLASS_UUIDS
from ...dependencies import get_current_user, get_node_repository
from ...domain.entities import NodeCreateData
from ...domain.repositories.interfaces import NodeRepository
from ...models import PaginatedResponse, User
from .helpers import _build_children_response, _get_class_ids_batch, _get_node_service, _node_to_response
from .models import CommentCreateRequest, NodeResponse

router = APIRouter()


@router.get("/{node_id}/comments")
async def get_comments(
    node_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get all comments for a node.

    Comments are child nodes with is_comment=true.
    """
    service = await _get_node_service(user)

    # Verify node exists
    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")

    # Check permissions (can_read or can_comment)
    perms = await service.permissions.get_node_permissions(node_id)
    if not (perms.can_read or perms.can_comment):
        raise HTTPException(403, "Not allowed to view comments")

    # Get comment child nodes for this node (paginated top-level only)
    total, comment_ids = await repo.get_comment_ids_paginated(node_id, page, page_size)

    if not comment_ids:
        return PaginatedResponse[NodeResponse](
            items=[], total=total, page=page, page_size=page_size, has_next=False, has_prev=page > 1
        )

    # Fetch comment nodes and their children for the paginated subset
    all_nodes = []
    for cid in comment_ids:
        comment_node = await service.get_node(cid)
        if comment_node and comment_node.id is not None:
            all_nodes.append(comment_node)
            children = await service.get_node_children(comment_node.id)
            if children:
                all_nodes.extend(children)

    # Batch-fetch class IDs for all nodes
    all_ids = [n.id for n in all_nodes if n.id]
    class_ids_map = await _get_class_ids_batch(service, all_ids) if all_ids else {}

    # Build top-level comment responses with nested children
    comments = []
    for cid in comment_ids:
        comment_node = await service.get_node(cid)
        if comment_node and comment_node.id is not None:
            children = await service.get_node_children(comment_node.id)
            classes = class_ids_map.get(comment_node.id, [])
            resp = _node_to_response(comment_node, classes=classes)
            resp.children = _build_children_response(children, class_ids_map) if children else []
            comments.append(resp)

    return PaginatedResponse[NodeResponse](
        items=comments,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


@router.post("/{node_id}/comments")
async def create_comment(
    node_id: int,
    request: CommentCreateRequest,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Create a new comment on a node.

    Creates a child node with is_comment=true under the target node.
    """
    service = await _get_node_service(user)

    # Verify target node exists
    target_node = await service.get_node(node_id)
    if not target_node:
        raise HTTPException(404, "Node not found")

    # Check permissions (can_comment or can_write)
    perms = await service.permissions.get_node_permissions(node_id)
    if not (perms.can_comment or perms.can_write):
        raise HTTPException(403, "Not allowed to create comments")

    # Get the Comment class
    comment_class = await service.get_node_by_uuid(SYSTEM_CLASS_UUIDS["comment"])
    if not comment_class:
        raise HTTPException(500, "Comment class not found")

    # Determine the actual parent (target node or parent comment for replies)
    actual_parent_id = node_id
    if request.parent_comment_id:
        parent_comment = await service.get_node(request.parent_comment_id)
        if not parent_comment or not parent_comment.is_comment:
            raise HTTPException(404, "Parent comment not found")
        actual_parent_id = request.parent_comment_id

    # Get the next sequence number for comments under the parent
    next_seq = await repo.get_next_comment_sequence(actual_parent_id)

    # Create the comment node as a child with Comment class
    data = NodeCreateData(
        name=request.name,
        parent_id=actual_parent_id,
        classes=[comment_class.id],
        sequence=next_seq,
    )

    comment_node = await service.create_node(data, user_id=None)

    if not comment_node.id:
        raise HTTPException(500, "Failed to create comment node")

    classes = await _get_class_ids_batch(service, [comment_node.id])
    return _node_to_response(comment_node, classes=classes.get(comment_node.id, []))


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
    comment_node = await service.get_node(comment_id)
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
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get the count of comments for a node.

    Useful for showing comment indicators without loading all comments.
    """
    count = await repo.get_comment_count(node_id)
    return {"count": count}
