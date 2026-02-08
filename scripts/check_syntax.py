"""Verify syntax of all patched files."""
import ast
import sys

files = [
    'app/db/connection.py',
    'app/domain/repositories/postgres_node.py',
    'app/domain/repositories/postgres_node_view.py',
    'app/domain/repositories/postgres_property.py',
    'app/domain/repositories/postgres_link.py',
    'app/domain/repositories/postgres_user.py',
    'app/domain/services/node_service.py',
    'app/domain/services/query_service.py',
    'app/domain/services/class_extension_service.py',
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
    'app/main.py',
]

errors = []
for fp in files:
    try:
        with open(fp, 'r', encoding='utf-8') as f:
            ast.parse(f.read())
        print(f'OK: {fp}')
    except SyntaxError as e:
        errors.append(f'{fp}: line {e.lineno}: {e.msg}')
        print(f'ERROR: {fp}: line {e.lineno}: {e.msg}')

if errors:
    print(f'\n{len(errors)} files with errors')
    sys.exit(1)
else:
    print(f'\nAll {len(files)} files OK')
