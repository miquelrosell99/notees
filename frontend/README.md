# Notees Frontend

React 19 + TypeScript SPA for Notees. See the [root README](../README.md) for the project overview and setup instructions.

## Frontend development

The frontend runs in Docker together with the backend, PostgreSQL, and Redis:

```bash
docker compose -f compose.dev.yaml up
```

The dev server is available at http://localhost:5173 (the backend API runs on :8001).

Common tasks (run inside the `frontend` container, or in this directory on the host):

```bash
npm run lint                           # ESLint
npx tsc -b --noEmit                    # TypeScript type-check
npm run test:run                       # Vitest unit tests
node scripts/validate-design-system.js # design-token validator
```

Frontend conventions (path aliases, feature barrels, query keys, UI patterns) live in [`agents/frontend.md`](../agents/frontend.md).
