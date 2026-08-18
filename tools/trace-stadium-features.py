#!/usr/bin/env python3
"""Reproduce the BX-32 corner-pocket guard calibration from photographs.

The top view fixes the guard's plan curve.  The oblique product photograph is
needed for height because a white-on-white wall is nearly invisible overhead:
vertical luminance edges are measured relative to the adjacent, already
calibrated 4.6 mm X-Line envelope.  Exact factory dimensions are not published,
so this remains a documented photographic inference rather than a TT spec.

Example (the images themselves stay in ignored build/reference-* folders):

  python tools/trace-stadium-features.py \
    --overhead path/to/user-bx32-overhead.png \
    --oblique path/to/61mev0MM2vL.jpg \
    --overlay-dir build/stadium-feature-overlay \
    --check-ts app/src/core/stadium.ts
"""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from statistics import median

from PIL import Image, ImageDraw


TAU = math.pi * 2
OVERHEAD_CENTER_X = 254.5
OVERHEAD_MIRROR_Y = 282.5
LONG_AXIS_M_PER_PX = 0.00133
SHORT_AXIS_M_PER_PX = 0.00114
BX32_R_WALL_M = 0.19
BX32_HALF_STRAIGHT_M = 0.055
REAR_RIGHT_ANGLE = 0.71
REAR_RIGHT_SKEW = -1.02
X_LINE_ENVELOPE_MM = 4.6
GUARD_VAULT_SPEED_MPS = 2.2

# Traced on the unobstructed upper half, mirrored from the packet-obscured
# lower guard. The small search corridor is intentionally kept in the source
# coordinates so this audit remains reproducible rather than hand-waved.
OVERHEAD_GUARD_SEEDS_PX = [
    (356.11, 178.22),
    (362.05, 170.05),
    (372.54, 162.92),
    (386.17, 159.26),
    (400.42, 160.08),
    (412.57, 164.90),
    (420.57, 169.66),
]

# The horizontal rear X-Line provides a clean same-perspective reference.
GUIDE_PROBE_X = 1000
GUIDE_TOP_RANGE = (650, 680)
GUIDE_BOTTOM_RANGE = (685, 705)
# Multiple wall probes reject one-off casing highlights. These are the broad
# molded white wedge immediately before the left rear Xtreme pocket.
GUARD_PROBE_XS = (550, 555, 560, 580, 585)
GUARD_TOP_RANGE = (630, 680)
GUARD_BOTTOM_RANGE = (730, 780)
# Plan-view crest/collision width converted on the photograph's short-axis
# calibration. The oblique silhouette also shows a much broader asymmetric
# molded apron; it is not a constant-width extruded bar.
GUARD_FULL_THICKNESS_PX = 18.42
GUARD_BOWL_APRON_M = 0.026
GUARD_POCKET_APRON_M = 0.012
GUARD_CREST_HALF_WIDTH_M = 0.0075


def boundary_radius(theta: float) -> float:
    ux = math.cos(theta)
    uy = math.sin(theta)
    if abs(uy) > 1e-12:
        straight = BX32_R_WALL_M / abs(uy)
        if straight * abs(ux) <= BX32_HALF_STRAIGHT_M:
            return straight
    disc = max(0.0, BX32_R_WALL_M**2 - BX32_HALF_STRAIGHT_M**2 * uy**2)
    return BX32_HALF_STRAIGHT_M * abs(ux) + math.sqrt(disc)


def pocket_frame() -> tuple[tuple[float, float], tuple[float, float], tuple[float, float]]:
    radius = boundary_radius(REAR_RIGHT_ANGLE)
    boundary = (radius * math.cos(REAR_RIGHT_ANGLE), radius * math.sin(REAR_RIGHT_ANGLE))
    center_x = min(BX32_HALF_STRAIGHT_M, max(-BX32_HALF_STRAIGHT_M, boundary[0]))
    normal = (boundary[0] - center_x, boundary[1])
    length = math.hypot(*normal)
    normal = (normal[0] / length, normal[1] / length)
    tangent = (-normal[1], normal[0])
    c = math.cos(REAR_RIGHT_SKEW)
    s = math.sin(REAR_RIGHT_SKEW)
    axis = (normal[0] * c + tangent[0] * s, normal[1] * c + tangent[1] * s)
    length = math.hypot(*axis)
    axis = (axis[0] / length, axis[1] / length)
    across = (-axis[1], axis[0])
    return boundary, axis, across


def plan_trace() -> list[dict[str, float]]:
    boundary, axis, across = pocket_frame()
    points: list[dict[str, float]] = []
    for pixel_x, pixel_y in OVERHEAD_GUARD_SEEDS_PX:
        world_x = (OVERHEAD_MIRROR_Y - pixel_y) * LONG_AXIS_M_PER_PX
        world_y = (pixel_x - OVERHEAD_CENTER_X) * SHORT_AXIS_M_PER_PX
        dx = world_x - boundary[0]
        dy = world_y - boundary[1]
        points.append({
            "along": dx * axis[0] + dy * axis[1],
            "across": dx * across[0] + dy * across[1],
        })
    points.sort(key=lambda point: point["across"])
    return points


def vertical_edge_peak(gray: Image.Image, x: int, bounds: tuple[int, int]) -> int:
    start, end = bounds
    pixels = gray.load()
    return max(range(start, end), key=lambda y: abs(int(pixels[x, y + 1]) - int(pixels[x, y])))


