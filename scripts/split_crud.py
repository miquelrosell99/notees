#!/usr/bin/env python3
"""Extract batch and trash endpoints from nodes/crud.py into separate files."""
import os
import re

CRUD_PATH = os.path.join(os.path.dirname(__file__), '..', 'app', 'routers', 'nodes', 'crud.py')
BATCH_PATH = os.path.join(os.path.dirname(__file__), '..', 'app', 'routers', 'nodes', 'batch.py')
TRASH_PATH = os.path.join(os.path.dirname(__file__), '..', 'app', 'routers', 'nodes', 'trash.py')

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

# Read crud.py
crud = read_file(CRUD_PATH)

# Extract batch endpoints (batch create, update, delete)
batch_pattern = r'(@router\.post\("/batch".*?^@router\.delete\("/batch".*?\n    return BatchNodeDeleteResponse.*?\n\n))'
match = re.search(batch_pattern, crud, re.DOTALL | re.MULTILINE)
if not match:
    print("Could not find batch endpoints")
    exit(1)

batch_code = match.group(1)
remaining_crud = crud[:match.start()] + crud[match.end():]

# Extract batch-get endpoint
batch_get_pattern = r'(@router\.post\("/batch-get".*?^    return BatchGetNodesResponse.*?\n\n))'
match2 = re.search(batch_get_pattern, remaining_crud, re.DOTALL | re.MULTILINE)
if match2:
    batch_code += '\n' + match2.group(1)
    remaining_crud = remaining_crud[:match2.start()] + remaining_crud[match2.end():]

# Extract trash endpoints
trash_patterns = [
    r'(@router\.get\("/trash".*?^    return \{.*?\n\n))',
    r'(@router\.post\("/trash/empty".*?^    return \{.*?\n\n))',
    r'(@router\.post\("/trash/batch-delete".*?^    return BatchPermanentDeleteResponse.*?\n\n))',
    r'(@router\.post\("/\{node_id\}/restore".*?^    return NodeResponse.*?\n\n))',
    r'(@router\.delete\("/\{node_id\}/permanent".*?^    return \{.*?\n\n))',
]

trash_code = ''
for pattern in trash_patterns:
    match = re.search(pattern, remaining_crud, re.DOTALL | re.MULTILINE)
    if match:
        trash_code += match.group(1)
        remaining_crud = remaining_crud[:match.start()] + remaining_crud[match.end():]

# Create batch.py
batch_header = '''"""Batch operations for nodes."""
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from ...logging_config import get_logger
logger = get_logger(__name__)

from ...domain.entities import NodeCreateData, NodeUpdateData
from ..auth import get_current_user
from ...models import User
from .models import (
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
    _node_to_response,
    _apply_node_extras,
)

limiter = Limiter(key_func=get_remote_address)
router = APIRouter()


def _bulk_import_cost(request):
    """Cost function for bulk import rate limiting."""
    try:
        body = request.scope.get("_cached_body") or b""
        if not body:
            return 1
        import json
        data = json.loads(body)
        nodes = data.get("nodes", [])
        return max(1, len(nodes))
    except Exception:
        return 1


'''

write_file(BATCH_PATH, batch_header + batch_code)
print(f'Created {BATCH_PATH}')

# Create trash.py
trash_header = '''"""Trash operations for nodes."""
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from ...logging_config import get_logger
logger = get_logger(__name__)

from ..auth import get_current_user
from ...models import User
from .models import NodeResponse
from .helpers import (
    _get_node_service,
    _node_to_response,
)

limiter = Limiter(key_func=get_remote_address)
router = APIRouter()


'''

write_file(TRASH_PATH, trash_header + trash_code)
print(f'Created {TRASH_PATH}')

# Update crud.py
write_file(CRUD_PATH, remaining_crud)
print(f'Updated {CRUD_PATH}')
