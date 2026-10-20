#!/usr/bin/env python3
"""Representation-only export of the final R236 NIHO 3 owned coefficients.

The asset source directory is the immutable round226 frozen candidate because
R236 retains those exact coefficient files and changes only profile operation
order. The final R236 freeze.json SHA-256 is
7be32b33da0a8a240ed14418bfb37d64a19a47b1eaa1e8655d50077597991b2d.
This script does not fit, round, or otherwise change coefficients; hashes fail
closed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np


EXPECTED = {
    "features": "32ffd22017f6d42155fc6826c2f9def0cfcffd895b8a1a89d841d5b87f88277a",
    "highlight": "8043fdd763326d1255c45d65636c6613ec4c7698cbc8268b1880cd4b58af00ee",
    "shadow": "dbef6b8c687412852e6001282ebec50ce92b5830fbcc411b85ee51da461c20bc",
    "vibrance": "184866b289e8c8195f44b3f14b14f59329106d9467b782185b70ab19e09e7c56",
    "profile": "a6ad1ea8f7861edace9a871e8d87798022f96c9fa64b7127981f465cdb66f887",
}
LAYOUT = [[26, 24], [24], [24, 16], [16], [16, 2], [2]]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked(path: Path, expected: str) -> Path:
    actual = digest(path)
    if actual != expected:
        raise ValueError(f"hash mismatch for {path}: {actual}")
    return path


def model(path: Path, expected: str) -> dict[str, object]:
    checked(path, expected)
    with np.load(path) as source:
        if set(source.files) != {"weights", "mean", "scale"}:
            raise ValueError(f"unexpected arrays in {path}: {source.files}")
        weights, mean, scale = source["weights"], source["mean"], source["scale"]
        if weights.shape != (1082,) or mean.shape != (26,) or scale.shape != (26,):
            raise ValueError(f"unexpected shapes in {path}")
        if any(a.dtype != np.float64 for a in (weights, mean, scale)):
            raise ValueError(f"unexpected dtype in {path}")
        return {
            "sourceSha256": expected,
            "weights": weights.tolist(),
            "mean": mean.tolist(),
            "scale": scale.tolist(),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("frozen_assets_candidate", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    frozen = args.frozen_assets_candidate
    assets = frozen / "assets"
    destination = args.output
    destination.mkdir(parents=True, exist_ok=True)

    features = checked(assets / "round100_features.py", EXPECTED["features"])
    payload = {
        "schema": "niho.raw-response-models.v2",
        "layout": LAYOUT,
        "featureSourceSha256": digest(features),
        "highlight": model(
            assets / "round181-range8-highlights/model.npz", EXPECTED["highlight"]
        ),
        "shadow": model(
            assets / "round205-matched-shadows/model.npz", EXPECTED["shadow"]
        ),
    }
    (destination / "response-models.json").write_text(
        json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n",
        encoding="utf-8",
    )

    for name, relative, expected in [
        ("vibrance-delta-sqrt33.f32", "round65-vibrance-lut/delta-sqrt33.f32", EXPECTED["vibrance"]),
        ("profile-delta-srgb9.f32", "round218-profile-pairs/delta-srgb9.f32", EXPECTED["profile"]),
    ]:
        source = checked(assets / relative, expected)
        (destination / name).write_bytes(source.read_bytes())


if __name__ == "__main__":
    main()
