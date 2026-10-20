#!/usr/bin/env python3
"""Renders the RAW working-copy golden references (macOS only).

Usage:
  NIHO_RAW_GOLDEN_DIR=<out> python3 scripts/golden/make_raw_references.py

Environment:
  NIHO_RAW_GOLDEN_DIR   output (required; not committed: the RAWs are the
                        owner's photos). The crate's test reads it:
                        `cargo test --release -p niho-develop --test golden_raw -- --ignored --nocapture`.
  PHOTOBENCH_DIR        Photo Bench's repo (default: the hihirohub volume). Its
                        dist/engine/MacOS/photobench-engine must be built from
                        the same commit as its sources (checked via `hello`).
  NIHO_RAW_SOURCE_DIR   the RAWs and sidecars (default: round5's round5-photos).
  NIHO_RAW_SCENES       comma-separated subset of raw_cases.json's scenes.

For every scene of scripts/golden/raw_cases.json:
  <out>/<scene>/wc/   photobench-engine `renderWorkingCopy` (macOS RAW, linear
                      ProPhoto, long edge 2560, 16-bit PNG) as wc.png + wc.json
                      (its meta), wc.f32 (the same pixels before the PNG
                      quantization) and one 16-bit sRGB PNG per 'wc' case,
                      rendered by Photo Bench's RAW production path from that
                      working copy (scripts/golden/raw_reference.swift).
  <out>/<scene>/dcp/  Photo Bench's LibRaw + Adobe DCP working copy (Stage H
                      output, before exposure) and the 'dcp' cases rendered
                      from it, including the absolute white balance.
  <out>/<scene>/<set>/cases.json  the exact EditSettings sent (Photo Bench's
                      `presetSettings` of the sidecar for 'xmp' cases).
raw_reference.swift is built against PHOTOBENCH_DIR (swift build, release,
-enable-testing for its `@testable import PhotoCore`) in <out>/.build-raw-reference.
"""
import json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PHOTOBENCH_DIR = os.environ.get("PHOTOBENCH_DIR", "OWNER_DATA_ROOT")
ENGINE = os.path.join(PHOTOBENCH_DIR, "dist/engine/MacOS/photobench-engine")
SOURCE_DIR = os.environ.get(
    "NIHO_RAW_SOURCE_DIR", os.path.join(PHOTOBENCH_DIR, "exports/lr-measure/round5/round5-photos")
)

sys.path.insert(0, HERE)
from make_references import Engine  # noqa: E402

PACKAGE = """// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RawReference",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: {photobench})],
    targets: [
        .executableTarget(
            name: "raw-reference",
            dependencies: [.product(name: "PhotoCore", package: {identity})],
            path: "Sources/raw-reference"
        )
    ],
    swiftLanguageModes: [.v5]
)
"""


def build_harness(build_dir):
    src = os.path.join(build_dir, "Sources/raw-reference")
    os.makedirs(src, exist_ok=True)
    with open(os.path.join(build_dir, "Package.swift"), "w") as f:
        f.write(
            PACKAGE.replace("{photobench}", json.dumps(PHOTOBENCH_DIR)).replace(
                "{identity}", json.dumps(os.path.basename(PHOTOBENCH_DIR.rstrip("/")).lower())
            )
        )
    shutil.copyfile(os.path.join(HERE, "raw_reference.swift"), os.path.join(src, "main.swift"))
    subprocess.run(
        ["swift", "build", "-c", "release", "-Xswiftc", "-enable-testing", "--package-path", build_dir],
        check=True,
    )
    out = subprocess.run(
        ["swift", "build", "-c", "release", "-Xswiftc", "-enable-testing", "--package-path", build_dir, "--show-bin-path"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return os.path.join(out, "raw-reference")


def photobench_commit():
    return subprocess.run(
        ["git", "-C", PHOTOBENCH_DIR, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()


def settings_for(engine, scene, case):
    settings = {}
    if "xmp" in case:
        xmp = open(os.path.join(SOURCE_DIR, f"p5_{scene}_{case['xmp']}.xmp")).read()
        settings = engine.call("presetSettings", {"xmp": xmp})["settings"]
    settings.update(case.get("settings", {}))
    return settings


def main():
    out_dir = os.environ.get("NIHO_RAW_GOLDEN_DIR")
    if not out_dir:
        sys.exit("NIHO_RAW_GOLDEN_DIR is required (the references are not committed)")
    cases = json.load(open(os.path.join(HERE, "raw_cases.json")))
    scenes = cases["scenes"]
    if os.environ.get("NIHO_RAW_SCENES"):
        scenes = [s for s in os.environ["NIHO_RAW_SCENES"].split(",") if s]
    os.makedirs(out_dir, exist_ok=True)
    harness = build_harness(os.environ.get("NIHO_RAW_REFERENCE_BUILD", os.path.join(out_dir, ".build-raw-reference")))
    e = Engine(ENGINE)
    hello = e.call("hello")
    commit = photobench_commit()
    if not hello["engineVersion"].split("+")[1].startswith(commit[:12]):
        sys.exit(f"photobench-engine {hello['engineVersion']} is not built from {PHOTOBENCH_DIR} HEAD {commit}")
    manifest = {"engine": hello, "photobenchCommit": commit, "scenes": {}}
    for scene in scenes:
        raw = os.path.join(SOURCE_DIR, cases["raw"].format(scene=scene))
        entry = {"raw": os.path.basename(raw)}
        for kind in ("wc", "dcp"):
            d = os.path.join(out_dir, scene, kind)
            os.makedirs(d, exist_ok=True)
            case_list = [{"name": c["name"], "settings": settings_for(e, scene, c)} for c in cases[kind]]
            json.dump({"cases": case_list}, open(os.path.join(d, "cases.json"), "w"), indent=1, ensure_ascii=False)
            if kind == "wc":
                wc = e.call(
                    "renderWorkingCopy",
                    {"path": raw, "workingCopyPath": os.path.join(d, "wc.png"), "maxDimension": 2560},
                )
                json.dump(wc["meta"], open(os.path.join(d, "wc.json"), "w"), indent=1)
                entry["workingCopy"] = {k: wc[k] for k in ("baseVersion", "width", "height", "sourceWidth", "sourceHeight", "bytes")}
                args = [harness, "wc", raw, os.path.join(d, "wc.png"), os.path.join(d, "wc.json"), os.path.join(d, "cases.json"), d]
            else:
                args = [harness, "dcp", raw, os.path.join(d, "cases.json"), d, "2560"]
            subprocess.run(args, check=True)
        manifest["scenes"][scene] = entry
    e.close()
    json.dump(manifest, open(os.path.join(out_dir, "manifest.json"), "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
