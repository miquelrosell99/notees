import requests
import json

# Login
login_resp = requests.post('http://localhost:8000/api/auth/login', json={
    'username': 'admin',
    'password': 'admin'
})
print(f"Login response: {login_resp.status_code}")
print(f"Login data: {login_resp.json()}")
token = login_resp.json()['access_token']
headers = {'Authorization': f'Bearer {token}'}

# Get views for node 124
views_resp = requests.get('http://localhost:8000/api/nodes/views?node_id=124', headers=headers)
views = views_resp.json()

print(f"Views for node 124 (count={len(views)}):\n")
for v in views:
    print(f"  ID={v['id']}, type={v['view_type']}, name={v['name']}, default={v['is_default']}")
    if v.get('query_ast'):
        print(f"    AST: {json.dumps(v['query_ast'], indent=6)}")
    print()
