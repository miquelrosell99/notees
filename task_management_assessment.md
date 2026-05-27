# Task Management Assessment: Notees vs. Industry Standards

**Date:** 2026-05-27  
**Scope:** Backend, Frontend, UX patterns  
**Comparators:** Todoist, Notion, TickTick, Things 3, OmniFocus, ClickUp

---

## 1. Executive Summary

Notees implements task management through an **elegant but minimal class-based architecture**. Tasks are not a dedicated entity; they are generic `node` rows assigned the `task` system class, with properties (Status, Deadline, Scheduled, Priority, Closed Date, Recurrence) stored via the existing property system.

This design is **architecturally sound**—it avoids duplication, leverages the QueryAST system, and keeps the data model uniform. However, the **user-facing surface area is thin**. Compared to dedicated task managers, Notees lacks critical UX affordances: no Kanban view, no checklist blocks, no dedicated task inbox, no natural-language capture, and a broken `listTasks` endpoint.

**Verdict:** The foundation is solid. The product layer needs work.

---

## 2. Current Implementation (Notees)

### 2.1 Architecture

| Layer | Implementation |
|-------|---------------|
| **Data model** | Task = `node` row + `task` class in `class_ids` array. No `is_task` flag. |
| **Schema** | Reuses `node`, `property`, `class_property`, `property_selection_line`, `property_value_selection`, `property_value_relation`. No task-specific tables. |
| **Properties** | Status (selection), Deadline (date→day-node), Scheduled (date→day-node), Priority (selection), Closed Date (date→day-node), Recurrence (selection). |
| **Backend service** | No `TaskService`. Uses generic `NodeService` + `ClassManagementService` + automation hooks in `properties/values.py`. |
| **Repository** | No `TaskRepository`. Uses generic `NodeRepository` + `PropertyRepository`. |
| **API** | No dedicated task router. Tasks are created/updated via generic `/api/nodes` and `/api/nodes/{id}/properties` endpoints. |
| **Frontend** | `TaskCyclePlugin` (Ctrl+Enter), `GanttView`, generic `NodeCollection` views (list/table/card). |

### 2.2 What Works Well

| Feature | Status | Notes |
|---------|--------|-------|
| Status workflow | ✅ | 6 states: Backlog, Pending, Doing, Reviewing, Done, Cancelled. |
| Closed Date automation | ✅ | Auto-sets/clears `Closed Date` when status changes to/from Done/Cancelled. |
| Recurrence automation | ✅ | Advances Deadline + Scheduled Date and resets Status when a recurring task is completed. Supports Daily, Weekday, Weekly, Biweekly, Monthly, Yearly. |
| Ctrl+Enter cycle | ✅ | Editor plugin cycles Pending → Doing → Done → remove task class. |
| Gantt integration | ✅ | Defaults to `task_scheduled`/`task_deadline` for canvas-based Gantt bars with drag-to-reschedule. |
| QueryAST compatibility | ✅ | Tasks are queryable as standard nodes with class filters. |
| Logseq importer mapping | ✅ | Maps Logseq task classes/properties to Notees equivalents. |

### 2.3 What's Missing or Broken

| Feature | Status | Impact |
|---------|--------|--------|
| `GET /api/nodes/tasks` endpoint | ❌ **Broken** | Frontend `listTasks()` calls an endpoint that does not exist. |
| Checklist / todo blocks | ❌ Missing | No inline checkbox blocks in the editor (e.g., `- [ ]` Markdown-style). |
| Kanban board view | ❌ Missing | No drag-and-drop columnar status view. |
| Dedicated task inbox | ❌ Missing | No "Today" / "Upcoming" / "Inbox" aggregation views. |
| Natural language input | ❌ Missing | No "Pick up milk tomorrow at 5pm" parsing. |
| Reminders / notifications | ❌ Missing | No push/email/local reminders for deadlines. |
| Task dependencies | ❌ Missing | No blocked-by / blocking relationships. |
| Time tracking | ❌ Missing | No timers or logged time on tasks. |
| Task templates | ❌ Missing | Cannot quickly create pre-filled task pages. |
| Inline task badges | ❌ Missing | Editor blocks do not show deadline/priority chips inline. |
| Task-specific tests | ❌ Missing | No tests for status cycling, recurrence, or closed-date automation. |
| Documentation | ❌ Missing | No docs for task behavior in `docs/` or `AGENTS.md`. |

---

## 3. Comparative Analysis

### 3.1 Todoist — The Simplicity Benchmark

