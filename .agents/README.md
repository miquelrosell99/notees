# .agents/ — internal agent reference docs

Reference documents extracted from AGENTS.md (and other over-dense internal
notes) so the root file stays lean. These are **internal**: the house rule
"internal notes never go in `docs/`" applies — `docs/` is person-facing.

- [parked-decisions.md](parked-decisions.md) — the owner parked-decisions
  register (what is parked, since when, and what un-parks it).
- [skills/notees-development/](skills/notees-development/SKILL.md) — project
  skill for changing the repo (architecture · coding conventions ·
  development workflow). Enforced by AGENTS.md "Skills (mandatory)".
- [skills/notees-operations/](skills/notees-operations/SKILL.md) — project
  skill for running the deployment (deployment · health checks · logs ·
  rollback · database migrations · backups · monitoring · incident response ·
  maintenance). References the external `deployment-runbook` skill (GitHub
  link in the SKILL.md when not installed locally).
