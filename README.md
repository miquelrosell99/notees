# Notees

A self-hosted, privacy-first, local-first note-taking application with bidirectional linking and offline support.

![Python](https://img.shields.io/badge/python-3.12+-blue.svg)
![React](https://img.shields.io/badge/react-19-61dafb.svg)
![TypeScript](https://img.shields.io/badge/typescript-6-3176c6.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)

## What is Notees?

Notees is a local-first, self-hosted note-taking app. Your workspace data lives in a client-side SQLite database inside the browser; edits happen instantly and sync to your own server when you are online. It supports wiki-style `[[links]]`, backlinks, block-based editing, daily journals, tasks, queries, graph view, whiteboards, flashcards, and plugins.

The mobile app is a native Flutter companion focused on phone workflows. It lives in its own repository: [miquelrosell99/notees-flutter](https://github.com/miquelrosell99/notees-flutter).

## Documentation

- [Installation](docs/installation.md) — prerequisites, development stack, production deployment
- [Configuration](docs/configuration.md) — environment variables, security settings, first-boot registration
- [Usage](docs/usage.md) — pages/blocks, links, journals, tasks, queries, graph/whiteboard, export, offline use
- [Developer Guide](docs/developer-guide.md) — project structure, tests, lint, local development, key conventions
- [Architecture](docs/architecture.md) — technical architecture: data model, query layer, sync, performance
- [API Reference](docs/api.md) — REST API and operation relay endpoints
- [Plugins](docs/plugins.md) — plugin system, manifest, built-in plugins
- [Troubleshooting](docs/troubleshooting.md) — common issues and fixes
- [FAQ](docs/faq.md) — frequently asked questions
- [Security Policy](docs/SECURITY.md)
- [Changelog](docs/CHANGELOG.md)

## Quick Start

```bash
# Configure environment
cp .env.example .env
# Edit .env and set SECRET_KEY, ADMIN_PASSWORD, POSTGRES_PASSWORD

# Run the development stack
task dev
# Or: docker compose -f compose.dev.yaml up
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:8001

For production deployment, see [docs/installation.md](docs/installation.md#production-deployment).

## AI-Assisted Development

This project was developed with the assistance of AI tools. AI was used throughout the development process to help design architecture, write code, and solve problems.

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See [Developer Guide](docs/developer-guide.md) for tests and linting commands.

## License

Notees is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

This ensures the software remains free and open-source, even when used over a network. If you modify and deploy Notees as a web service, you must make your source code available to users.

See the [LICENSE](LICENSE) file for the full license text.

## Acknowledgments

Inspired by tools like Roam Research, Logseq, and Obsidian. Built with FastAPI, React, and PostgreSQL.
