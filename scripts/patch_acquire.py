"""Patch all repository and router files to use acquire_connection instead of pool.acquire()."""
import re
import os

REPO_FILES = [
    'app/domain/repositories/postgres_node.py',
    'app/domain/repositories/postgres_node_view.py',
    'app/domain/repositories/postgres_property.py',
    'app/domain/repositories/postgres_link.py',
    'app/domain/repositories/postgres_user.py',
]

SERVICE_FILES = [
    'app/domain/services/node_service.py',
    'app/domain/services/query_service.py',
    'app/domain/services/class_extension_service.py',
]

ROUTER_FILES = [
    'app/routers/sync.py',
    'app/routers/nodes/settings.py',
    'app/routers/nodes/search.py',
    'app/routers/nodes/links.py',
    'app/routers/nodes/helpers.py',
    'app/routers/nodes/favorites.py',
    'app/routers/nodes/daily.py',
    'app/routers/nodes/crud.py',
    'app/routers/nodes/classes.py',
    'app/routers/properties/helpers.py',
    'app/routers/properties/crud.py',
    'app/routers/properties/classes.py',
    'app/routers/assets.py',
    'app/routers/activity.py',
]

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

for fp in REPO_FILES + SERVICE_FILES + ROUTER_FILES:
    if not os.path.exists(fp):
        print(f'SKIP: {fp}')
        continue
    
    with open(fp, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original = content
    
    # Replace self._pool.acquire() -> acquire_connection(self._pool)
    content = content.replace('self._pool.acquire()', 'acquire_connection(self._pool)')
    
    # Replace service._pool.acquire() -> acquire_connection(service._pool)
    content = content.replace('service._pool.acquire()', 'acquire_connection(service._pool)')
    
    # Replace standalone pool.acquire() -> acquire_connection(pool) 
    # Use regex to avoid matching self._pool or service._pool (already handled above)
    content = re.sub(
        r'(?<!\w\.)pool\.acquire\(\)',
        'acquire_connection(pool)',
        content
    )
    
    if content != original:
        # Add import for acquire_connection
        if 'acquire_connection' not in original:
            if fp in REPO_FILES:
                # Repos use relative imports from ...db.connection
                if 'from ...db.connection' in content:
                    # There's already an import from db.connection, extend it
                    content = re.sub(
                        r'from \.\.\.db\.connection import ([^\n]+)',
                        r'from ...db.connection import acquire_connection, \1',
                        content,
                        count=1,
                    )
                else:
                    # Add a new import after the last import
                    lines = content.split('\n')
                    last_import = 0
                    for i, line in enumerate(lines):
                        if line.startswith('import ') or line.startswith('from '):
                            last_import = i
                    lines.insert(last_import + 1, 'from ...db.connection import acquire_connection')
                    content = '\n'.join(lines)
            else:
                # Router files
                if 'from ...db.connection import' in content:
                    content = re.sub(
                        r'from \.\.\.db\.connection import ([^\n]+)',
                        r'from ...db.connection import acquire_connection, \1',
                        content,
                        count=1,
                    )
                elif 'from ..db.connection import' in content:
                    content = re.sub(
                        r'from \.\.db\.connection import ([^\n]+)',
                        r'from ..db.connection import acquire_connection, \1',
                        content,
                        count=1,
                    )
                else:
                    lines = content.split('\n')
                    last_import = 0
                    for i, line in enumerate(lines):
                        if line.startswith('import ') or line.startswith('from '):
                            last_import = i
                    # Determine the relative import depth
                    depth = fp.count('/') - 1  # app/routers/nodes/x.py -> depth 3 -> ...
                    dots = '.' * depth
                    lines.insert(last_import + 1, f'from {dots}db.connection import acquire_connection')
                    content = '\n'.join(lines)
        
        with open(fp, 'w', encoding='utf-8') as f:
            f.write(content)
        
        calls = content.count('acquire_connection(')
        print(f'PATCHED: {fp} ({calls} acquire_connection calls)')
    else:
        print(f'NO CHANGE: {fp}')
