# Technology Stack — Notees

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Backend | FastAPI | 0.136.3 | REST API framework |
| Backend | Uvicorn | 0.48.0 | ASGI server |
| Backend | Pydantic | 2.13.4 | Data validation |
| Backend | pydantic-settings | 2.14.2 | `.env` configuration |
| Backend | PyJWT | 2.13.0 | JWT tokens (HS256) |
| Backend | passlib | 1.7.4 | Password hashing (bcrypt primary, pbkdf2_sha256 legacy) |
| Backend | asyncpg | 0.31.0 | Async PostgreSQL driver |
| Backend | fastapi-limiter | 0.2.0 | Rate limiting (with `pyrate_limiter`) |
| Backend | WeasyPrint | 68.1 | PDF generation |
| Backend | Pillow | 12.2.0 | Image processing |
| Database | PostgreSQL | 17 | Primary persistent storage |
| Frontend | React | 19.2.6 | UI framework |
| Frontend | TypeScript | ~6.0.3 | Type safety |
| Frontend | Vite | 8.0.14 | Build tool & dev server |
| Frontend | Zustand | 5.0.13 | Client-side state management |
| Frontend | TanStack Query | 5.100.14 | Server-state caching |
| Frontend | Axios | 1.16.1 | HTTP client |
| Frontend | @dnd-kit | latest | Drag & drop |
| Frontend | sql.js | 1.14.0 | In-browser SQLite (WASM) |
| Mobile | Flutter (Dart) | — | Native mobile app, lives in `miquelrosell99/notees-flutter` |
| Containerization | Docker + Docker Compose | — | Production deployment and local development stack |
