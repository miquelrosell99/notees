# Undo and redo — the session journal

**Ctrl/Cmd+Z** undoes, **Ctrl/Cmd+Shift+Z** (or Ctrl+Y) redoes. The topbar's **undo/redo buttons** do the same (disabled when there is nothing to (re)apply, hover for the exact step), and the undo button's **chevron** — or **Ctrl/Cmd+Shift+H** — opens the **history menu**: everything this tab did, newest first with labels and times; clicking a row opens the node it affected.

Notees keeps one authority — the immutable operation log — and the undo journal is a **client convenience on top of it**, not a second history: every edit you make is an op in the log, and undo works by composing **existing ops in reverse** (an update restores the captured prior values, a create becomes a soft delete, a delete becomes a restore, a move returns to the prior parent and sibling position). Nothing about undo changes the wire; an undone edit syncs like any other edit.

The journal is **session-local and per-tab**:

- It records only what **this tab** wrote. Another device's (or another tab's) edits apply to your view but never enter your journal — you cannot undo what you did not write.
- It lives in memory: a reload starts empty, and the durable unpushed backlog replays without re-entering it.
- It is **bounded** (200 entries) and typing coalesces: contiguous edits to one block inside a short window are **one** undo step — paragraph-grained for typing (one step per run of typing), so press once, the whole run of typing comes back. Everything structural — creates, deletes, moves, property edits, renames — is one step.

**What undo covers:** everything structural — creating and deleting blocks and pages, text edits (title renames included), moves and indents, class/tag assigns and unassigns, property edits, class-property binding changes, extends changes, colors and icons, and a **page merge** (the whole gesture — children, remaps, and the source's trash — as one step, [pages.md](pages.md#merging-pages)). Clicking a history row **jumps to it**: the affected node opens (for text entries that is plain navigation — the journal cannot restore a past caret, and it doesn't pretend to); rows whose nodes no longer exist list disabled.

Two honesty limits: a **permanent** delete is data loss and is not undoable, and deleting a **class** tombstones its memberships, so it is not undoable either. Those are the two gestures undo cannot take back.

**The keystroke rule:** while a text field — including the outliner editor — owns the focus, the keystroke stays **text-scoped**: the editor keeps its native text behavior and the global journal stays out of the way. Everything outside text editing — structural gestures, property edits, deletes, moves, renames — is one journal step, reachable the moment focus leaves the editor. There is deliberately no cross-buffer guessing: the editor's local text undo is text-scoped, the journal is gesture-scoped, and the two never fight over a keystroke.

The trash is recoverable independently of the journal: soft-trashed subtrees sit in the Trash hub (restore is the same first-class `object.restore` op the journal and the CLI use — [pages.md](pages.md#the-app-shell--sidebar-top-bar-and-popups), [cli.md](../cli.md#a-real-session)).
