# Agent / CLI API

Notees exposes a machine-friendly REST API at `/api/agents/v1` for external programs — including AI agents such as Kimi Code running on another device — to read and write notes.

## Authentication

All requests must include a valid API key in the `X-API-Key` header.

```bash
curl -H "X-API-Key: nk_xxxxxxxxxxxxxxxx" \
  http://atlas:5173/api/agents/v1/workspaces
```

API keys are managed through the web UI or the existing `/api/auth/api-keys` endpoints. Keys can have scopes:

- `read` — read-only endpoints
- `write` — required for creating/updating nodes, setting properties, and appending notes

## Base URL

When accessing Notees via the dev frontend proxy:

```text
http://atlas:5173/api/agents/v1
```

Direct backend access:

```text
http://atlas:8001/api/agents/v1
```

## Rate limits

Agent endpoints are rate-limited to **60 requests per minute per user**.

## Endpoints

### Workspaces

#### `GET /workspaces`

List workspaces the authenticated user can access.

```json
[
  {
    "uuid": "3b30e070-039b-47bc-ad0d-2440a2f173c5",
    "name": "Notas",
    "role": "owner"
  }
]
```

#### `GET /workspaces/{workspace_uuid}`

Get details for a single workspace.

### Nodes

#### `GET /workspaces/{workspace_uuid}/nodes`

Search nodes by title or content.

Query parameters:

- `q` — search text
- `kind` — optional filter (`page`, `block`, etc.)
- `limit` — default `20`, max `100`

```bash
curl -H "X-API-Key: nk_xxx" \
  "http://atlas:5173/api/agents/v1/workspaces/3b30e070-039b-47bc-ad0d-2440a2f173c5/nodes?q=Implant&kind=page&limit=5"
```

Response:

```json
[
  {
    "id": "4dbe5616-cbf0-497f-85de-c3a8c237af3c",
    "kind": "page",
    "title": "Implant Protect (Clase IIb)",
    "created_at": "2026-07-20T18:16:52.830309+00:00",
    "updated_at": "2026-07-20T18:16:53.853677+00:00"
  }
]
```

#### `GET /workspaces/{workspace_uuid}/nodes/{node_uuid}`

Get full node details including content, properties, classes, parent, and children.

#### `GET /workspaces/{workspace_uuid}/nodes/{node_uuid}/references`

Get outgoing references and backlinks.

```json
{
  "references": [],
  "backlinks": [
    {
      "id": "06a5e80f-b0cf-7212-8000-a71315ef5be2",
      "source_id": "67ceb019-707f-49b7-87f3-536da1ae7437",
      "title": "pre-comercialización",
      "type": "reference"
    }
  ]
}
```

#### `GET /workspaces/{workspace_uuid}/nodes/{node_uuid}/activity`

Get activity log entries for a node, newest first.

Query parameters:

- `since` — ISO 8601 timestamp (optional)

### Writes

Write endpoints require an API key with the `write` scope.

#### `POST /workspaces/{workspace_uuid}/nodes`

Create a new node.

```json
{
  "kind": "page",
  "parent_id": null,
  "title": "Meeting notes",
  "class_ids": [],
  "initial_content": null
}
```

Response:

```json
{ "id": "06a5f228-8389-7ab5-8000-8c03921f1687" }
```

#### `PATCH /workspaces/{workspace_uuid}/nodes/{node_uuid}`

Update a node's title or content.

```json
{ "title": "Updated title" }
```

or

```json
{ "content": [{ "type": "paragraph", "children": [{ "text": "New content" }] }] }
```

#### `POST /workspaces/{workspace_uuid}/nodes/{node_uuid}/properties`

Set a property value.

```json
{
  "schema_id": "00000000-0000-0000-0001-000000000005",
  "value": "In progress"
}
```

#### `POST /workspaces/{workspace_uuid}/nodes/{node_uuid}/notes`

Append a child text block (note/comment) to a node.

```json
{ "text": "Follow up next week" }
```

Response:

```json
{ "id": "06a5f228-8389-7ab5-8000-8c03921f1687" }
```

## How it works

The agent API participates in the same local-first operation log as the web UI:

- Reads sync the workspace's derived SQLite state from the relay before querying.
- Writes emit operations (e.g. `node.create`, `update_content`) that are persisted to the encrypted relay and applied to the derived state.
- Changes made by an agent appear in the web UI after the next sync.

## Example: summarize recent updates for a project

```bash
WORKSPACE=3b30e070-039b-47bc-ad0d-2440a2f173c5
API_KEY=nk_xxxxxxxxxxxxxxxx

# 1. Find the project page
PAGE=$(curl -s -H "X-API-Key: $API_KEY" \
  "http://atlas:5173/api/agents/v1/workspaces/$WORKSPACE/nodes?q=Implant%20Protect&kind=page&limit=1" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

# 2. Read the page, its children, and references
curl -s -H "X-API-Key: $API_KEY" \
  "http://atlas:5173/api/agents/v1/workspaces/$WORKSPACE/nodes/$PAGE" | python3 -m json.tool

# 3. Get activity since a date
curl -s -H "X-API-Key: $API_KEY" \
  "http://atlas:5173/api/agents/v1/workspaces/$WORKSPACE/nodes/$PAGE/activity?since=2026-05-21T00:00:00Z" | python3 -m json.tool
```
