# Workflows

A **workflow** is a convention doc over shipped machinery. Notees ships features — machinery — and a workflow teaches one disciplined way to use them: named classes and property schemas, defaults, checks, and templates, all expressible in the vocabulary the platform already has.

## The boundary test

- A **feature** is machinery: a capability the platform gains — a resolver, a query language, embeds, export.
- A **workflow** is a doc you could have written yourself: every class, schema, template, and check in it is ordinary user-space vocabulary — create the pieces with the names the doc gives them and the method is yours. Nothing in a workflow requires code, new op types, or seeded schema.
- A "workflow" that needs new machinery is a **feature request**, not a workflow. If the doc can't be built from what ships today, it doesn't belong in this folder.

Workflows are convention, never enforcement: checks ship as doc paragraphs, defaults as templates. The design law applies — predictions become defaults, never prohibitions.

Not to be confused with [Workflows](../features/workflows.md), the server-side automation feature (when X on nodes matching Y, do Z) — same word, different thing.

## The workflows

- **[The research workflow](research-workflow.md)** — a disciplined pipeline (project → per-use source instances → located notes → comparison → synthesis → open questions → writing plan → review) over the source library, typed links, embeds, and export. The normative vocabulary list lives in [SCHEMA.md](../../packages/protocol/SCHEMA.md) ("Starter vocabulary").
