import psycopg2
from psycopg2.extras import RealDictCursor

conn = psycopg2.connect(
    host='localhost',
    port=5432,
    database='notees',
    user='notees',
    password='notees'
)
cur = conn.cursor(cursor_factory=RealDictCursor)

# Check property 45
cur.execute('SELECT * FROM property WHERE id = 45')
row = cur.fetchone()
if row:
    print('Property 45:', dict(row))
else:
    print('Property 45 NOT FOUND')

# Check all properties
cur.execute('SELECT id, name, is_local, node_id, active, graph_id FROM property ORDER BY id')
rows = cur.fetchall()
print(f'\nAll properties ({len(rows)}):')
for row in rows:
    print(dict(row))

# Check what properties are assigned to node 460
cur.execute('SELECT np.*, p.name FROM node_property np JOIN property p ON np.property_id = p.id WHERE np.node_id = 460')
rows = cur.fetchall()
print(f'\nProperties assigned to node 460 ({len(rows)}):')
for row in rows:
    print(dict(row))

# Check scalar values for node 460
cur.execute('SELECT * FROM property_value_scalar WHERE node_id = 460')
rows = cur.fetchall()
print(f'\nScalar values for node 460 ({len(rows)}):')
for row in rows:
    print(dict(row))

conn.close()
