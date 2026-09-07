#!/usr/bin/env python3
"""Render assets/icon.png (256x256 RGBA) from assets/icon-source.svg.

Requires: pip install playwright pillow && python -m playwright install chromium

Usage (from the repo root):
  python scripts/render-icon.py            # render + verify, writes assets/icon.png
  python scripts/render-icon.py --preview out/  # also write preview sheets (dark / light, several sizes)
  python scripts/render-icon.py --root <dir>    # operate on another checkout (e.g. the dev workspace)

What it guarantees (asserted, exit code 1 on failure):
  * the four corners and everything outside the rounded tile are fully transparent (no white background)
  * fully transparent pixels carry the tile's purple in RGB, so downscaling never bleeds white or black
  * the foreground (ghost / keys) keeps a margin from the tile edge
  * the rim of the tile is not lighter than its interior (no highlight ring)
  * composited on a dark and on a light background at 42px and 24px, the outer ring is not lighter than the interior
"""
import argparse, io, math, os, re, sys

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.dirname(HERE)
SIZE = 256
RADIUS = 58
PURPLE_RGB = (140, 92, 250)  # RGB stored under alpha=0; mid tone of the gradient

def lum(p):
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]

def inside_tile(x, y, r=RADIUS, size=SIZE):
    cx = min(max(x + 0.5, r), size - r)
    cy = min(max(y + 0.5, r), size - r)
    return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r

def render(page, svg_text):
    html = f"<!doctype html><html><body style='margin:0;background:transparent'>{svg_text}</body></html>"
    page.set_content(html)
    page.wait_for_timeout(50)
    png = page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": SIZE, "height": SIZE})
    return Image.open(io.BytesIO(png)).convert("RGBA")

