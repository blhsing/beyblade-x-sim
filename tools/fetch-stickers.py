"""Build the in-game Beyblade X sticker atlas from Beyblade Wiki artwork.

The wiki's part images are transparent, top-down photographs/renders.  BX/UX
sticker art is the circular centre of each Blade image; CX artwork is already
published as an isolated Lock Chip image.  This script downloads those source
files through MediaWiki's public API, extracts the relevant centre artwork,
and emits compact WebP textures plus the exact part-key manifest consumed by
the renderer.

Run from the repository root:

    python tools/fetch-stickers.py
"""

from __future__ import annotations

import io
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
PARTS_PATH = ROOT / "app" / "public" / "data" / "parts.json"
OUT_DIR = ROOT / "app" / "public" / "assets" / "stickers"
MANIFEST_PATH = ROOT / "app" / "src" / "render" / "sticker-manifest.json"
API = "https://beyblade.fandom.com/api.php"
USER_AGENT = "BeybladeXSim/0.1 (sticker asset builder)"

# Names in the source DB occasionally use a translated name, a legacy typo,
# or a compound CX name.  Point those at the Wiki's canonical Blade file.
BLADE_ALIASES: dict[str, str] = {
    "HELLSHUMMER": "BladeHellsHammer.png",
    "LIGHTNING L-DRAGO": "BladeLightningL-Drago(Rapid-HitType).png",
    "LIGHTNING L-DRAGO#2": "BladeLightningL-Drago(UpperType).png",
    "WARRIORSABER": "BladeSamuraiSaber.png",
    "WARRIORSABER#2": "BladeSamuraiSaber.png",
    "SHINOBIKNIFE": "BladeKnifeShinobi.png",
    "SAMURAISTEEL": "BladeSteelSamurai.png",
    "BEYBLADEBURST": "BladeStormSpriggan.png",
    # The isolated Blade file is listed on the page but no longer exists in
    # the Wiki repository; the product page's top-down layer image preserves
    # the same central V emblem.
    "VICTORYVALKYRIE": "VictoryValkyrie 2-60RA.jpeg",
    "BULLETGRIFFON": "RatchetBladeBulletGriffon.png",
    "GLORYVALKYRIE": "RatchetBladeGloryValkyrie.png",
    "HELLSNETHER": "RatchetBladeHellsNether.png",
    "HELLSNETHER#2": "RatchetBladeHellsNether.png",
    "蒼龍爆刃 鍍金版": "BladeDranBuster.png",
    "蒼龍爆刃 鍍銀版": "BladeDranBuster.png",
    "蒼龍爆刃 鍍銅版": "BladeDranBuster.png",
}

# The app's localized collaboration entries do not carry English names in
# parts.json.  These aliases let any matching Wiki artwork be picked up when
# it is present, without inventing a replacement emblem.
LOCALIZED_ALIASES: dict[str, str] = {
    "鋼鐵人": "IRONMAN",
    "薩諾斯": "THANOS",
    "蜘蛛人": "SPIDERMAN",
    "猛毒": "VENOM",
    "路克天行者": "LUKESKYWALKER",
    "達斯維達": "DARTHVADER",
    "曼達洛人": "THEMANDALORIAN",
    "星區長吉迪恩": "MOFFGIDEON",
    "柯博文": "OPTIMUSPRIME",
    "密卡登": "MEGATRON",
    "金剛王": "OPTIMALPRIMAL",
    "天王星": "STARSCREAM",
    "暴龍": "TYRANNOSAURUS",
    "滄龍": "MOSASAURUS",
    "翼龍": "PTERANODON",
    "棘龍": "SPINOSAURUS",
    "歐比王肯諾比": "OBIWANKENOBI",
    "葛里維斯將軍": "GENERALGRIEVOUS",
    "丘巴卡": "CHEWBACCA",
    "風暴兵": "STORMTROOPER",
    "美國隊長": "CAPTAINAMERICA",
    "紅浩克": "REDHULK",
    "終極蜘蛛人": "MILESMORALES",
    "綠惡魔": "GREENGOBLIN",
}

LOCK_CHIP_ALIASES: dict[str, str] = {
    "BUCKS": "LockChipStag.png",
    "福音戰士": "LockChipEvaUnit-01.png",
    "迪卡": "LockChipTiga_(Red).png",
    "鱷魚": "LockChipCroco.png",
}


def api(params: dict[str, str]) -> dict:
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def all_images(prefix: str) -> dict[str, dict]:
    payload = api(
        {
            "action": "query",
            "list": "allimages",
            "aiprefix": prefix,
            "ailimit": "max",
            "aiprop": "url|size",
        }
    )
    return {image["name"]: image for image in payload["query"]["allimages"]}


def image_infos(filenames: set[str]) -> dict[str, dict]:
    """Resolve explicitly known files that sit outside the Blade prefix."""
    payload = api(
        {
            "action": "query",
            "titles": "|".join("File:" + name for name in sorted(filenames)),
            "prop": "imageinfo",
            "iiprop": "url|size",
        }
    )
    images: dict[str, dict] = {}
    for page in payload["query"]["pages"].values():
        if "missing" in page or not page.get("imageinfo"):
            continue
        info = dict(page["imageinfo"][0])
        info["name"] = re.sub(r"^File:", "", page["title"])
        images[info["name"]] = info
    return images


def normalized(value: str) -> str:
    value = re.sub(r"#\d+$", "", value)
    return re.sub(r"[^A-Za-z0-9]", "", value).upper()


