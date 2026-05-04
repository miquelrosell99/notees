# Architecture Overview

Notees is a **self-hosted note-taking application** with bidirectional linking, built using a hexagonal architecture on the backend and a modern React stack on the frontend.

---

## High-Level Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Backend** | FastAPI (Python 3.11+) | REST API, business logic |
| **Database** | PostgreSQL (via asyncpg) | Persistent storage |
| **Frontend** | React 19 + TypeScript + Vite | Single-page application |
| **State** | Zustand + TanStack Query | Client-side state & server cache |
| **Editor** | Lexical | Rich-text block editing |
| **Containerization** | Docker + Docker Compose | Deployment |

---

## Architectural Diagram

```
┌──────────────────────────────────────────────────────┐
│                    Frontend (React)                   │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Zustand  │  │ TanStack     │  │  Lexical      │  │
│  │  Stores   │  │ Query Cache  │  │  Editor       │  │
│  └──────────┘  └──────┬───────┘  └───────────────┘  │
│                       │                              │
│               ┌───────┴───────┐                      │
│               │   API Client  │  (Axios, /api/*)     │
│               └───────┬───────┘                      │
└───────────────────────┼──────────────────────────────┘
                        │ HTTP (JWT Auth)
┌───────────────────────┼──────────────────────────────┐
│                  Backend (FastAPI)                    │
│                       │                              │
│  ┌────────────────────┴─────────────────────────┐    │
│  │              Routers (API Layer)              │    │
│  │  nodes/ · properties/ · auth · assets · ...  │    │
│  └────────────────────┬─────────────────────────┘    │
│                       │                              │
│  ┌────────────────────┴─────────────────────────┐    │
│  │          Domain Services (Business Logic)     │    │
│  │  NodeService · LinkService · QueryExecutor    │    │
│  │  ClassExtensionService · AssetService · ...   │    │
│  └────────────────────┬─────────────────────────┘    │
│                       │                              │
│  ┌────────────────────┴─────────────────────────┐    │
│  │       Domain Entities (Pure Data Models)      │    │
│  │  Node · NodeLink · Property · QueryAST        │    │
│  └────────────────────┬─────────────────────────┘    │
│                       │                              │
│  ┌────────────────────┴─────────────────────────┐    │
│  │      Repositories (Database Abstractions)     │    │
│  │  NodeRepository · PropertyRepository · ...    │    │
│  └────────────────────┬─────────────────────────┘    │
│                       │                              │
│               ┌───────┴───────┐                      │
│               │  PostgreSQL   │                      │
│               └───────────────┘                      │
└──────────────────────────────────────────────────────┘
```

---

## Backend: Hexagonal Architecture

The backend follows a **hexagonal (ports & adapters)** pattern with three distinct layers:

### 1. Domain Layer (`app/domain/`)

The core of the system — contains **pure business logic** with no external dependencies.

```
app/domain/
├── entities/          # Data models (dataclasses)
│   ├── node.py        # Node, NodeCreateData, NodeUpdateData
│   ├── link.py        # NodeLink, BacklinkInfo
│   ├── property.py    # Property, NodeProperty, value types
│   ├── query.py       # Legacy query model
│   ├── query_ast.py   # Canonical QueryAST (v1.0)
│   └── user.py        # User, AuthenticatedUser
│
├── services/          # Business logic orchestrators
│   ├── node_service.py           # Core CRUD + hierarchy
│   ├── link_service.py           # Link parsing + backlinks
│   ├── hierarchy_service.py      # Tree traversal (pure)
│   ├── query_service.py          # Query execution engine
│   ├── query_ast_sql.py          # AST → SQL compiler
│   ├── query_ast_validation.py   # AST validation
│   ├── node_view_service.py      # Dynamic views/tabs
│   ├── asset_service.py          # File management
│   └── class_extension_service.py # Class inheritance
│
├── repositories/      # Abstract interfaces (ports)
│   └── interfaces.py  # NodeRepository, PropertyRepository, etc.
│
└── errors.py          # Domain exceptions
```

### 2. Infrastructure Layer (`app/domain/repositories/`)

Concrete implementations of repository interfaces:

```
repositories/
├── postgres_node.py       # PostgreSQL node operations
├── postgres_link.py       # PostgreSQL link operations
├── postgres_property.py   # PostgreSQL property operations
├── postgres_node_view.py  # PostgreSQL view operations
└── postgres_user.py       # PostgreSQL user operations
```

