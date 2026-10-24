# Tasks

The Tasks hub and the task lifecycle: buckets, the done checkbox, and the task Status property. Tasks surface on days through the calendar ([calendar.md](calendar.md)) and in every list view ([views.md](views.md#the-list-view-is-the-outline-view)); the keyboard toggle that creates and closes tasks is [outliner.md](outliner.md)'s (Ctrl/Cmd+Enter); the Status inline button is [properties.md](properties.md#inline-property-buttons)'s.

## The Tasks hub's buckets

The **Tasks** hub keeps its table/cards collection and leads with a collapsible **Buckets** section: **Overdue / Today / Upcoming / Unscheduled / Completed**. A task lands in exactly one open bucket by its earliest Scheduled/Deadline day; Completed is the whole closed set. Rows carry the same done checkbox as everywhere else — closing a task moves it into Completed under your hands. The section's collapsed state is device-local. The buckets compute client-side from the effective Scheduled/Deadline/Status values — the same derived reads the table renders from — with the earliest-day rule so every open task lands in exactly one bucket and far-future work is never dropped. No query, no op.

The hub's table/cards collection follows the shared collection rulings ([views.md](views.md)); its table opens on **Edited, newest first** ([the sort defaults](views.md#the-sort-button)).

## The checkbox semantics

The checkbox closes a task (and reopens it) everywhere it renders — the Tasks hub, the day page's Tasks section: one write, one meaning. Off the day context (the Tasks hub), the checkbox means **the whole task**. On a day context, for a repeating task, completing one occurrence completes only that day: the toggle records the date in the value's metadata (`completedOccurrences`), the occurrence renders struck-through on its day while every other occurrence stays open, and reopening removes just that date — the full ruling is [calendar.md](calendar.md)'s.

A task appears on a day when its **Scheduled** property points at that day; Done and Cancelled tasks never list ([calendar.md](calendar.md)).

## The task Status property

The built-in task **Status** is a selection property whose options are circles: gray Backlog, yellow Pending, orange Doing, blue Reviewing, green Done, red Cancelled. It can pin onto the block itself as an inline button (Next to bullet / Before content), rides every task row in list views as the clickable circle, and its option icons and colors are edited in the property settings — [properties.md](properties.md#inline-property-buttons) has the inline-button ruling.

Beyond the menu, **Ctrl/Cmd+Enter** on a block toggles its task state: a plain block becomes a task set to **Pending**, an open task jumps straight to **Done**, and a **Done** (or Cancelled) task clears back to a plain block ([outliner.md](outliner.md#slash-commands)).