def image_identity(filename: str, prefix: str) -> str:
    stem = re.sub(r"\.(?:png|jpe?g)$", "", filename, flags=re.IGNORECASE)
    stem = re.sub(rf"^{prefix}[_ ]?", "", stem, flags=re.IGNORECASE)
    # Colour variants have descriptive suffixes.  Prefer the clean canonical
    # file but make these usable as a last resort for newly listed parts.
    stem = re.sub(r"_\(.*\)$", "", stem)
    return normalized(stem)


def download(url: str) -> Image.Image:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=90) as response:
        return Image.open(io.BytesIO(response.read())).convert("RGBA")


def visible_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    return bbox if bbox else (0, 0, image.width, image.height)


def blade_sticker(image: Image.Image) -> Image.Image:
    """Extract the round sticker printed at the centre of a Blade image."""
    left, top, right, bottom = visible_bbox(image)
    width, height = right - left, bottom - top
    cx, cy = (left + right) / 2, (top + bottom) / 2
    # Across BX and UX product photography the sticker is about 42% of the
    # blade diameter.  A small inward crop avoids including the surrounding
    # coloured plastic lip while preserving the sticker's printed rim.
    side = min(width, height) * 0.425
    box = (
        round(cx - side / 2),
        round(cy - side / 2),
        round(cx + side / 2),
        round(cy + side / 2),
    )
    return image.crop(box).resize((512, 512), Image.Resampling.LANCZOS)


def lock_chip_sticker(image: Image.Image) -> Image.Image:
    """Square and resize an already isolated CX Lock Chip image."""
    left, top, right, bottom = visible_bbox(image)
    width, height = right - left, bottom - top
    side = max(width, height)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    pad = Image.new("RGBA", (round(side), round(side)))
    crop = image.crop((left, top, right, bottom))
    pad.alpha_composite(crop, (round((side - width) / 2), round((side - height) / 2)))
    return pad.resize((512, 512), Image.Resampling.LANCZOS)


def save_texture(image: Image.Image, filename: str) -> str:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / filename
    image.save(path, "WEBP", quality=92, method=6, exact=True)
    return "/assets/stickers/" + filename


def preferred_lookup(images: dict[str, dict], prefix: str) -> dict[str, dict]:
    lookup: dict[str, dict] = {}
    # Clean canonical filenames win over Metal Coat/promotional variants.
    for filename, info in sorted(images.items(), key=lambda item: ("_(" in item[0], len(item[0]))):
        lookup.setdefault(image_identity(filename, prefix), info)
    return lookup


def main() -> None:
    db = json.loads(PARTS_PATH.read_text(encoding="utf-8"))
    blade_images = all_images("Blade")
    blade_images.update(image_infos(set(BLADE_ALIASES.values()) - set(blade_images)))
    chip_images = all_images("LockChip")
    blade_by_name = preferred_lookup(blade_images, "Blade")
    chip_by_name = preferred_lookup(chip_images, "LockChip")

    manifest: dict[str, dict[str, str]] = {"blades": {}, "lockChips": {}}
    source_manifest: dict[str, dict[str, str]] = {}
    written: dict[str, str] = {}

    for part in db["parts"]["blade"]:
        key = part["key"]
        info = None
        alias_filename = BLADE_ALIASES.get(key)
        if alias_filename:
            info = blade_images.get(alias_filename)
        if info is None:
            candidates = [key, part.get("code", ""), part.get("name", {}).get("en", "")]
            candidates += [LOCALIZED_ALIASES.get(value, "") for value in candidates]
            for candidate in candidates:
                identity = normalized(candidate)
                if identity and identity in blade_by_name:
                    info = blade_by_name[identity]
                    break
        if info is None:
            continue

        filename = "blade-" + image_identity(info["name"], "Blade").lower() + ".webp"
        url = written.get(info["name"])
        if url is None:
            path = OUT_DIR / filename
            url = "/assets/stickers/" + filename
            if not path.exists():
                url = save_texture(blade_sticker(download(info["url"])), filename)
            written[info["name"]] = url
            source_manifest[filename] = {
                "source": "https://beyblade.fandom.com/wiki/File:" + urllib.parse.quote(info["name"]),
                "original": info["url"],
            }
        manifest["blades"][key] = url

    for part in db["parts"]["lockChip"]:
        key = part["key"]
        candidates = [key, part.get("code", ""), part.get("name", {}).get("en", "")]
        info = chip_images.get(LOCK_CHIP_ALIASES.get(key, ""))
        for candidate in candidates:
            identity = normalized(candidate)
            if identity and identity in chip_by_name:
                info = chip_by_name[identity]
                break
        if info is None:
            continue

        filename = "chip-" + image_identity(info["name"], "LockChip").lower() + ".webp"
        url = written.get(info["name"])
        if url is None:
            path = OUT_DIR / filename
            url = "/assets/stickers/" + filename
            if not path.exists():
                url = save_texture(lock_chip_sticker(download(info["url"])), filename)
            written[info["name"]] = url
            source_manifest[filename] = {
                "source": "https://beyblade.fandom.com/wiki/File:" + urllib.parse.quote(info["name"]),
                "original": info["url"],
            }
        manifest["lockChips"][key] = url

    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (OUT_DIR / "sources.json").write_text(
        json.dumps(source_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"Wrote {len(written)} textures: "
        f"{len(manifest['blades'])}/{len(db['parts']['blade'])} Blade entries, "
        f"{len(manifest['lockChips'])}/{len(db['parts']['lockChip'])} Lock Chips"
    )


if __name__ == "__main__":
    main()
