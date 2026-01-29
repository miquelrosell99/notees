# Notees

A self-hosted, privacy-first note-taking application with bidirectional linking and offline support.

![Python](https://img.shields.io/badge/python-3.11+-blue.svg)
![React](https://img.shields.io/badge/react-18-61dafb.svg)
![TypeScript](https://img.shields.io/badge/typescript-5-3178c6.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)

## Features

- **Bidirectional Linking** — Create connections between notes with `[[wiki-style]]` links. Backlinks are tracked automatically.
- **Block-Based Editor** — Outliner-style editing where every block can be referenced, embedded, or moved.
- **Daily Journal** — Built-in daily, monthly, and yearly journal pages with calendar navigation.
- **Types & Properties** — Organize notes with types and custom properties for powerful filtering.
- **Tasks** — Track todos inline or as dedicated task pages with status, priority, and due dates.
- **Offline-First** — Works without internet. Changes sync when you're back online.
- **Self-Hosted** — Your data stays on your server. No cloud dependencies.
- **Multi-Database** — Create separate knowledge bases for different projects or contexts.
- **Export** — Export notes to Markdown, HTML, or PDF.

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/notees.git
cd notees

# Set up Python environment
python -m venv .venv
.venv\Scripts\activate  # Windows
# source .venv/bin/activate  # macOS/Linux

# Install dependencies
pip install -r requirements.txt

# Build the frontend
cd frontend
npm install
npm run build
cd ..

# Run the application
python run.py
```

Open http://localhost:8000 in your browser.

### Docker

The easiest way to run Notees in production:

```bash
# Copy environment file and configure
cp .env.example .env
# Edit .env and set a secure SECRET_KEY!

# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f
```

For development with hot-reload:

```bash
docker-compose -f docker-compose.dev.yml up
```

**Docker files:**
- `Dockerfile` — Production multi-stage build (builds frontend + backend)
- `Dockerfile.dev` — Development backend with hot-reload
- `docker-compose.yml` — Production deployment
- `docker-compose.dev.yml` — Development with hot-reload
- `.dockerignore` — Files to exclude from Docker builds

## Project Structure

```
notees/
├── app/                    # Backend (FastAPI)
│   ├── domain/             # Core business logic
│   │   ├── entities/       # Domain models (Node, User)
│   │   ├── services/       # Domain services
│   │   └── errors.py       # Domain exceptions
│   ├── application/        # Use cases
│   ├── infrastructure/     # Repository implementations
│   ├── routers/            # API endpoints
│   └── static/dist/        # Built frontend
├── frontend/               # Frontend (React + TypeScript)
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── stores/         # Zustand state management
│   │   └── types/          # TypeScript types
│   └── vite.config.ts
├── tests/                  # Test suite
└── data/                   # User data (gitignored)
```

## Development

### Backend

```bash
# Run with auto-reload
uvicorn app.main:app --reload

# Run tests
pytest tests/ -v
```

### Frontend

```bash
cd frontend

# Development server with hot reload
npm run dev

# Type checking
npm run typecheck

# Production build
npm run build
```

## Architecture

Notees follows a **hexagonal architecture** (ports & adapters) pattern:

- **Domain Layer** — Pure business logic with no external dependencies
- **Application Layer** — Use cases that orchestrate domain operations
- **Infrastructure Layer** — Database and external service implementations
- **API Layer** — FastAPI routers that expose HTTP endpoints

### Node Types

The core concept is the **Node** — everything is a node with composable types:

| Type | Description |
|------|-------------|
| `PAGE` | A document/note that can contain blocks |
| `BLOCK` | Content within a page |
| `TAG` | Categorization (always also a page) |
| `PROPERTY` | Custom metadata schema (always also a page) |
| `DAILY` | Daily journal entry (always also a page) |
| `TASK` | Todo item (can be page or block) |

## API

The REST API is available at `/api/*`:

| Endpoint | Description |
|----------|-------------|
| `POST /api/auth/login` | Authenticate user |
| `GET /api/nodes` | List nodes |
| `POST /api/nodes` | Create node |
| `GET /api/nodes/{id}` | Get node by ID |
| `PUT /api/nodes/{id}` | Update node |
| `DELETE /api/nodes/{id}` | Delete node |
| `GET /api/search` | Search nodes |
| `GET /api/daily/{date}` | Get/create daily page |

## Configuration

Environment variables (or `.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | (generated) | JWT signing key |
| `ACCESS_TOKEN_EXPIRE_HOURS` | `24` | Token expiration |
| `LOG_LEVEL` | `INFO` | Logging verbosity |

## Contributing

Contributions are welcome! Please read the contributing guidelines before submitting a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Notees is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

This ensures the software remains free and open-source, even when used over a network. If you modify and deploy Notees as a web service, you must make your source code available to users.

See the [LICENSE](LICENSE) file for the full license text.

## Acknowledgments

Inspired by tools like Roam Research, Logseq, and Obsidian. Built with FastAPI, React, and SQLite.
