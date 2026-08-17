"""Fetch normalized Beyblade X part references and measured silhouettes.

The renderer intentionally does not import third-party meshes.  This tool
collects the isolated, transparent part renders published by Beyblade Wiki so
the procedural models can be compared with (and later fitted to) the real
moulds.  It writes compact WebP references plus a manifest containing:

* 256 counter-clockwise outer-radius samples for top-view upper parts and
  Ratchets (sample 0 points to the right in the source image),
* a bottom-to-top normalized lathe silhouette for side-view Bits, and
* up to three dominant colours sampled from the visible moulded part.

Run from the repository root:

    python tools/fetch-model-reference.py
    python tools/fetch-model-reference.py --force

Only the public MediaWiki API and image URLs recorded in ``sources.json`` are
used.  Missing or not-yet-published parts are reported rather than replaced by
guessed artwork.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import runpy
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
PARTS_PATH = ROOT / "app" / "public" / "data" / "parts.json"
CODE_NAMES_PATH = ROOT / "data" / "raw" / "part_code_names.json"
OUT_DIR = ROOT / "app" / "public" / "assets" / "models"
MANIFEST_PATH = ROOT / "app" / "src" / "render" / "model-reference-manifest.json"
SOURCES_PATH = OUT_DIR / "sources.json"

API = "https://beyblade.fandom.com/api.php"
USER_AGENT = "BeybladeXSim/0.1 (model reference asset builder)"
ASSET_SIZE = 512
ASSET_MARGIN = 12
RADIAL_SAMPLES = 256
SIDE_SAMPLES = 96
ALPHA_THRESHOLD = 24

UPPER_CATEGORIES = ("blade", "mainBlade", "assistBlade", "metalBlade", "overBlade")
CATEGORIES = (*UPPER_CATEGORIES, "ratchet", "bit")
PREFIXES = {
    "blade": "Blade",
    "mainBlade": "MainBlade",
    "assistBlade": "AssistBlade",
    "metalBlade": "MetalBlade",
    "overBlade": "OverBlade",
    "ratchet": "Ratchet",
    "bit": "Bit",
}
ASSET_PREFIXES = {
    "blade": "blade",
    "mainBlade": "main-blade",
    "assistBlade": "assist-blade",
    "metalBlade": "metal-blade",
    "overBlade": "over-blade",
    "ratchet": "ratchet",
    "bit": "bit",
}
CODE_NAME_TABLES = {
    "assistBlade": "AssistBlade",
    "overBlade": "OverBlade",
    "bit": "Bit",
}

# Two reversible parts are published as separate mode images.  The normalized
# database stores those modes as stat variants, so keep their silhouettes
# distinct instead of allowing the generic identity lookup to merge them.
EXACT_ALIASES: dict[str, dict[str, str]] = {
    "mainBlade": {
        "ECLIPSE": "MainBladeEclipse_(Upper_Mode).png",
        "ECLIPSE#2": "MainBladeEclipse_(Smash_Mode).png",
        # The source dataset dropped the leading W from the English key.
        "RIGGLE": "MainBladeWriggle.png",
    },
    "assistBlade": {
        "D": "AssistBladeDual_(Upper_Mode).png",
        "D#2": "AssistBladeDual_(Smash_Mode).png",
        # These newly announced codes are not present in the phstudy code-name
        # table yet, but the Wiki already uses their official English names.
        "Q": "AssistBladeQuell.png",
    },
    "metalBlade": {"碾壓": "MetalBladeTread.png"},
    "overBlade": {"T": "OverBladeTough.png"},
}


def load_sticker_aliases() -> tuple[dict[str, str], dict[str, str]]:
    """Reuse the hand-audited Blade aliases maintained by fetch-stickers."""
    definitions = runpy.run_path(str(Path(__file__).with_name("fetch-stickers.py")))
    return definitions["BLADE_ALIASES"], definitions["LOCALIZED_ALIASES"]


BLADE_ALIASES, LOCALIZED_ALIASES = load_sticker_aliases()


def api(params: dict[str, str]) -> dict:
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    for attempt in range(5):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
            if attempt == 4:
                raise
            time.sleep(1.5 * (2**attempt))
    raise RuntimeError("unreachable")


def all_images(prefix: str) -> dict[str, dict]:
    """Read an entire MediaWiki allimages prefix, following continuation."""
    images: dict[str, dict] = {}
    continuation: str | None = None
    while True:
        params = {
            "action": "query",
            "list": "allimages",
            "aiprefix": prefix,
            "ailimit": "max",
            "aiprop": "url|size|mime",
        }
        if continuation:
            params["aicontinue"] = continuation
        payload = api(params)
        for image in payload["query"]["allimages"]:
            images[image["name"]] = image
        continuation = payload.get("continue", {}).get("aicontinue")
        if not continuation:
            return images


def chunks(values: Iterable[str], size: int) -> Iterable[list[str]]:
    batch: list[str] = []
    for value in values:
        batch.append(value)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def image_infos(filenames: Iterable[str]) -> dict[str, dict]:
    """Resolve exact aliases outside the normal allimages prefixes."""
    images: dict[str, dict] = {}
    for batch in chunks(sorted(set(filenames)), 40):
        payload = api(
            {
                "action": "query",
                "titles": "|".join("File:" + name for name in batch),
                "prop": "imageinfo",
                "iiprop": "url|size|mime",
            }
        )
        for page in payload["query"]["pages"].values():
            if "missing" in page or not page.get("imageinfo"):
                continue
            info = dict(page["imageinfo"][0])
            info["name"] = re.sub(r"^File:", "", page["title"])
            images[info["name"]] = info
    return images


def normalized(value: str) -> str:
    value = re.sub(r"#\d+$", "", value.strip())
    return re.sub(r"[^A-Za-z0-9]", "", value).upper()


def image_identity(filename: str, prefix: str) -> str:
    stem = re.sub(r"\.(?:png|webp|jpe?g)$", "", filename, flags=re.IGNORECASE)
    stem = re.sub(rf"^{re.escape(prefix)}[_ ]?", "", stem, flags=re.IGNORECASE)
    # Descriptors are generally colour coats or reversible modes.  Exact mode
    # aliases above win first; the clean identity remains a useful fallback.
    stem = re.sub(r"_\(.*\)$", "", stem)
    return normalized(stem)


def source_slug(filename: str, prefix: str) -> str:
    stem = re.sub(r"\.[^.]+$", "", filename)
    stem = re.sub(rf"^{re.escape(prefix)}[_ ]?", "", stem, flags=re.IGNORECASE)
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return slug or hashlib.sha1(filename.encode("utf-8")).hexdigest()[:10]


def name_candidates(part: dict, category: str, code_names: dict) -> list[str]:
    candidates = [
        str(part.get("group") or ""),
        str(part.get("key") or ""),
        str(part.get("code") or ""),
        str(part.get("name", {}).get("en") or ""),
    ]
    table_name = CODE_NAME_TABLES.get(category)
    if table_name:
        row = code_names.get(table_name, {}).get(str(part.get("code") or ""), {})
        candidates.insert(0, str(row.get("name", {}).get("en-US") or ""))
    if category == "blade":
        candidates += [LOCALIZED_ALIASES.get(value, "") for value in candidates]
    # Preserve order while removing empty/duplicate identities.
    out: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        identity = normalized(candidate)
        if identity and identity not in seen:
            seen.add(identity)
            out.append(candidate)
    return out


def preferred_lookups(images: dict[str, dict], prefix: str) -> dict[str, list[dict]]:
    lookup: dict[str, list[dict]] = {}
    for filename, info in images.items():
        lookup.setdefault(image_identity(filename, prefix), []).append(info)
    for values in lookup.values():
        values.sort(key=lambda info: ("_(" in info["name"], len(info["name"]), info["name"]))
    return lookup


def choose_identity_match(matches: list[dict], part: dict) -> dict:
    colour = normalized(str(part.get("color") or ""))
    if colour:
        colour_matches = [info for info in matches if colour in normalized(info["name"])]
        if colour_matches:
            return colour_matches[0]
    return matches[0]


def resolve_image(
    part: dict,
    category: str,
    images: dict[str, dict],
    exact_images: dict[str, dict],
    lookup: dict[str, list[dict]],
    code_names: dict,
) -> dict | None:
    key = str(part.get("key") or "")
    exact_name = EXACT_ALIASES.get(category, {}).get(key)
    if category == "blade":
        exact_name = BLADE_ALIASES.get(key, exact_name)
    if exact_name:
        info = images.get(exact_name) or exact_images.get(exact_name)
        if info:
            return info

    # Try the explicit prefix convention first: Ratchet3-60.png,
    # BitLowFlat.png, MainBladeDark.png, AssistBladeBumper.png, etc.
    casefold = {name.casefold(): info for name, info in images.items()}
    prefix = PREFIXES[category]
    candidates = name_candidates(part, category, code_names)
    for candidate in candidates:
        token = re.sub(r"[^A-Za-z0-9-]", "", re.sub(r"#\d+$", "", candidate))
        if not token:
            continue
        for extension in ("png", "PNG", "jpg", "jpeg", "webp"):
            info = casefold.get(f"{prefix}{token}.{extension}".casefold())
            if info:
                return info

    for candidate in candidates:
        matches = lookup.get(normalized(candidate))
        if matches:
            return choose_identity_match(matches, part)
    return None


def fetch_bytes(url: str) -> bytes:
    for attempt in range(5):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
            if attempt == 4:
                raise
            time.sleep(1.5 * (2**attempt))
    raise RuntimeError("unreachable")


def visible_bbox(image: Image.Image, threshold: int = ALPHA_THRESHOLD) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A").point(lambda value: 255 if value >= threshold else 0)
    return alpha.getbbox() or (0, 0, image.width, image.height)


def remove_connected_background(image: Image.Image) -> Image.Image:
    """Give the occasional opaque JPEG alias a transparent outer background."""
    image = image.convert("RGBA")
    if image.getchannel("A").getextrema()[0] < 250:
        return image

    # Limit the flood-fill cost; the final reference is only 512 px anyway.
    if max(image.size) > 1200:
        scale = 1200 / max(image.size)
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    rgb = image.convert("RGB")
    px = rgb.load()
    w, h = rgb.size
    corner_samples: list[tuple[int, int, int]] = []
    span = max(1, min(w, h) // 50)
    for x0, y0 in ((0, 0), (w - span, 0), (0, h - span), (w - span, h - span)):
        for y in range(y0, min(h, y0 + span)):
            for x in range(x0, min(w, x0 + span)):
                corner_samples.append(px[x, y])
    background = tuple(round(statistics.median(channel)) for channel in zip(*corner_samples))
    max_distance_sq = 34 * 34

    def is_background(x: int, y: int) -> bool:
        colour = px[x, y]
        return sum((colour[i] - background[i]) ** 2 for i in range(3)) <= max_distance_sq

    visited = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_background(x, y):
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_background(x, y):
                queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        index = y * w + x
        if visited[index] or not is_background(x, y):
            continue
        visited[index] = 1
        if x:
            queue.append((x - 1, y))
        if x + 1 < w:
            queue.append((x + 1, y))
        if y:
            queue.append((x, y - 1))
        if y + 1 < h:
            queue.append((x, y + 1))

    alpha = Image.new("L", (w, h), 255)
    alpha.putdata([0 if value else 255 for value in visited])
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.65))
    image.putalpha(alpha)
    return image


def normalize_reference(image: Image.Image) -> Image.Image:
    image = remove_connected_background(image)
    left, top, right, bottom = visible_bbox(image)
    crop = image.crop((left, top, right, bottom))
    available = ASSET_SIZE - 2 * ASSET_MARGIN
    scale = min(available / max(1, crop.width), available / max(1, crop.height))
    resized = crop.resize(
        (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
        Image.Resampling.LANCZOS,
    )
    result = Image.new("RGBA", (ASSET_SIZE, ASSET_SIZE))
    result.alpha_composite(
        resized,
        ((ASSET_SIZE - resized.width) // 2, (ASSET_SIZE - resized.height) // 2),
    )
    return result


def fill_circular_gaps(values: list[float]) -> list[float]:
    populated = [i for i, value in enumerate(values) if value > 0]
    if not populated:
        return [1.0] * len(values)
    out = values[:]
    n = len(values)
    for index, value in enumerate(values):
        if value > 0:
            continue
        before = next((step for step in range(1, n) if values[(index - step) % n] > 0), n)
        after = next((step for step in range(1, n) if values[(index + step) % n] > 0), n)
        a = values[(index - before) % n]
        b = values[(index + after) % n]
        out[index] = (a * after + b * before) / max(1, before + after)
    return out


def smooth(values: list[float], circular: bool, passes: int = 2) -> list[float]:
    out = values[:]
    weights = (1.0, 2.0, 3.0, 2.0, 1.0)
    radius = len(weights) // 2
    for _ in range(passes):
        nxt: list[float] = []
        for index in range(len(out)):
            total = 0.0
            weight_total = 0.0
            for offset, weight in enumerate(weights, -radius):
                source = index + offset
                if circular:
                    source %= len(out)
                elif source < 0 or source >= len(out):
                    continue
                total += out[source] * weight
                weight_total += weight
            nxt.append(total / weight_total)
        out = nxt
    return out


def radial_profile(image: Image.Image) -> list[float]:
    alpha = image.getchannel("A")
    left, top, right, bottom = visible_bbox(image)
    cx = (left + right - 1) / 2
    cy = (top + bottom - 1) / 2
    px = alpha.load()
    max_radius = math.ceil(math.hypot(max(cx - left, right - 1 - cx), max(cy - top, bottom - 1 - cy)))
    profile: list[float] = []
    # Cast one ray per requested sample from outside inward.  This produces
    # the same outer-alpha envelope as binning every opaque pixel, but avoids
    # hundreds of thousands of atan2/hypot calls per catalog entry.
    for index in range(RADIAL_SAMPLES):
        angle = index * 2 * math.pi / RADIAL_SAMPLES
        cos = math.cos(angle)
        sin = math.sin(angle)
        radius = 0.0
        for step in range(max_radius, -1, -1):
            x = round(cx + cos * step)
            y = round(cy - sin * step)  # image Y points down; output is counter-clockwise
            if left <= x < right and top <= y < bottom and px[x, y] >= ALPHA_THRESHOLD:
                radius = float(step)
                break
        profile.append(radius)
    profile = smooth(fill_circular_gaps(profile), circular=True)
    maximum = max(profile) or 1.0
    return [round(value / maximum, 5) for value in profile]


def side_profile(image: Image.Image) -> list[list[float]]:
    alpha = image.getchannel("A")
    left, top, right, bottom = visible_bbox(image)
    px = alpha.load()
    radii: list[float] = []
    band = max(1, math.ceil((bottom - top) / SIDE_SAMPLES / 2))
    for index in range(SIDE_SAMPLES):
        height = index / (SIDE_SAMPLES - 1)
        y0 = (bottom - 1) - height * max(1, bottom - top - 1)
        xs: list[int] = []
        for y in range(max(top, round(y0) - band), min(bottom, round(y0) + band + 1)):
            xs.extend(x for x in range(left, right) if px[x, y] >= ALPHA_THRESHOLD)
        radii.append((max(xs) - min(xs) + 1) / 2 if xs else 0.0)

    # Side silhouettes are not circular: extend the nearest valid radius into
    # sparse antialiased endpoint rows, then smooth along height.
    valid = [i for i, value in enumerate(radii) if value > 0]
    if not valid:
        radii = [1.0] * SIDE_SAMPLES
    else:
        for i in range(0, valid[0]):
            radii[i] = radii[valid[0]]
        for i in range(valid[-1] + 1, SIDE_SAMPLES):
            radii[i] = radii[valid[-1]]
        for i in range(valid[0] + 1, valid[-1]):
            if radii[i] == 0:
                radii[i] = (radii[i - 1] + next(r for r in radii[i + 1 :] if r > 0)) / 2
    radii = smooth(radii, circular=False)
    maximum = max(radii) or 1.0
    return [
        [round(radius / maximum, 5), round(index / (SIDE_SAMPLES - 1), 5)]
        for index, radius in enumerate(radii)
    ]


def dominant_colours(image: Image.Image, ignore_centre: bool) -> list[str]:
    sample = image.copy()
    sample.thumbnail((192, 192), Image.Resampling.LANCZOS)
    left, top, right, bottom = visible_bbox(sample)
    cx = (left + right - 1) / 2
    cy = (top + bottom - 1) / 2
    outer_radius = max(right - left, bottom - top) / 2
    pixels: list[tuple[int, int, int]] = []
    for y in range(top, bottom):
        for x in range(left, right):
            r, g, b, a = sample.getpixel((x, y))
            if a < 160:
                continue
            if ignore_centre and math.hypot(x - cx, y - cy) <= outer_radius * 0.45:
                continue
            pixels.append((r, g, b))
    if not pixels:
        return []

    strip = Image.new("RGB", (len(pixels), 1))
    strip.putdata(pixels)
    quantized = strip.quantize(colors=min(10, len(set(pixels))), method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette() or []
    counts = sorted(quantized.getcolors() or [], reverse=True)
    distinct: list[tuple[int, tuple[int, int, int]]] = []
    for count, palette_index in counts:
        offset = palette_index * 3
        colour = tuple(palette[offset : offset + 3])
        # Collapse illumination shades of one mould colour while preserving
        # genuinely different metal/plastic accents.
        if any(math.dist(colour, previous) < 48 for _, previous in distinct):
            continue
        distinct.append((count, colour))
    if not distinct and counts:
        offset = counts[0][1] * 3
        distinct.append((counts[0][0], tuple(palette[offset : offset + 3])))

    def saturation(colour: tuple[int, int, int]) -> float:
        high = max(colour)
        return (high - min(colour)) / high if high else 0.0

    chromatic = [item for item in distinct if saturation(item[1]) >= 0.18]
    neutral = [item for item in distinct if saturation(item[1]) < 0.18]
    if chromatic:
        chosen = chromatic[:2] + neutral[:1]
        for item in distinct:
            if len(chosen) == 3:
                break
            if item not in chosen:
                chosen.append(item)
        # Restore dominance order after reserving space for both the moulded
        # colour and the zinc/silver material on mixed upper parts.
        chosen.sort(key=lambda item: distinct.index(item))
    else:
        chosen = distinct[:3]
    selected = [colour for _, colour in chosen[:3]]
    return ["#%02x%02x%02x" % colour for colour in selected]


def wiki_file_url(filename: str) -> str:
    return "https://beyblade.fandom.com/wiki/File:" + urllib.parse.quote(filename)


def validate_outputs(manifest: dict, source_manifest: dict[str, dict]) -> None:
    referenced: set[str] = set()
    colour_pattern = re.compile(r"^#[0-9a-f]{6}$")
    entry_count = 0
    for category in CATEGORIES:
        for key, entry in manifest["parts"][category].items():
            entry_count += 1
            texture = entry["texture"]
            if not texture.startswith("assets/models/"):
                raise ValueError(f"{category}:{key}: invalid texture URL {texture!r}")
            filename = texture.removeprefix("assets/models/")
            referenced.add(filename)
            if filename not in source_manifest:
                raise ValueError(f"{category}:{key}: missing source record for {filename}")
            colours = entry["colors"]
            if not 1 <= len(colours) <= 3 or any(not colour_pattern.match(c) for c in colours):
                raise ValueError(f"{category}:{key}: invalid sampled colors {colours!r}")
            profile = entry["sideProfile"] if category == "bit" else entry["radialProfile"]
            expected = SIDE_SAMPLES if category == "bit" else RADIAL_SAMPLES
            if len(profile) != expected:
                raise ValueError(f"{category}:{key}: expected {expected} profile samples")
            radii = [point[0] for point in profile] if category == "bit" else profile
            if any(not math.isfinite(value) or value < 0 or value > 1 for value in radii):
                raise ValueError(f"{category}:{key}: profile radius outside [0, 1]")
            if abs(max(radii) - 1) > 1e-5:
                raise ValueError(f"{category}:{key}: profile maximum is not normalized")
            if category == "bit":
                heights = [point[1] for point in profile]
                if heights[0] != 0 or heights[-1] != 1 or heights != sorted(heights):
                    raise ValueError(f"{category}:{key}: side-profile heights are not bottom-to-top")

    if referenced != set(source_manifest):
        raise ValueError("source manifest and model manifest reference different asset sets")
    for filename in referenced:
        path = OUT_DIR / filename
        with Image.open(path) as image:
            if image.size != (ASSET_SIZE, ASSET_SIZE):
                raise ValueError(f"{filename}: expected {ASSET_SIZE}x{ASSET_SIZE}")
            rgba = image.convert("RGBA")
            alpha_min, alpha_max = rgba.getchannel("A").getextrema()
            if alpha_min != 0 or alpha_max < 240:
                raise ValueError(f"{filename}: reference does not have a usable transparent alpha channel")
    print(f"Validated {entry_count} manifest entries and {len(referenced)} WebP assets", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="redownload and rebuild existing WebPs")
    args = parser.parse_args()

    db = json.loads(PARTS_PATH.read_text(encoding="utf-8"))
    code_names = json.loads(CODE_NAMES_PATH.read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    images_by_category: dict[str, dict[str, dict]] = {}
    print("Querying Beyblade Wiki image catalog...", flush=True)
    for category in CATEGORIES:
        prefix = PREFIXES[category]
        images_by_category[category] = all_images(prefix)
        print(f"  {prefix}: {len(images_by_category[category])} files", flush=True)

    exact_names = set(BLADE_ALIASES.values())
    for aliases in EXACT_ALIASES.values():
        exact_names.update(aliases.values())
    # An alias may deliberately cross prefixes (Bullet Griffon and Glory
    # Valkyrie are filed as RatchetBlade images, for example), so expose the
    # complete already-fetched catalog to exact-name resolution.
    exact_images = {
        name: info for images in images_by_category.values() for name, info in images.items()
    }
    exact_images.update(image_infos(exact_names - set(exact_images)))

    lookups = {
        category: preferred_lookups(images_by_category[category], PREFIXES[category])
        for category in CATEGORIES
    }
    resolved: dict[str, list[tuple[dict, dict]]] = {category: [] for category in CATEGORIES}
    for category in CATEGORIES:
        for part in db["parts"][category]:
            info = resolve_image(
                part,
                category,
                images_by_category[category],
                exact_images,
                lookups[category],
                code_names,
            )
            if info is not None:
                resolved[category].append((part, info))

    # Assign names before downloads so network transfers can overlap while
    # profiles are extracted sequentially.  Eight workers keeps the public
    # CDN load modest while avoiding a several-minute latency-bound pass.
    source_categories: dict[str, str] = {}
    source_infos: dict[str, dict] = {}
    for category in CATEGORIES:
        for _, info in resolved[category]:
            source_categories.setdefault(info["name"], category)
            source_infos.setdefault(info["name"], info)
    planned_assets: dict[str, str] = {}
    planned_names: dict[str, str] = {}
    for source_name, category in source_categories.items():
        base = f"{ASSET_PREFIXES[category]}-{source_slug(source_name, PREFIXES[category])}.webp"
        previous = planned_names.get(base)
        if previous and previous != source_name:
            digest = hashlib.sha1(source_name.encode("utf-8")).hexdigest()[:8]
            base = base.removesuffix(".webp") + f"-{digest}.webp"
        planned_names[base] = source_name
        planned_assets[source_name] = base

    executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="model-reference")
    download_futures: dict[str, Future[bytes]] = {}
    for source_name, category in source_categories.items():
        asset_path = OUT_DIR / planned_assets[source_name]
        if args.force or not asset_path.exists():
            info = source_infos[source_name]
            download_futures[source_name] = executor.submit(fetch_bytes, info["url"])

    manifest: dict = {
        "schemaVersion": 1,
        "radialSamples": RADIAL_SAMPLES,
        "sideSamples": SIDE_SAMPLES,
        "parts": {category: {} for category in CATEGORIES},
    }
    source_manifest: dict[str, dict] = {}
    source_assets: dict[str, tuple[str, Image.Image]] = {}
    coverage: dict[str, int] = {category: 0 for category in CATEGORIES}

    def asset_for(info: dict, category: str) -> tuple[str, Image.Image]:
        source_name = info["name"]
        cached = source_assets.get(source_name)
        if cached:
            return cached
        base = planned_assets[source_name]
        path = OUT_DIR / base
        if args.force or not path.exists():
            future = download_futures[source_name]
            source = Image.open(io.BytesIO(future.result())).convert("RGBA")
            reference = normalize_reference(source)
            # Method 4 retains the same quality target while keeping a full
            # catalog rebuild practical; method 6 takes several seconds per
            # 512 px asset for only a small file-size improvement.
            reference.save(path, "WEBP", quality=92, method=4, exact=True)
            download_futures.pop(source_name, None)
        else:
            reference = Image.open(path).convert("RGBA")
        source_assets[source_name] = (base, reference)
        source_manifest[base] = {
            "source": wiki_file_url(source_name),
            "original": info["url"],
            "width": info.get("width"),
            "height": info.get("height"),
            "parts": [],
        }
        print(f"  asset {base}", flush=True)
        return base, reference

    for category in CATEGORIES:
        for part, info in resolved[category]:
            try:
                asset_name, reference = asset_for(info, category)
            except Exception as exc:  # keep a long catalog pass useful if one CDN file fails
                print(f"WARN {category}:{part['key']}: {exc}", flush=True)
                continue
            entry: dict = {
                "texture": "assets/models/" + asset_name,
                "colors": dominant_colours(reference, ignore_centre=category in UPPER_CATEGORIES),
            }
            if category == "bit":
                entry["sideProfile"] = side_profile(reference)
            else:
                entry["radialProfile"] = radial_profile(reference)
            manifest["parts"][category][part["key"]] = entry
            source_manifest[asset_name]["parts"].append(f"{category}:{part['key']}")
            coverage[category] += 1

    executor.shutdown(wait=True, cancel_futures=False)

    # Stable output makes review diffs about assets/profiles, not query order.
    for source in source_manifest.values():
        source["parts"].sort()
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    SOURCES_PATH.write_text(
        json.dumps(dict(sorted(source_manifest.items())), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    validate_outputs(manifest, source_manifest)

    print("Coverage:", flush=True)
    for category in CATEGORIES:
        total = len(db["parts"][category])
        print(f"  {category}: {coverage[category]}/{total}", flush=True)
    print(
        f"Wrote {len(source_manifest)} normalized reference textures and {MANIFEST_PATH}",
        flush=True,
    )


if __name__ == "__main__":
    main()
