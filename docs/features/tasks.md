# Tasks

The Tasks hub and the task lifecycle: buckets, the done checkbox, and the task Status property. Tasks surface on days through the calendar ([calendar.md](calendar.md)) and in every list view ([views.md](views.md#the-list-view-is-the-outline-view)); the keyboard toggle that creates and closes tasks is [outliner.md](outliner.md)'s (Ctrl/Cmd+Enter); the Status inline button is [properties.md](properties.md#inline-property-buttons)'s.

## The Tasks hub's buckets

The **Tasks** hub opens on its **Buckets** view — **Overdue / Today / Upcoming / Unscheduled / Completed** — and the view switcher offers the rest of the collection modes (outline, cards, table, …) alongside it. The hub shows exactly one surface at a time: the Buckets list, or the mode you selected; the switcher choice is device-local. A task lands in exactly one open bucket by its earliest Scheduled/Deadline day; Completed is the whole closed set. Rows carry the same done checkbox as everywhere else — closing a task moves it into Completed under your hands. The section's collapsed state is device-local. The buckets compute client-side from the effective Scheduled/Deadline/Status values — the same derived reads the table renders from — and ride the hub's filtered item set, so the filter toolbar narrows the buckets like every other mode. No query, no op.

**New** in the hub's header creates a task: a task class with bound templates opens the template picker (the pick instantiates through the clone engine); without templates it creates directly — the new task lands **Unscheduled** (the date pill schedules it), and creation follows the calendar's day-view retirement. The same flow rides the global **Ctrl/Cmd+Alt+N** chord from anywhere in the app (the N-row register: plain N is a new page, Shift+N is quick add, Alt+N is a task).

The hub's other modes follow the shared collection rulings ([views.md](views.md)); its table opens on **Edited, newest first** ([the sort defaults](views.md#the-sort-button)).

## The Review view — the unreviewed-days queue

The switcher's **Review** mode is the slipped-work sweep: every PAST day that still carries open work, oldest first, grouped by the day the work was driving toward (the buckets' exact rule — the earliest Scheduled/Deadline day). Each day group lists its slipped tasks with the standard rows — the done checkbox (the hub's exact write), the priority and status pills — and the day header opens the day page. **Push to today** reschedules the day's scheduled-driven tasks to today as ONE undo step; a passed **deadline** is never bulk-rewritten (a deadline is a commitment — rescheduling one is a per-task decision on the task itself). Recurring tasks never list: a missed occurrence rolls forward to the next one, so there is nothing to review. The queue is fully derived — a day leaves it the moment its open tasks are closed or rescheduled out of the past; nothing stores a "reviewed" mark. Like every mode, the queue rides the hub's filtered item set, so the filter toolbar narrows it.

## Reminders

A task reminds you when its moment arrives — the Google Tasks model: the reminder rides the task's own **Scheduled** (else **Deadline**) datetime, no separate property. A **timed** value fires at its clock time; an **all-day** value fires at the device-local default time (Settings → Tasks, 09:00 out of the box). The reminder lands as a persistent in-app toast naming the task with an **Open** action, and — opt-in from the same settings section, with the browser's one-time permission — a system notification. Done and Cancelled tasks never remind; a recurring task reminds on each occurrence day (a completed occurrence stays silent, a missed one rolls forward with the series); a moment missed while the app was closed catches up only within its own day — past days belong to the [Review view](#the-review-view--the-unreviewed-days-queue), not to reminders.

Reminders are **device-local** end to end: the enable toggle, the all-day default time, the browser-notification opt-in, and the fired-state (one fire per task-moment per device) live in device settings and localStorage — nothing is an op, nothing syncs, and every device fires its own reminders.

## The checkbox semantics

The checkbox closes a task (and reopens it) everywhere it renders — the Tasks hub, the day page's Tasks section: one write, one meaning. Closing a task — **Done or Cancelled** — stamps the task's **Closed** datetime automatically (day + wall-clock time of the transition; the web client authors it together with the status write, one undo step for both), and reopening clears it again: one timestamp for both closed states, with the Status saying which. Off the day context (the Tasks hub), the checkbox means **the whole task**. On a day context, for a repeating task, completing one occurrence completes only that day: the toggle records the date in the Repeat value's metadata (`completedOccurrences`), the occurrence renders struck-through on its day while every other occurrence stays open, and reopening removes just that date — the full ruling is [calendar.md](calendar.md)'s.

A task appears on a day when its **Scheduled** property points at that day; Done and Cancelled tasks never list ([calendar.md](calendar.md)).

## The task Status property

The built-in task **Status** is a selection property whose options are circles: gray Backlog, yellow Pending, orange Doing, blue Reviewing, green Done, red Cancelled. It can pin onto the block itself as an inline button (Next to bullet / Before content), rides every task row in list views as the clickable circle, and its option icons and colors are edited in the property settings — [properties.md](properties.md#inline-property-buttons) has the inline-button ruling.

A task's Status starts at **Pending** the moment the task class is assigned — the value is supplied by the class as a derived default, not stored on the node. Removing the task class removes the status again, unless you changed it to something else: a status you picked yourself stays on the node (shown unbound, without the "from a class" badge). The status pill reads dimmed while it is still the class-supplied default; your first change stores the value for real.

## The Priority property

The built-in task **Priority** is a select property with four options — Low, Medium, High, Urgent — pinned alongside Status/Scheduled/Deadline, so it renders in the task properties panel's pinned tier. It drives the hub: every open bucket sorts **priority-first** (Urgent → High → Medium → Low, unprioritized tasks last), falling back to the bucket's own ordering (the driving day in Overdue/Upcoming) within one priority, and each prioritized row carries a priority pill — Urgent reads in the error register, High in the warning register, Medium/Low stay neutral. Completed is id-ordered: priority is an open-work signal, not a closed-history one. An unvalued task shows no pill and sorts with the unprioritized.

## The Project property

The built-in task **Project** property (2026-10-28) is a multi-value node reference filtered to the `project` class: a task may span several projects and a project's backlinks list its tasks. The property is the relation — a task keeps no parent/place semantics, and nesting a task under a project page stays legal and reachable by subtree queries; use the property when the membership is the meaning, nesting when the outline position is. An unvalued task shows no empty Project row (the schema is hide-when-empty), and the binding is unpinned, so Project renders after the pinned Status/Scheduled/Deadline/Priority tier in the task properties panel.

Beyond the menu, **Ctrl/Cmd+Enter** on a block toggles its task state: a plain block becomes a task set to **Pending**, an open task jumps straight to **Done**, and a **Done** (or Cancelled) task clears back to a plain block ([outliner.md](outliner.md#slash-commands)).
