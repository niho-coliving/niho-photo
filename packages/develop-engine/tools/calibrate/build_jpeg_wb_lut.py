#!/usr/bin/env python3
"""Build NIHO's JPEG incremental-WB delta LUT from synthetic round11b exports.

Usage:
  python3 build_jpeg_wb_lut.py <private-round11b-dir> [--check]

The input directory contains ``manifest.json`` and ``lr-export-jpeg/``.  The
output is a headerless, little-endian array in VARIANT_ORDER: 10 variants x
17^3 RGB nodes x signed i16, where one unit is 1/16 of an encoded-sRGB byte.
Only synthetic chart measurements are encoded; source JPEGs are never copied.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Any

LEVELS = [round(i * 255 / 16) for i in range(17)]
PATCH = 12
COLUMNS = 71
NODE_COUNT = len(LEVELS) ** 3
ROWS = (NODE_COUNT + COLUMNS - 1) // COLUMNS
SIZE = (COLUMNS * PATCH, ROWS * PATCH)

# Binary table order.  Keep in sync with crates/niho-develop/src/jpeg_wb.rs.
VARIANT_ORDER = (
    "temp_m80",
    "temp_m30",
    "temp_p30",
    "temp_p80",
    "tint_m50",
    "tint_m20",
    "tint_p20",
    "tint_p50",
    "wb_cool",
    "wb_warm",
)
EXPECTED_SETTINGS: dict[str, dict[str, str]] = {
    "neutral": {},
    "temp_m80": {"WhiteBalance": "Custom", "IncrementalTemperature": "-80", "IncrementalTint": "0"},
    "temp_m30": {"WhiteBalance": "Custom", "IncrementalTemperature": "-30", "IncrementalTint": "0"},
    "temp_p30": {"WhiteBalance": "Custom", "IncrementalTemperature": "+30", "IncrementalTint": "0"},
    "temp_p80": {"WhiteBalance": "Custom", "IncrementalTemperature": "+80", "IncrementalTint": "0"},
    "tint_m50": {"WhiteBalance": "Custom", "IncrementalTemperature": "0", "IncrementalTint": "-50"},
    "tint_m20": {"WhiteBalance": "Custom", "IncrementalTemperature": "0", "IncrementalTint": "-20"},
    "tint_p20": {"WhiteBalance": "Custom", "IncrementalTemperature": "0", "IncrementalTint": "+20"},
    "tint_p50": {"WhiteBalance": "Custom", "IncrementalTemperature": "0", "IncrementalTint": "+50"},
    "wb_cool": {"WhiteBalance": "Custom", "IncrementalTemperature": "-30", "IncrementalTint": "-20"},
    "wb_warm": {"WhiteBalance": "Custom", "IncrementalTemperature": "+30", "IncrementalTint": "+20"},
}
DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "calibration" / "jpeg-incremental-wb-v1.bin"


def fail(message: str) -> None:
    raise SystemExit(f"jpeg WB LUT: {message}")


def number(value: Any, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        fail(f"{label} is not numeric: {value!r}")
    if not result == result or result in (float("inf"), float("-inf")):
        fail(f"{label} is not finite: {value!r}")
    return result


def xmp_description(image: Any, filename: str) -> dict[str, Any]:
    """Return Pillow's flattened rdf:Description from the embedded XMP."""
    try:
        xmp = image.getxmp()
        description = xmp["xmpmeta"]["RDF"]["Description"]
    except (AttributeError, KeyError, TypeError):
        fail(f"{filename}: embedded XMP rdf:Description is missing")
    if not isinstance(description, dict):
        fail(f"{filename}: embedded XMP rdf:Description is not an object")
    return description


def expected_export_settings(variant: str) -> dict[str, Any]:
    nominal = EXPECTED_SETTINGS[variant]
    if variant == "neutral":
        return {
            "AlreadyApplied": True,
            "WhiteBalance": "As Shot",
            "IncrementalTemperature": 0.0,
            "IncrementalTint": 0.0,
        }
    # Lightroom 9.3 normalizes the four temperature-only exports from tint 0
    # to tint +1.  build() removes that measured +1 response below.
    tint = (
        1.0
        if variant.startswith("temp_")
        else number(nominal["IncrementalTint"], variant)
    )
    return {
        "AlreadyApplied": True,
        "WhiteBalance": "Custom",
        "IncrementalTemperature": number(nominal["IncrementalTemperature"], variant),
        "IncrementalTint": tint,
    }


def validate_xmp(description: dict[str, Any], variant: str, filename: str) -> None:
    expected = expected_export_settings(variant)
    for key, wanted in expected.items():
        if key not in description:
            fail(f"{filename}: XMP {key} is missing")
        actual = description[key]
        if isinstance(wanted, bool):
            normalized = actual is True or str(actual).strip().lower() == "true"
            if normalized != wanted:
                fail(f"{filename}: XMP {key}={actual!r}, expected True")
        elif isinstance(wanted, float):
            if number(actual, f"{filename}: XMP {key}") != wanted:
                fail(f"{filename}: XMP {key}={actual!r}, expected {wanted:g}")
        elif actual != wanted:
            fail(f"{filename}: XMP {key}={actual!r}, expected {wanted!r}")
    for unexpected in ("Temperature", "Tint"):
        if unexpected in description:
            fail(f"{filename}: unexpected absolute XMP {unexpected}")


