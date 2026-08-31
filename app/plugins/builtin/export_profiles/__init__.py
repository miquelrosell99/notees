"""Export Profiles builtin plugin (Task 15, Decisions 13/29/31/34).

Continuously maintained, per-user file export trees over the source/asset
graph. Ships as a generalized builtin plugin (disabled by default): profile
config in workspace settings, a layered engine (provider manifest → path
validation → reconciler → materializer), the builtin ``bibliographic``
provider, and continuous reconciliation (post-commit op hook + debounce +
startup pass).
"""