def height_fit(oblique: Image.Image) -> dict[str, object]:
    gray = oblique.convert("L")
    guide_top = vertical_edge_peak(gray, GUIDE_PROBE_X, GUIDE_TOP_RANGE)
    guide_bottom = vertical_edge_peak(gray, GUIDE_PROBE_X, GUIDE_BOTTOM_RANGE)
    guide_span = guide_bottom - guide_top
    guard_spans: list[int] = []
    guard_edges: list[tuple[int, int, int]] = []
    for x in GUARD_PROBE_XS:
        top = vertical_edge_peak(gray, x, GUARD_TOP_RANGE)
        bottom = vertical_edge_peak(gray, x, GUARD_BOTTOM_RANGE)
        guard_edges.append((x, top, bottom))
        guard_spans.append(bottom - top)
    guard_span = float(median(guard_spans))
    height_mm = X_LINE_ENVELOPE_MM * guard_span / guide_span
    return {
        "guideEdgesPx": [guide_top, guide_bottom],
        "guideSpanPx": guide_span,
        "guardEdgesPx": guard_edges,
        "guardMedianSpanPx": guard_span,
        "heightM": height_mm / 1000,
    }


def write_overlays(
    directory: Path,
    overhead: Image.Image,
    oblique: Image.Image,
    fit: dict[str, object],
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    top = overhead.convert("RGB")
    draw = ImageDraw.Draw(top)
    draw.line(OVERHEAD_GUARD_SEEDS_PX, fill=(255, 35, 35), width=3)
    for point in OVERHEAD_GUARD_SEEDS_PX:
        draw.ellipse((point[0] - 3, point[1] - 3, point[0] + 3, point[1] + 3), fill=(255, 230, 0))
    top.save(directory / "bx32-guard-plan-trace.png")

    side = oblique.convert("RGB")
    draw = ImageDraw.Draw(side)
    guide_top, guide_bottom = fit["guideEdgesPx"]
    draw.line((GUIDE_PROBE_X, guide_top, GUIDE_PROBE_X, guide_bottom), fill=(0, 255, 70), width=4)
    for x, upper, lower in fit["guardEdgesPx"]:
        draw.line((x, upper, x, lower), fill=(255, 35, 35), width=3)
    side.save(directory / "bx32-guard-height-probes.png")


def check_typescript(path: Path, result: dict[str, object]) -> None:
    source = path.read_text(encoding="utf-8")
    block = re.search(r"const BX32_REAR_GUARD[^=]*=\s*\[(.*?)\];", source, re.S)
    if not block:
        raise SystemExit("BX32_REAR_GUARD not found")
    found = [
        (float(along), float(across))
        for along, across in re.findall(r"along:\s*([-0-9.]+).*?across:\s*([-0-9.]+)", block.group(1))
    ]
    expected = [(round(point["along"], 4), round(point["across"], 4)) for point in result["planControlPoints"]]
    if len(found) != len(expected) or any(
        abs(actual[0] - wanted[0]) > 0.00015 or abs(actual[1] - wanted[1]) > 0.00015
        for actual, wanted in zip(found, expected)
    ):
        raise SystemExit(f"TypeScript guard trace differs: {found!r} != {expected!r}")
    height = float(result["heightFit"]["heightM"])
    if f"{height:.4f}" not in source:
        raise SystemExit(f"TypeScript does not contain derived height {height:.4f} m")
    if 'kind: "solid"' not in source or f"vaultSpeed: {GUARD_VAULT_SPEED_MPS:.1f}" not in source:
        raise SystemExit("TypeScript does not contain the solid BX-32 guard collision contract")
    for value in (GUARD_BOWL_APRON_M, GUARD_POCKET_APRON_M, GUARD_CREST_HALF_WIDTH_M):
        if f"{value:.4g}" not in source:
            raise SystemExit(f"TypeScript does not contain molded-wedge dimension {value:.4g} m")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--overhead", type=Path, required=True)
    parser.add_argument("--oblique", type=Path, required=True)
    parser.add_argument("--overlay-dir", type=Path)
    parser.add_argument("--check-ts", type=Path)
    args = parser.parse_args()

    overhead = Image.open(args.overhead)
    oblique = Image.open(args.oblique)
    if overhead.size != (500, 500):
        raise SystemExit(f"expected the supplied 500x500 overhead, got {overhead.size}")
    if oblique.width < 1900 or oblique.height < 1500:
        raise SystemExit(f"expected the high-resolution oblique product image, got {oblique.size}")
    fit = height_fit(oblique)
    result = {
        "schemaVersion": 2,
        "product": "BX-32",
        "method": "mirrored-overhead-plan+oblique-shadow-edge-ratio",
        "planControlPoints": plan_trace(),
        "halfThicknessM": GUARD_FULL_THICKNESS_PX * SHORT_AXIS_M_PER_PX / 2,
        "moldedWedgeProfile": {
            "bowlApronM": GUARD_BOWL_APRON_M,
            "pocketApronM": GUARD_POCKET_APRON_M,
            "crestHalfWidthM": GUARD_CREST_HALF_WIDTH_M,
        },
        "heightFit": fit,
        "collisionModel": {
            "kind": "solid",
            "vaultSpeedMps": GUARD_VAULT_SPEED_MPS,
            "qualification": "simulation calibration; ordinary deployed 1.7-2.0 m/s approaches must rebound",
        },
        "sources": {
            "overhead": args.overhead.name,
            "oblique": "https://m.media-amazon.com/images/I/61mev0MM2vL.jpg",
        },
        "qualification": "photo-calibrated inference; no published TT mold dimensions",
    }
    if args.overlay_dir:
        write_overlays(args.overlay_dir, overhead, oblique, fit)
    if args.check_ts:
        check_typescript(args.check_ts, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
