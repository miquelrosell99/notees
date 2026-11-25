# Tasks

The Tasks hub and the task lifecycle: the query sections, the done checkbox, and the task Status property. Tasks surface on days through the calendar ([calendar.md](calendar.md)) and in every list view ([views.md](views.md#the-list-view-is-the-outline-view)); the keyboard toggle that creates and closes tasks is [outliner.md](outliner.md)'s (Ctrl/Cmd+Enter); the Status inline button is [properties.md](properties.md#inline-property-buttons)'s.

## The Tasks hub's query sections

The **Tasks** hub opens on its **Sections** view — **Overdue / Today / Upcoming / Unscheduled / Completed / Review** as stacked live-query sections — and the view switcher offers the rest of the collection modes (outline, cards, table, …) alongside it. The hub shows exactly one surface at a time: the sections, or the mode you selected; the switcher choice is device-local. Each section IS a query over the task class (the driving day is the earliest Scheduled/Deadline day: Overdue is "either date past", Today "either date today and neither past", Upcoming "a date exists and neither past-or-today", Unscheduled "no dates", Completed the whole closed set, Review the overdue set minus recurring tasks), so the sections re-run live as values change and a midnight crossing re-runs them against the new day. Every section carries its own view switcher (**outline** by default, table and cards alongside) and its own **Group by** picker (defaulting to **Status** — every option in its option order, empty ones included); the per-section choices and each section's collapsed state persist device-locally. Rows carry the done checkbox everywhere — closing a task moves it into Completed under your hands. The sections ride the hub's filtered item set, so the filter toolbar narrows every section like every other mode.

**New** in the hub's header creates a task: a task class with bound templates opens the template picker (the pick instantiates through the clone engine); without templates it creates directly — the new task lands **Unscheduled** (the date pill schedules it), and creation follows the calendar's day-view retirement. The same flow rides the global **Ctrl/Cmd+Alt+N** chord from anywhere in the app (the N-row register: plain N is a new page, Shift+N is quick add, Alt+N is a task).

The hub's other modes follow the shared collection rulings ([views.md](views.md)); its table opens on **Edited, newest first** ([the sort defaults](views.md#the-sort-button)). The hub-level **Group by** picker defaults to **Status** — the outline renders one collapsible section per status (every option in its option order, empty ones included), the table one table per status, the cards mode the status board; pick any other axis (Priority, Scheduled at a zoom, Page, Created, …) or None from the picker ([the group-by](views.md#the-group-by-any-property-plus-the-structural-axes)).

## One-tap postpone

Every scheduled open task row — the outline rows across the hub's sections and every other outline surface — carries a hover-revealed **Push to tomorrow** action, and the reminder toast offers **Tomorrow** beside Open: one tap rewrites the task's **Scheduled** to tomorrow, keeping its clock time (one write, one undo step). The gesture is Scheduled-only by design — a **deadline** is never one-tap postponed (rescheduling a commitment is a deliberate act on the task itself), a **recurring** task never shows it (the series rolls forward), and a range-valued Scheduled stays with the date pill. Deadline-only rows simply don't carry the action — no dead buttons.

## The Review section — the slipped-work sweep

The **Review** section is the slipped-work query: every open, non-recurring task whose driving day (the earliest Scheduled/Deadline day) lies in the past. Recurring tasks never list — a missed occurrence rolls forward to the next one, so there is nothing to review. The section is fully derived — a task leaves it the moment it is closed or rescheduled out of the past; nothing stores a "reviewed" mark. Rescheduling rides the per-row **Push to tomorrow** and the date pill; a passed **deadline** is never bulk-rewritten (a deadline is a commitment — rescheduling one is a per-task decision on the task itself). Like every section, it rides the hub's filtered item set, so the filter toolbar narrows it.

## Reminders

A task reminds you when its moment arrives — the Google Tasks model: the reminder rides the task's own **Scheduled** (else **Deadline**) datetime, no separate property. A **timed** value fires at its clock time; an **all-day** value fires at the device-local default time (Settings → Tasks, 09:00 out of the box). The reminder lands as a persistent in-app toast naming the task with an **Open** action, and — opt-in from the same settings section, with the browser's one-time permission — a system notification. Done and Cancelled tasks never remind; a recurring task reminds on each occurrence day (a completed occurrence stays silent, a missed one rolls forward with the series); a moment missed while the app was closed catches up only within its own day — past days belong to the [Review section](#the-review-section--the-slipped-work-sweep), not to reminders.

Reminders are **device-local** end to end: the enable toggle, the all-day default time, the browser-notification opt-in, and the fired-state (one fire per task-moment per device) live in device settings and localStorage — nothing is an op, nothing syncs, and every device fires its own reminders.

## The checkbox semantics

The checkbox closes a task (and reopens it) everywhere it renders — the Tasks hub, the day page's Tasks section: one write, one meaning. Closing a task — **Done or Cancelled** — stamps the task's **Closed** datetime automatically (day + wall-clock time of the transition; the web client authors it together with the status write, one undo step for both), and reopening clears it again: one timestamp for both closed states, with the Status saying which. Off the day context (the Tasks hub), the checkbox means **the whole task**. On a day context, for a repeating task, completing one occurrence completes only that day: the toggle records the date in the Repeat value's metadata (`completedOccurrences`), the occurrence renders struck-through on its day while every other occurrence stays open, and reopening removes just that date — the full ruling is [calendar.md](calendar.md)'s.

A task appears on a day when its **Scheduled** property points at that day; Done and Cancelled tasks never list ([calendar.md](calendar.md)).

## The task Status property

The built-in task **Status** is a selection property whose options are circles: gray Backlog, yellow Pending, orange Doing, blue Reviewing, green Done, red Cancelled. It can pin onto the block itself as an inline button (Next to bullet / Before content), rides every task row in list views as the clickable circle, and its option icons and colors are edited in the property settings — [properties.md](properties.md#inline-property-buttons) has the inline-button ruling.

A task's Status starts at **Pending** the moment the task class is assigned — the value is supplied by the class as a derived default, not stored on the node. Removing the task class removes the status again, unless you changed it to something else: a status you picked yourself stays on the node (shown unbound, without the "from a class" badge). The status pill reads dimmed while it is still the class-supplied default; your first change stores the value for real.

## The Priority property

The built-in task **Priority** is a select property with four options — Low, Medium, High, Urgent — pinned alongside Status/Scheduled/Deadline, so it renders in the task properties panel's pinned tier. In the hub it is a first-class **Group by** axis (the sections and the outline/table/cards modes group by it from the picker — Urgent → High → Medium → Low in option order, empty options included) and a table column; an unvalued task shows no pill and lands in the trailing no-value group. (The retired Buckets view's priority-first row sort and priority pills went with it — the sections render the standard outline rows; grouping by Priority is the surfacing now.)

## The Project property

The built-in task **Project** property (2026-10-28) is a multi-value node reference filtered to the `project` class: a task may span several projects and a project's backlinks list its tasks. The property is the relation — a task keeps no parent/place semantics, and nesting a task under a project page stays legal and reachable by subtree queries; use the property when the membership is the meaning, nesting when the outline position is. An unvalued task shows no empty Project row (the schema is hide-when-empty), and the binding is unpinned, so Project renders after the pinned Status/Scheduled/Deadline/Priority tier in the task properties panel.

Beyond the menu, **Ctrl/Cmd+Enter** on a block toggles its task state: a plain block becomes a task set to **Pending**, an open task jumps straight to **Done**, and a **Done** (or Cancelled) task clears back to a plain block ([outliner.md](outliner.md#slash-commands)).