def patch_sums(image: Any) -> list[tuple[int, int, int]]:
    pixels = image.load()
    result: list[tuple[int, int, int]] = []
    for index in range(NODE_COUNT):
        x = (index % COLUMNS) * PATCH
        y = (index // COLUMNS) * PATCH
        sums = [0, 0, 0]
        for yy in range(y + 4, y + 8):
            for xx in range(x + 4, x + 8):
                pixel = pixels[xx, yy]
                for channel in range(3):
                    sums[channel] += pixel[channel]
        result.append((sums[0], sums[1], sums[2]))
    return result


def round_fraction(value: Fraction) -> int:
    """Nearest integer, with an exact half rounded away from zero."""
    sign = -1 if value < 0 else 1
    value = abs(value)
    quotient, remainder = divmod(value.numerator, value.denominator)
    return sign * (quotient + int(remainder * 2 >= value.denominator))


def read_inputs(round_dir: Path) -> dict[str, list[tuple[int, int, int]]]:
    try:
        manifest = json.loads((round_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read manifest.json: {error}")
    entries = manifest.get("variants") if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or len(entries) != len(EXPECTED_SETTINGS):
        fail(f"manifest must contain exactly {len(EXPECTED_SETTINGS)} variants")
    by_variant: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("variant"), str):
            fail("manifest variant entry is invalid")
        variant = entry["variant"]
        if variant in by_variant:
            fail(f"manifest contains duplicate variant {variant}")
        filename = entry.get("file")
        if not isinstance(filename, str) or Path(filename).name != filename:
            fail(f"manifest {variant}.file must be a filename")
        by_variant[variant] = entry
    if set(by_variant) != set(EXPECTED_SETTINGS):
        fail(f"manifest variants differ: {sorted(by_variant)}")

    exports = round_dir / "lr-export-jpeg"
    expected_files = {entry["file"] for entry in by_variant.values()}
    actual_files = {path.name for path in exports.glob("*.jpg")}
    if actual_files != expected_files:
        fail(
            f"export JPEG count/names differ: expected {sorted(expected_files)}, "
            f"got {sorted(actual_files)}"
        )

    from PIL import Image

    samples: dict[str, list[tuple[int, int, int]]] = {}
    full_pixels: dict[str, bytes] = {}
    for variant in ("neutral", *VARIANT_ORDER):
        entry = by_variant[variant]
        filename = entry["file"]
        if entry.get("settings") != EXPECTED_SETTINGS[variant]:
            fail(f"manifest {variant}.settings does not match the nominal measurement")
        path = exports / filename
        try:
            with Image.open(path) as source:
                source.load()
                if source.format != "JPEG" or source.size != SIZE:
                    fail(
                        f"{filename}: expected JPEG {SIZE[0]}x{SIZE[1]}, "
                        f"got {source.format} {source.size}"
                    )
                validate_xmp(xmp_description(source, filename), variant, filename)
                image = source.convert("RGB")
                full_pixels[variant] = image.tobytes()
                samples[variant] = patch_sums(image)
        except OSError as error:
            fail(f"cannot read {path}: {error}")

    neutral = full_pixels["neutral"]
    for variant in VARIANT_ORDER:
        if full_pixels[variant] == neutral:
            fail(f"{variant}: exported pixels are identical to neutral")
    return samples


def build(samples: dict[str, list[tuple[int, int, int]]]) -> bytes:
    neutral = samples["neutral"]
    tint_p20 = samples["tint_p20"]
    output = bytearray()
    for variant in VARIANT_ORDER:
        nodes = zip(samples[variant], neutral, tint_p20)
        for node, (measured, base, tint20) in enumerate(nodes):
            for channel in range(3):
                # Each patch has 16 sampled pixels.  Therefore
                # (average(measured)-average(neutral))*16 is the exact integer
                # sum difference.  Temperature-only exports also contain the
                # normalized +1 tint, measured as 1/20 of tint_p20's delta.
                fixed = Fraction(measured[channel] - base[channel], 1)
                if variant.startswith("temp_"):
                    fixed -= Fraction(tint20[channel] - base[channel], 20)
                encoded = round_fraction(fixed)
                if not -32768 <= encoded <= 32767:
                    fail(f"{variant} node {node} channel {channel}: i16 overflow {encoded}")
                output.extend(struct.pack("<h", encoded))
    expected_bytes = len(VARIANT_ORDER) * NODE_COUNT * 3 * 2
    if len(output) != expected_bytes:
        fail(f"internal size mismatch: {len(output)} != {expected_bytes}")
    return bytes(output)


def write_or_check(data: bytes, output: Path, check: bool) -> None:
    digest = hashlib.sha256(data).hexdigest()
    if check:
        try:
            current = output.read_bytes()
        except OSError as error:
            fail(f"cannot check {output}: {error}")
        if current != data:
            fail(f"{output} is stale (generated sha256 {digest})")
        print(f"ok: {output} ({len(data)} bytes, sha256 {digest})")
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.chmod(temporary, 0o644)
        os.replace(temporary, output)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    print(f"wrote {output} ({len(data)} bytes, sha256 {digest})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("round_dir", type=Path, help="private round11b directory")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the checked-in asset without writing",
    )
    args = parser.parse_args()
    write_or_check(build(read_inputs(args.round_dir)), args.output, args.check)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
