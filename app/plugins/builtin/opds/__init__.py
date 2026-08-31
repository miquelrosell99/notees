"""OPDS builtin plugin (Task 16, Decisions 28/32/34).

Serves an OPDS 1.2 catalog (Atom XML) over the same selection semantics as
export profiles (Task 15): selected sources with downloadable attachments.
Ships disabled by default; the underlying source/asset semantics never depend
on it. The feed is authenticated per user and never exposes internal storage
paths — downloads go through the existing asset token/download flow.
"""
