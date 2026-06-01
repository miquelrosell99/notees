#!/usr/bin/env python3
"""Generate monochrome Notees icon PNGs from a Python/PIL drawing."""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw


def draw_monochrome_icon(size: int) -> Image.Image:
    """Draw the monochrome Notees icon at the given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Colors
    bg = "#111111"
    fg = "#FFFFFF"

    # Background rounded rect (radius = 24 at 192px => 12.5%)
    radius = int(size * 24 / 192)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=bg)

    # Notepad body: x=48, y=36, w=96, h=120, rx=8 at 192px
    pad_x = int(size * 48 / 192)
    pad_y = int(size * 36 / 192)
    pad_w = int(size * 96 / 192)
    pad_h = int(size * 120 / 192)
    pad_rx = int(size * 8 / 192)
    draw.rounded_rectangle(
        [pad_x, pad_y, pad_x + pad_w, pad_y + pad_h],
        radius=pad_rx,
        fill=fg,
    )

    # Lines
    line_y1 = int(size * 68 / 192)
    line_y2 = int(size * 88 / 192)
    line_y3 = int(size * 108 / 192)
    line_x1 = int(size * 64 / 192)
    line_x2_full = int(size * 128 / 192)
    line_x2_short = int(size * 104 / 192)
    stroke = max(1, int(size * 5 / 192))

    for y, x2 in [(line_y1, line_x2_full), (line_y2, line_x2_full), (line_y3, line_x2_short)]:
        draw.line([(line_x1, y), (x2, y)], fill=bg, width=stroke)

    # Pencil (two polygons)
    # Polygon 1: 124,100 -> 140,116 -> 134,122 -> 118,106
    p1 = [
        (int(size * 124 / 192), int(size * 100 / 192)),
        (int(size * 140 / 192), int(size * 116 / 192)),
        (int(size * 134 / 192), int(size * 122 / 192)),
        (int(size * 118 / 192), int(size * 106 / 192)),
    ]
    draw.polygon(p1, fill=bg)

    # Polygon 2: 118,106 -> 114,122 -> 134,122
    p2 = [
        (int(size * 118 / 192), int(size * 106 / 192)),
        (int(size * 114 / 192), int(size * 122 / 192)),
        (int(size * 134 / 192), int(size * 122 / 192)),
    ]
    draw.polygon(p2, fill=bg)

    return img


def main() -> None:
    root = Path(__file__).parent.parent

    sizes = {
        "frontend/public/pwa-192.png": 192,
        "frontend/public/pwa-512.png": 512,
        "frontend/public/apple-touch-icon.png": 180,
    }

    for rel_path, size in sizes.items():
        out = root / rel_path
        icon = draw_monochrome_icon(size)
        icon.save(out, "PNG")
        print(f"Saved {out} ({size}x{size})")

    # Also copy to app/static/dist if it exists
    dist_dir = root / "app/static/dist"
    if dist_dir.exists():
        for filename in ["pwa-192.png", "pwa-512.png", "apple-touch-icon.png"]:
            src = root / "frontend/public" / filename
            dst = dist_dir / filename
            dst.write_bytes(src.read_bytes())
            print(f"Copied to {dst}")


if __name__ == "__main__":
    main()