### 3. Router Layer (`app/routers/`)

FastAPI endpoints that expose domain functionality:

```
routers/
├── auth.py            # Authentication (register, login)
├── workspaces.py      # Workspace management
├── assets.py          # File upload/download
├── sync.py            # Settings + sync stub
├── activity.py        # Activity logging
├── export.py          # Export to markdown/html/pdf
├── nodes/             # Node endpoints (sub-routers)
│   ├── crud.py        # CRUD + batch operations
│   ├── daily.py       # Journal pages
│   ├── classes.py     # Class assignments
│   ├── links.py       # Links, backlinks, aliases
│   ├── comments.py    # Comment threads
│   ├── favorites.py   # Favorites list
│   ├── search.py      # Search + workspace graph
│   ├── settings.py    # Date format settings
│   └── views.py       # Dynamic query views
└── properties/        # Property endpoints
    ├── crud.py        # Property definitions
    ├── values.py      # Property values (scalar/relation/selection)
    ├── classes.py     # Class-property bindings
    └── selection_lines.py  # Selection options
```

---

## Frontend: Component Architecture

```
frontend/src/
├── api/               # Axios API client + endpoint functions
├── components/        # React components
│   ├── core/          # Domain-agnostic atoms (Button, Card, Modal...)
│   ├── blocks/        # Block display components (Bullet, NodeInline)
│   ├── nodes/         # Node-level components (NodeCollection, PageHeader)
│   ├── properties/    # Property editors (PropertiesSection, PropertyCell)
│   ├── queries/       # Query builder UI (ViewBuilder, conditionConfigs)
│   ├── layout/        # App shell (Layout, Sidebar, TopBar, CommandPalette)
│   ├── sidebar/       # Right sidebar cards
│   └── workspace/     # Workspace management
├── editor/            # Lexical editor integration (28 plugins)
├── hooks/             # React hooks (data fetching, mutations, navigation)
├── stores/            # Zustand stores (app state, settings, auth)
├── types/             # TypeScript type definitions
├── utils/             # Utility functions (tree ops, date parsing, colors)
└── views/             # Top-level view components (NodeView, JournalsView...)
```

### Component Hierarchy

```
App
├── LoginView                    (unauthenticated)
├── WorkspaceManagementView      (no workspace)
└── Layout                       (main app)
    ├── TopBar
    ├── NavigationSidebar         (left)
    ├── MainContent               (center — view router)
    │   ├── NodeView              (pages & blocks)
    │   ├── JournalsView          (daily pages)
    │   ├── AllPagesView          (all root pages)
    │   ├── PropertyView          (single property)
    │   ├── TrashView             (deleted nodes)
    │   ├── ArchivedPagesView     (archived)
    │   └── Graph/Timeline views
    ├── CommentsSidebar           (conditional)
    └── RightSidebarCards         (shift-click panels)
```

---

## Key Design Principles

### 1. Everything is a Node
Pages, blocks, classes, tags, journals, assets, templates, comments — **all are Node records** differentiated by flags (`is_page`, `is_class`, `is_day`, `is_asset`, etc.) and relationships (`parent_id`).

### 2. Bidirectional Linking
Links (`[[nodeId]]`) are parsed from content and stored as explicit `NodeLink` entities, enabling efficient backlink queries. Both text links and property-value relations create backlinks.

### 3. Optimistic UI
Mutations (create, update, delete, move) apply changes to the TanStack Query cache **immediately** and roll back on failure. This creates a responsive editing experience.

### 4. Query-Driven Collections
All dynamic node lists (child pages, classed nodes, linked references) are powered by the **QueryAST** system, which compiles structured queries into PostgreSQL SQL at runtime.

### 5. Block-Based Content
Content is stored as a tree of blocks (child nodes), each containing a JSON AST of rich text. The Lexical editor projects this tree into a flat editing surface with depth metadata.

---

## Development Quick Start

```bash
# Backend only (port 8000)
uvicorn app.main:app --reload

# Frontend only (port 5173)
cd frontend && npm run dev

# Run tests
pytest tests/ -v

# Docker deployment
docker compose up -d
```

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection string |
| `SECRET_KEY` | (generated) | JWT signing key |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |
| `DATA_DIR` | `./data` | User data, backups, assets |

See `app/config.py` for all configuration options.