| Capability | Todoist | Notees | Gap |
|------------|---------|--------|-----|
| Quick capture (natural language) | ✅ "Buy milk tomorrow 5pm" | ❌ Manual property entry | **Large** |
| Inbox / Today / Upcoming | ✅ First-class views | ❌ Generic node queries only | **Large** |
| Priorities | ✅ P1–P4 with color | ✅ 4 levels (Low/Medium/High/Urgent) | Parity |
| Sub-tasks | ✅ Dedicated UI | ⚠️ Generic child blocks | Medium |
| Recurring tasks | ✅ Rich natural syntax | ✅ Interval-based, limited UI | Small |
| Labels & filters | ✅ Powerful DSL | ⚠️ Tags exist but no filter UI | Medium |
| Reminders | ✅ Time & location | ❌ None | **Large** |
| Board view | ✅ Kanban | ❌ No Kanban | **Large** |
| Karma / productivity stats | ✅ Gamification | ❌ None | Medium |
| Sections | ✅ Within projects | ⚠️ Generic block hierarchy | Small |

**Takeaway:** Todoist wins on **speed of capture** and **focused execution views**. Notees needs an inbox-like aggregation and natural-language parsing to compete here.

### 3.2 Notion — The Flexibility Benchmark

| Capability | Notion | Notees | Gap |
|------------|--------|--------|-----|
| Database views | ✅ Table, Board, Timeline, Calendar, Gallery, List | ⚠️ List, Table, Card, Gantt, Timeline | Small |
| Custom properties | ✅ Unlimited typed properties | ✅ Unlimited via class system | Parity |
| Formulas / rollups | ✅ Computed columns | ❌ No formula properties | **Large** |
| Relations between databases | ✅ Linked records | ⚠️ Generic `node_link` + bi-links | Medium |
| Templates | ✅ Page & database templates | ⚠️ Generic node templates | Small |
| Sub-tasks | ✅ Self-referencing relations | ⚠️ Child blocks/pages | Medium |
| AI assistant | ✅ Paid add-on | ❌ None | Medium |
| Natural language dates | ✅ "Tomorrow" in properties | ❌ Manual day-node selection | Medium |
| Mobile offline | ✅ Native apps | ⚠️ PWA with service worker | Small |

**Takeaway:** Notion wins on **customizability** and **formulaic automation**. Notees's class system is conceptually similar but lacks computed properties and self-relations. The Gantt/Timeline views are comparable.

### 3.3 TickTick — The Feature-Rich Benchmark

| Capability | TickTick | Notees | Gap |
|------------|----------|--------|-----|
| Checklists within tasks | ✅ Rich sub-checklists | ❌ No checklist blocks | **Large** |
| Pomodoro timer | ✅ Built-in | ❌ None | Medium |
| Habit tracking | ✅ Separate module | ❌ None | Medium |
| Eisenhower Matrix | ✅ Built-in view | ❌ None | Medium |
| Smart lists (filters) | ✅ Powerful rules | ⚠️ QueryAST possible, no preset views | Medium |
| Calendar integration | ✅ Two-way sync | ⚠️ Day-node relations only | Medium |
| Kanban view | ✅ Per list | ❌ None | **Large** |
| White noise / focus | ✅ Built-in | ❌ None | Low |

**Takeaway:** TickTick is a **feature superset** for personal productivity. Notees should not try to match all of this, but **checklists** and **Kanban** are table-stakes for a competitive task experience.

### 3.4 Things 3 / OmniFocus — The GTD Benchmark

| Capability | Things 3 / OmniFocus | Notees | Gap |
|------------|---------------------|--------|-----|
| Today / Upcoming / Someday | ✅ Core navigation | ❌ No date-based aggregation | **Large** |
| Projects & Areas | ✅ First-class containers | ⚠️ Generic pages/blocks | Medium |
| Evening tasks | ✅ Things 3 only | ❌ None | Low |
| Review mode | ✅ Scheduled reviews | ❌ None | Medium |
| Defer dates | ✅ Start date vs due date | ⚠️ Scheduled Date exists | Small |
| Sequential projects | ✅ OmniFocus only | ❌ None | Medium |
| Custom perspectives | ✅ OmniFocus only | ⚠️ QueryAST queries | Small |
| Focus mode | ✅ Hide everything else | ❌ None | Medium |

**Takeaway:** GTD tools excel at **clarity of focus** (what to do now). Notees lacks the "Today" lens that makes a task manager feel like a daily companion rather than a database.

### 3.5 ClickUp / Hive / Monday — The Team Benchmark

| Capability | ClickUp | Notees | Gap |
|------------|---------|--------|-----|
| Assignees | ✅ Multi-user | ❌ Single-user only | **Large** |
| Task dependencies | ✅ Blocked / waiting on | ❌ None | **Large** |
| Time tracking | ✅ Native timer | ❌ None | Medium |
| Workload view | ✅ Capacity planning | ❌ None | Medium |
| Automation recipes | ✅ If-this-then-that | ❌ Only hardcoded automations | **Large** |
| Comments / mentions | ✅ Rich threads | ⚠️ Comments exist on nodes | Small |
| Multiple assignees | ✅ Yes | ❌ N/A | Medium |
| Custom statuses per project | ✅ Yes | ⚠️ One global status set | Medium |

**Takeaway:** Notees is currently **single-user by design** (self-hosted, privacy-first). Team features are out of scope for now, but task dependencies and time tracking are still valuable for personal use.

---

