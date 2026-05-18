#!/usr/bin/env python3
"""Extract endpoints from nodes/crud.py into separate files."""
import os
import re

CRUD_PATH = os.path.join(os.path.dirname(__file__), '..', 'app', 'routers', 'nodes', 'crud.py')
NODES_DIR = os.path.join(os.path.dirname(__file__), '..', 'app', 'routers', 'nodes')

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

crud = read_file(CRUD_PATH)

# Common header for all new files
COMMON_HEADER = '''"""{description}"""
from typing import Optional, List, Dict

from fastapi import APIRouter, HTTPException, Depends, Path, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from ...logging_config import get_logger
logger = get_logger(__name__)

from ...domain.entities import NodeCreateData, NodeUpdateData
from ...domain.errors import DatePageDeletionError, OptimisticLockError, DuplicateNodeError, SystemClassConstraintError
from ..auth import get_current_user
from ...models import User
from .models import (
    NodeResponse,
    NodeCreateRequest,
    NodeUpdateRequest,
    BatchNodeCreateRequest,
    BatchNodeCreateResponse,
    BatchNodeCreateResultItem,
    BatchNodeUpdateRequest,
    BatchNodeUpdateResponse,
    BatchNodeUpdateResultItem,
    BatchNodeDeleteRequest,
    BatchNodeDeleteResponse,
    BatchNodeDeleteResultItem,
    BatchPermanentDeleteRequest,
    BatchPermanentDeleteResponse,
    BatchPermanentDeleteResultItem,
    BatchGetNodesRequest,
    BatchGetNodesResponse,
)
from .helpers import (
    _get_node_service,
    _get_undo_service,
    _node_snapshot,
    _node_to_response,
    _get_class_ids,
    _get_tag_ids,
    _get_class_ids_batch,
    _get_alias_ids,
    _get_related_ids_batch,
    extract_properties_dict,
    _resolve_referenced_display_names,
    _name_text,
    _apply_node_extras,
)

limiter = Limiter(key_func=get_remote_address)
router = APIRouter()

'''

# Extract batch endpoints
batch_pattern = r'(def _bulk_import_cost.*?\n\n)?(@router\.post\("/batch".*?\n    return BatchNodeCreateResponse.*?\n\n)(@router\.put\("/batch".*?\n    return BatchNodeUpdateResponse.*?\n\n)(@router\.delete\("/batch".*?\n    return BatchNodeDeleteResponse.*?\n\n)'
match = re.search(batch_pattern, crud, re.DOTALL)
if match:
    batch_code = ''.join(filter(None, match.groups()))
    crud = crud[:match.start()] + crud[match.end():]
else:
    batch_code = ''
    print("WARNING: Could not extract batch endpoints")

# Extract batch-get endpoint
batch_get_pattern = r'(@router\.post\("/batch-get".*?\n    return BatchGetNodesResponse.*?\n\n)'
match = re.search(batch_get_pattern, crud, re.DOTALL)
if match:
    batch_code += match.group(1)
    crud = crud[:match.start()] + crud[match.end():]
else:
    print("WARNING: Could not extract batch-get endpoint")

if batch_code:
    write_file(os.path.join(NODES_DIR, 'batch.py'), COMMON_HEADER.format(description="Batch operations for nodes.") + batch_code)
    print("Created batch.py")

# Extract trash endpoints
trash_patterns = [
    r'(@router\.get\("/trash".*?\n    return \{.*?\n\n)',
    r'(@router\.post\("/trash/empty".*?\n    return \{.*?\n\n)',
    r'(@router\.post\("/trash/batch-delete".*?\n    return BatchPermanentDeleteResponse.*?\n\n)',
    r'(@router\.post\("/\{node_id\}/restore".*?\n    return NodeResponse.*?\n\n)',
    r'(@router\.delete\("/\{node_id\}/permanent".*?\n    return \{.*?\n\n)',
]

trash_code = ''
for pattern in trash_patterns:
    match = re.search(pattern, crud, re.DOTALL)
    if match:
        trash_code += match.group(1)
        crud = crud[:match.start()] + crud[match.end():]

if trash_code:
    write_file(os.path.join(NODES_DIR, 'trash.py'), COMMON_HEADER.format(description="Trash operations for nodes.") + trash_code)
    print("Created trash.py")

# Extract template endpoints
template_patterns = [
    r'(@router\.get\("/templates".*?\n    return \[.*?\n\n)',
    r'(@router\.get\("/\{node_id\}/template-variables".*?\n    return TemplateVariablesResponse.*?\n\n)',
    r'(@router\.post\("/\{node_id\}/instantiate".*?\n    return TemplateInstantiateResponse.*?\n\n)',
]

template_code = ''
for pattern in template_patterns:
    match = re.search(pattern, crud, re.DOTALL)
    if match:
        template_code += match.group(1)
        crud = crud[:match.start()] + crud[match.end():]

if template_code:
    write_file(os.path.join(NODES_DIR, 'templates.py'), COMMON_HEADER.format(description="Template operations for nodes.") + template_code)
    print("Created templates.py")

# Extract version endpoints
version_patterns = [
    r'(@router\.get\("/\{node_id\}/versions".*?\n    return \[.*?\n\n)',
    r'(@router\.get\("/\{node_id\}/versions/\{version_id\}".*?\n    return \{.*?\n\n)',
    r'(@router\.post\("/\{node_id\}/versions/\{version_id\}/restore".*?\n    return NodeResponse.*?\n\n)',
]

version_code = ''
for pattern in version_patterns:
    match = re.search(pattern, crud, re.DOTALL)
    if match:
        version_code += match.group(1)
        crud = crud[:match.start()] + crud[match.end():]

if version_code:
    write_file(os.path.join(NODES_DIR, 'versions.py'), COMMON_HEADER.format(description="Version history operations for nodes.") + version_code)
    print("Created versions.py")

# Update crud.py
write_file(CRUD_PATH, crud)
print("Updated crud.py")
