"""Render the Notees knowledge-model one-pager."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

fig, ax = plt.subplots(figsize=(16, 18), dpi=150)
ax.set_xlim(0, 100); ax.set_ylim(0, 120); ax.axis("off")

BG = "#fafbfc"; ax.add_patch(plt.Rectangle((0, 0), 100, 120, fc=BG, ec="none", zorder=0))

def box(x, y, w, h, fc, ec, text, fs=10, tc="black", ls="-", bold_first=False, lw=1.6, z=3):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.6,rounding_size=1.2",
                                fc=fc, ec=ec, lw=lw, linestyle=ls, zorder=z))
    ax.text(x + w/2, y + h/2, text, ha="center", va="center", fontsize=fs, color=tc,
            zorder=z+1, linespacing=1.45, family="DejaVu Sans")

def arrow(x1, y1, x2, y2, label, lx, ly, color="#5b6470", ls="-", z=2, fs=9):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=18,
                                 color=color, lw=2, linestyle=ls, zorder=z,
                                 connectionstyle="arc3,rad=0"))
    ax.text(lx, ly, label, fontsize=fs, color=color, ha="center", style="italic", zorder=z+1,
            bbox=dict(fc=BG, ec="none", pad=1.5))

# Title
ax.text(50, 116.5, "Notees Knowledge Model — Greenfield v2", ha="center", fontsize=21,
        weight="bold", color="#1b2430")
ax.text(50, 113.6, "One object graph · the operation log is the only authority · every interface is a projection",
        ha="center", fontsize=11.5, color="#5b6470")

# ---- Layer: Projections ----
ax.add_patch(FancyBboxPatch((6, 92), 88, 16, boxstyle="round,pad=0.6,rounding_size=1.5",
                            fc="#e9f5ec", ec="#3f9d58", lw=2, zorder=2))
ax.text(9, 106.2, "PROJECTIONS — same graph, never separate stores", fontsize=11, weight="bold", color="#2e7d43", zorder=4)
box(8, 93.5, 26, 10.5, "white", "#3f9d58", "UI views\nlibrary · tree · graph\ntable · timeline\nbibliography · search", fs=9.5)
box(37, 93.5, 26, 10.5, "white", "#3f9d58", "Object API · CLI · agents\nscoped API keys · dry-run\naudit feed · one QueryAST\ngrammar everywhere", fs=9.5)
box(66, 93.5, 26, 10.5, "white", "#3f9d58", "Plugins\ncapability-brokered\nsubprocess host\nscoped permissions", fs=9.5)

# ---- Layer: Derived store ----
ax.add_patch(FancyBboxPatch((6, 48), 88, 38, boxstyle="round,pad=0.6,rounding_size=1.5",
                            fc="#e8f0fb", ec="#3b6fb5", lw=2, zorder=2))
ax.text(9, 83.2, "DERIVED STORE — per-workspace SQLite (server · browser worker · CLI)", fontsize=11, weight="bold", color="#2c5587", zorder=4)
ax.text(9, 80.4, "wipe → replay → identical · one TS implementation, three runtimes", fontsize=9, style="italic", color="#2c5587", zorder=4)
box(8, 66, 19.5, 12, "white", "#3b6fb5", "node — objects · blocks ·\nclasses · collections\nsoft kind · parent_id\n(OR-Set) · tags = classes", fs=8.8)
box(29.5, 66, 19.5, 12, "white", "#3b6fb5", "registry (config rows)\nproperty_schema\nclass bindings", fs=8.8)
box(51, 66, 19.5, 12, "#fff4e5", "#d9822b", "typed links — AST tokens\n(free verbs · schema refs)\nproperty_value (+metadata)\nedge index · backlink rollup", fs=8.8)
box(72.5, 66, 19.5, 12, "white", "#3b6fb5", "edge (derived)\nnode_link (stable pills)\nnode_view / collection\nnode_asset · search_index", fs=8.8)
box(8, 51, 41, 12, "white", "#3b6fb5", "assets — content-addressed CAS (sha256)\nbytes out of SQLite · Range · dedup · refcount\nthumbnails · extracted-text sidecars", fs=8.8)
box(51, 51, 41, 12, "white", "#3b6fb5", "identity — UUIDv7 everywhere\ntitles · citekeys · paths = attributes, never identity\nprovenance — actor + HLC + seq on every mutation", fs=8.8)

# ---- Layer: Operation log ----
box(6, 26, 88, 16, "#1b2430", "#1b2430",
    "OPERATION LOG — the only authority\nappend-only · idempotent ingest (op-id dedupe) · HLC causality + server seq ordering\n"
    "tombstones for deletion · actor provenance per op · E2EE slot (M3)\n"
    "semantic state only — device state is never an op",
    fs=11, tc="white")

# ---- Device state (side, dashed) ----
box(6, 8, 41, 13, "#fdf2f2", "#c0392b",
    "DEVICE STATE — client-only, never synced\ndevice_asset: pinned / cached / evictable\n"
    "LRU policy engine · resumable Range downloads\ncross-device pin preferences = user settings (existing sync)",
    fs=9, ls="--")

# ---- Semantic/device rule callout ----
box(51, 8, 43, 13, "#f4f6f8", "#8a94a3",
    "CONFLICT SEMANTICS (invariants)\nLWW by HLC — scalars & property values\nOR-Set add-wins — class membership\n"
    "Yjs CRDT — collaborative text/tree only\nno CRDT-everywhere · explicit conflict surfacing",
    fs=9)

# Arrows
arrow(50, 42.6, 50, 47.6, "replay (wipe → identical)", 50, 45.2, color="#1b2430")
arrow(28, 84.6, 28, 91.4, "query / read", 28, 88.2, color="#2e7d43")
arrow(72, 91.4, 72, 84.6, "emit ops (write path)", 72, 88.2, color="#2e7d43")
# Device state: dashed arrow along the left margin, UI projection down to device box.
ax.add_patch(FancyArrowPatch((8.5, 93.2), (7.2, 21.6), arrowstyle="-|>", mutation_scale=16,
                             color="#c0392b", lw=1.8, linestyle="--", zorder=1,
                             connectionstyle="arc3,rad=0.25"))
ax.text(2.2, 57, "device state never enters the log", fontsize=8.5, color="#c0392b",
        style="italic", ha="center", va="center", rotation=90)

fig.savefig("knowledge-model-diagram.png", bbox_inches="tight", facecolor=BG)
print("saved knowledge-model-diagram.png")
