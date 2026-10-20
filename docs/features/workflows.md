# Workflows

A **workflow** watches everything written to your workspace and reacts: *when X happens to a node that matches Y, do Z* — evaluated on the server, so it runs no matter which client made the change. It is automation for your graph, not a plugin system: the triggers, the criteria language, and the actions are the built-in vocabulary below. There is no UI yet: rules are managed through the API ([api.md](../api.md)); the developer runbook ([../developers/workflows.md](../developers/workflows.md)) has the table shapes, the loop policy, and the audit semantics.

- **X — the trigger.** What happened: a node was created (`object.create`), a property was set (`property.set`), or a class was assigned (`class.assign` — Notees has no separate "assign class" op; this trigger covers the class-add operation however it arrives).
- **Y — the criteria.** The same query language saved views and query blocks use ([queries.md](queries.md)) — class membership, present-as-main, content, property values, links, creation date — combined with and/or/not. The rule only fires if the affected node matches.
- **Z — the action, v1.** Set a property (`property.set` with a fixed value) or assign a class (`class.assign`). Actions are written as ordinary operations by the server itself, so they sync to every device like your own edits and appear in the operation feed with the `rules-engine` provenance.

Original limits, honestly: **no rule chains** — an action's effects are evaluated once more, but a match there is recorded (`skipped_depth_cap`) rather than executed, so one batch can fire at most one hop of rules. A rule's own actions can **never re-trigger the same rule** (the loop breaker, recorded as `skipped_loop` when it would have matched). Triggers cover creates and property/class writes — not moves, deletes, or restores yet. Every firing attempt lands in an append-only **run audit** (`GET /api/workflows/:id/runs`) with its outcome; a failing action is audited and never blocks your write. Rule state lives in the server's coordination database (like shares and prefs — not in the operation log); only the server's default workspace is covered, and **only the owner/admin (or the operator key) can create, change, or delete rules** — any signed-in principal can read them.

Example — flag every new Paper for review:

```bash
curl -s -X POST localhost:8377/api/workflows \
  -H "X-API-Key: $NOTEES_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "name": "Flag new papers",
    "trigger": {"opType": "object.create"},
    "criteria": {"version": 1, "scope": {"type": "entire_workspace"},
      "root": {"type": "group", "logic": "and",
        "children": [{"type": "class", "classId": "<paper-class-uuid>"}]}},
    "actions": [{"type": "property.set",
      "propertySchemaId": "<review-schema-uuid>", "value": "needs review"}]
  }'
```

`GET/PATCH/DELETE /api/workflows[/:id]` complete the CRUD (see [api.md](../api.md)).