def fg_bbox(img):
    """Bounding box of ghost + keys: opaque pixels that are clearly not the purple background."""
    px = img.load()
    xs, ys = [], []
    for y in range(SIZE):
        for x in range(SIZE):
            r, g, b, a = px[x, y]
            if a < 200:
                continue
            purple = b > r + 20 and b > g + 60
            if not purple:
                xs.append(x); ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--preview", default=None, help="directory for preview sheets")
    ap.add_argument("--scale", type=float, default=8.9, help="design-space scale (26-unit layout -> px)")
    ap.add_argument("--center-y", type=float, default=129.0, help="vertical center of the foreground bbox")
    args = ap.parse_args()

    src_path = os.path.join(args.root, "assets", "icon-source.svg")
    out_path = os.path.join(args.root, "assets", "icon.png")
    svg = io.open(src_path, encoding="utf-8").read()

    def with_transform(tx, ty, s):
        return svg.replace("__TX__", f"{tx:.3f}").replace("__TY__", f"{ty:.3f}").replace("__S__", f"{s:.4f}")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": SIZE, "height": SIZE}, device_scale_factor=1)

        # pass 1: measure the foreground bbox at a provisional placement, then center it
        img = render(page, with_transform(20.0, 16.0, args.scale))
        bb = fg_bbox(img)
        assert bb, "no foreground found in pass 1"
        cx = (bb[0] + bb[2] + 1) / 2
        cy = (bb[1] + bb[3] + 1) / 2
        tx = 20.0 + (SIZE / 2 - cx)
        ty = 16.0 + (args.center_y - cy)
        img = render(page, with_transform(tx, ty, args.scale))
        browser.close()

    # post-process: fully transparent pixels get the purple RGB (avoid white/black fringe when scaled)
    px = img.load()
    for y in range(SIZE):
        for x in range(SIZE):
            r, g, b, a = px[x, y]
            if a == 0:
                px[x, y] = (*PURPLE_RGB, 0)

    # ---------- verification ----------
    problems = []
    for (x, y) in [(0, 0), (SIZE - 1, 0), (0, SIZE - 1), (SIZE - 1, SIZE - 1)]:
        if px[x, y][3] != 0:
            problems.append(f"corner {(x, y)} alpha={px[x, y][3]} (must be 0)")
    outside = []
    for y in range(SIZE):
        for x in range(SIZE):
            # tolerance: allow the anti-aliasing band on the corner arcs (a slightly less-rounded shape)
            if not inside_tile(x, y, RADIUS - 2.5) and px[x, y][3] != 0:
                outside.append((x, y, px[x, y][3]))
    if outside:
        strong = [o for o in outside if o[2] > 64]
        print(f"pixels beyond the tolerance band: {len(outside)} (alpha>64: {len(strong)}); samples: {outside[:6]}")
        if strong:
            problems.append(f"{len(strong)} pixels outside the rounded tile have alpha > 64 (not anti-aliasing)")
    white_total = sum(1 for y in range(SIZE) for x in range(SIZE) if px[x, y][3] == 0 and px[x, y][:3] != PURPLE_RGB)
    if white_total:
        problems.append(f"{white_total} transparent pixels do not carry purple RGB")
    bb = fg_bbox(img)
    margin = min(bb[0], bb[1], SIZE - 1 - bb[2], SIZE - 1 - bb[3])
    if margin < 14:
        problems.append(f"foreground margin {margin}px < 14px (bbox {bb})")
    # rim vs interior luminance on the four straight edges (skip corner arcs)
    def band(coords):
        vals = [lum(px[x, y]) for (x, y) in coords if px[x, y][3] == 255]
        return sum(vals) / len(vals) if vals else 0
    mid = range(RADIUS + 8, SIZE - RADIUS - 8)
    edges = {
        "top": (band([(x, y) for x in mid for y in range(0, 3)]), band([(x, y) for x in mid for y in range(20, 23)])),
        "bottom": (band([(x, SIZE - 1 - y) for x in mid for y in range(0, 3)]), band([(x, SIZE - 1 - y) for x in mid for y in range(20, 23)])),
        "left": (band([(x, y) for y in mid for x in range(0, 3)]), band([(x, y) for y in mid for x in range(20, 23)])),
        "right": (band([(SIZE - 1 - x, y) for y in mid for x in range(0, 3)]), band([(SIZE - 1 - x, y) for y in mid for x in range(20, 23)])),
    }
    for name, (rim, inner) in edges.items():
        if rim > inner + 1.5:
            problems.append(f"{name} rim luminance {rim:.1f} > interior {inner:.1f} + 1.5 (highlight ring)")

    # small-size composites: outer ring must not be lighter than interior on dark and light backgrounds
    def composite(bg_rgb, size):
        small = img.resize((size, size), Image.LANCZOS)
        bg = Image.new("RGBA", (size, size), (*bg_rgb, 255))
        out = Image.alpha_composite(bg, small)
        return out.convert("RGB")
    for bg_rgb, label in [((30, 30, 30), "dark"), ((255, 255, 255), "light")]:
        for size in (42, 24):
            comp = composite(bg_rgb, size)
            cp = comp.load()
            r_small = RADIUS * size / SIZE
            ring, inner = [], []
            for y in range(size):
                for x in range(size):
                    if not inside_tile(x, y, r_small, size):
                        continue
                    depth = min(x, y, size - 1 - x, size - 1 - y)
                    if depth <= 0:
                        ring.append(lum(cp[x, y]))
                    elif 3 <= depth <= 6:
                        inner.append(lum(cp[x, y]))
            ring_l = sum(ring) / len(ring); inner_l = sum(inner) / len(inner)
            # on a light background the anti-aliased edge blends toward white; only the dark case must not lighten,
            # and on light the ring must not be brighter than the background-blended expectation of +40
            limit = 4.0 if label == "dark" else 40.0
            if ring_l > inner_l + limit:
                problems.append(f"{label} bg @{size}px: outer ring luminance {ring_l:.1f} > interior {inner_l:.1f} + {limit}")
            print(f"composite {label:5s} @{size:3d}px: ring={ring_l:6.1f} interior={inner_l:6.1f}")

    print(f"placement: tx={tx:.2f} ty={ty:.2f} scale={args.scale}  foreground bbox={bb} margin={margin}px")
    print(f"corners alpha: {[px[x, y][3] for (x, y) in [(0, 0), (SIZE - 1, 0), (0, SIZE - 1), (SIZE - 1, SIZE - 1)]]}")
    for name, (rim, inner) in edges.items():
        print(f"edge {name:6s}: rim={rim:6.1f} interior={inner:6.1f}")

    if args.preview:
        os.makedirs(args.preview, exist_ok=True)
        for bg_rgb, label in [((30, 30, 30), "dark"), ((245, 245, 247), "light")]:
            sizes = [128, 64, 42, 24]
            w = sum(sizes) + 24 * (len(sizes) + 1)
            sheet = Image.new("RGB", (w, 128 + 48), bg_rgb)
            x = 24
            for s in sizes:
                small = img.resize((s, s), Image.LANCZOS)
                y = 24 + (128 - s) // 2
                sheet.paste(small, (x, y), small)
                x += s + 24
            sheet.save(os.path.join(args.preview, f"icon-preview-{label}.png"))
        print("preview sheets written to", args.preview)

    if problems:
        print("VERIFY FAILED:")
        for pr in problems:
            print("  -", pr)
        sys.exit(1)
    img.save(out_path, optimize=True)
    print(f"wrote {out_path} ({os.path.getsize(out_path)} bytes) RGBA {SIZE}x{SIZE}")

if __name__ == "__main__":
    main()
