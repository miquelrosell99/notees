# Read later

**Read later** is your workspace's reading inbox: a toggle in Settings → Features plus one **"Read later" collection** that captured pages land in. It is deliberately not a separate surface — in this slice the collection *is* the inbox; there is no dedicated view and no unread badges (both are follow-up work, named below).

## The toggle

Settings → Features carries a **Read later** row after Journal, and it works exactly like the Journal row: a *surfaces* gate, not a class family. Flipping it writes the ordinary `workspace.feature.set` op, so the setting syncs like everything else, and the `web_page`/`collection` classes stay always-on either way. While the toggle is off, read-later captures answer `feature_disabled`.

One activation note: the toggle row appears when your deployment runs the sync-server update that introduces the `readItLater` feature id. Until then, the client treats read-later capture as enabled — the same absent-means-on default the Journal gate uses.

## The "Read later" collection

The first read-later capture **auto-creates** the collection (a `collection`-classed node named "Read later"; later captures find it by that name). It is ordinary op-log state — it syncs, it shows up in the workspace like any collection, and membership is add-wins: re-capturing a page already in it converges to "member", never a duplicate row.

Each captured page is a **`web_page` node** carrying the `url` and an `accessDate`; the URL on the node is the way back to the page — open it, read it, and take notes in child blocks under the node if a page earns them. (Library captures — source mode — land in your [sources library](sources.md) instead; see [the Notees Connector](connector.md) for the capture mechanics.)

## The honest edge (v1)

What ships in this slice: the toggle, the auto-created collection, and captures into it. What does **not**: a dedicated inbox view, and unread/read markers on captured pages (the design leans toward a property on the `web_page` node, but nothing ships until it does). The v1 loop is: capture → the "Read later" collection → open the page from its node → done.