## 4. SWOT Analysis

### Strengths
- **Architectural elegance:** No task-specific tables means zero migration debt and full QueryAST compatibility.
- **Bidirectional linking:** Tasks live in the same graph as notes, enabling rich context (unlike Todoist).
- **Recurring logic:** Backend recurrence automation is robust (weekday skipping, safe day capping).
- **Gantt view:** Canvas-based Gantt with drag-to-reschedule is already implemented and task-aware.
- **Unified model:** Tasks can simultaneously be journal entries, notes, or project pages.

### Weaknesses
- **Broken endpoint:** `listTasks` calls a non-existent API. The feature is unreachable.
- **No checklist blocks:** Cannot create inline `- [ ]` checklists inside a page. This is a major gap for a block-based editor.
- **No Kanban view:** Status workflows cry out for a board view; it is entirely absent.
- **Missing "Today" view:** No date-scoped aggregation. Users cannot answer "What do I need to do today?"
- **No natural language:** Creating a task with a deadline requires multiple clicks instead of typing.
- **Thin test coverage:** Zero automated tests for task automations (recurrence, closed date).

### Opportunities
- **Checklist blocks** would make Notees competitive with Logseq/Obsidian task workflows.
- **Kanban view** is a natural extension of the existing `table`/`card` view infrastructure.
- **Today / Upcoming queries** can be pre-built QueryAST filters surfaced as first-class sidebar items.
- **Command palette integration** could allow `> Add task: Buy milk tomorrow` natural-language capture.
- **Task templates** leverage the existing template system with class defaults pre-applied.
- **Mobile share target** (already exists) could be extended to create tasks from shared text.

### Threats
- **Power users expect GTD views:** Without Today/Upcoming, heavy task users will stay in Todoist/Things.
- **Block-editor competitors:** Logseq and Obsidian both have rich checkbox/task plugins. Notees's editor is weaker for tasks.
- **Missing API surface:** The broken `listTasks` endpoint signals feature drift between frontend and backend.

---

## 5. Prioritized Recommendations

### P0 — Critical (Fix First)

| # | Recommendation | Effort | Rationale |
|---|---------------|--------|-----------|
| 1 | **Implement `GET /api/nodes/tasks`** or remove `listTasks` frontend call. | Low | Currently dead code / broken feature. |
| 2 | **Add tests for task automations.** Cover recurrence advancement and closed-date logic. | Low | Prevents regressions in business-critical behavior. |
| 3 | **Add checklist block type** to the Lexical editor (`- [ ]` / `- [x]`). | Medium | Table-stakes for a block editor with task support. |

### P1 — High Impact

| # | Recommendation | Effort | Rationale |
|---|---------------|--------|-----------|
| 4 | **Build a Kanban view** in `NodeCollection` using `task_status` for columns. | Medium | The most requested task view pattern. |
| 5 | **Create pre-built "Today" / "Overdue" / "Upcoming" queries** in the sidebar using QueryAST date filters. | Low | Delivers GTD-style focus without new backend work. |
| 6 | **Inline task badges** in the editor: render small deadline/priority chips next to task-classed blocks. | Low | Immediate visual affordance. |
| 7 | **Natural language date parsing** in task creation (e.g., `Buy milk tomorrow`). | Medium | Reduces friction to Todoist levels. |

### P2 — Differentiation

| # | Recommendation | Effort | Rationale |
|---|---------------|--------|-----------|
| 8 | **Task dependencies** (`blocked_by` relations) with visual indicators. | Medium | Enables project planning beyond simple to-dos. |
| 9 | **Time tracking** (start/stop timer + logged duration property). | Medium | Personal productivity power-user feature. |
| 10 | **Task templates** with pre-filled sub-tasks and properties. | Low | Reuses existing template infrastructure. |
| 11 | **Command palette quick capture:** `> Task: Buy milk tomorrow #high`. | Low | Leverages existing command palette + NLP. |

### P3 — Future / Team-Oriented

| # | Recommendation | Effort | Rationale |
|---|---------------|--------|-----------|
| 12 | **Reminders / notifications** via browser Push API or email. | High | Requires scheduling infrastructure. |
| 13 | **Formula properties** (computed fields like "Days until deadline"). | High | Matches Notion's depth; heavy backend work. |
| 14 | **Workload / capacity views** once multi-user support arrives. | High | Team feature. |

---

## 6. Conclusion

Notees has a **philosophically correct** task foundation: tasks are nodes, properties are flexible, and the QueryAST system can already filter and aggregate them. This is superior to rigid task tables in the long run.

However, the **product experience is currently below the threshold** where a task-oriented user would choose Notees over Todoist, Things, or even Logseq. The immediate priorities are:

1. **Fix the broken `listTasks` endpoint** (or remove it).
2. **Add checklist blocks** to the editor.
3. **Ship a Kanban view** and **Today/Upcoming sidebar queries**.

With those three features, Notees crosses the line from "has tasks" to "is a task manager." Everything else is optimization.
