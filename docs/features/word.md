# The Word add-in

**Designed — ships with the Word add-in milestone; nothing here is installable today.** This page records the settled shape so the feature is documented the day it lands, and says plainly what it will and will not be.

The Notees **Word add-in** puts your [sources library](sources.md) inside Word: search your sources from a task pane, insert a live citation or a formatted bibliography, and refresh both as the library changes. It is the Zotero architecture adapted to this stack — Zotero's own plugin is a native COM add-in, which is not buildable here — and it is **local-first**: the add-in never talks to the network, so citations keep working with no connectivity at all.

## The shape

An **Office.js task pane**: a search box over your Notees sources, results you can **Cite** or build a **bibliography** from, and a **Refresh** that re-renders what the document already carries. A citation-style picker covers CSL styles — a few bundled plus user-supplied `.csl` files. Citations insert as **Word field codes carrying an embed**, so documents stay portable and refreshable in any Word that opens them.

## The localhost bridge

The add-in talks only to **`notees serve`** — a bridge command in the Notees CLI that runs an HTTP server bound to **127.0.0.1 only**, speaking a small JSON protocol modeled on the Zotero connector's document commands (search, insert-citation, bibliography, refresh, document-removed). Citation rendering rides the shipped export machinery plus a citeproc implementation, and the sync engine keeps the bridge's local store current — **sync is the bridge's problem**, which is why offline work just works. Security is pairing, not accounts: the first connect pairs through a token file, the add-in's origin is checked, and the add-in itself holds **no credentials**. Your server hosts the add-in's statics at `/word/`; installing them is **sideloading** — a shared-folder catalog on desktop Word, or the Microsoft 365 admin center for Word on the web.

## What is not in v1

No native (COM/VSTO) plugin. No Word-for-web support beyond the admin-center sideload. No store distribution — the sideloading steps above are the whole install story, and that one-time friction is the honest cost of a self-hosted tool integrating with a proprietary suite.
