"""Library builtin plugin (notees.library).

A pure view plugin: all data flows through the local-first query runtime on
the frontend, so there is no backend setup — the manifest declares only the
frontend entrypoint and the UI contributions. Plugin enablement is the on/off
toggle for the Library management UX (Decision 23); the underlying source
classes, attachments, graph, and search work regardless.
"""
