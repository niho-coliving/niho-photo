#!/usr/bin/env python3
"""Renders the golden references with Photo Bench's engine (macOS only).

Usage: python3 scripts/golden/make_references.py [path/to/photobench-engine]

Default engine: $PHOTOBENCH_ENGINE or the Photo Bench repo's
dist/engine/MacOS/photobench-engine. Stage 2 is compared from the same
decoded pixels (spec: "同じデコードから描いたもの"): every JPEG in
fixtures/golden/input/ is decoded once with Pillow into a lossless PNG
(fixtures/golden/reference/<input>.png), and both Photo Bench and the crate
render that PNG. For every case in scripts/golden/cases.json the engine
exports it at its own size with `jpegQuality: 1.0` (4:4:4; `.final`
quality: full-resolution decode, Shadows nDisc 10, statistics at 750px)
into fixtures/golden/reference/<input>__<case>.jpg. `<input>__jpeg-decode.jpg`
is the JPEG itself opened by the engine with neutral settings (decoder
baseline, reported but not gated). manifest.json records the engine version
and the exact EditSettings sent. References are not committed (see
README); the crate-side comparison is
`cargo test --release -p niho-develop --test golden -- --ignored --nocapture`.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_ENGINE = os.environ.get(
    "PHOTOBENCH_ENGINE",
    "OWNER_DATA_ROOT",
)


class Engine:
    def __init__(self, path):
        self.p = subprocess.Popen([path, "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.next_id = 1

    def call(self, method, params=None):
        rid = self.next_id
        self.next_id += 1
        req = {"id": rid, "method": method}
        if params is not None:
            req["params"] = params
        self.p.stdin.write((json.dumps(req) + "\n").encode())
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("engine exited")
            hdr = json.loads(line)
            if "binaryLength" in hdr:
                self.p.stdout.read(hdr["binaryLength"])
            if hdr.get("id") == rid:
                if not hdr.get("ok"):
                    raise RuntimeError(json.dumps(hdr))
                return hdr["result"]

    def close(self):
        try:
            self.call("shutdown")
        except Exception:
            pass


def main():
    engine_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ENGINE
    cases = json.load(open(os.path.join(ROOT, "scripts/golden/cases.json")))
    presets_dir = os.path.join(ROOT, "crates/niho-develop/presets")
    in_dir = os.path.join(ROOT, "fixtures/golden/input")
    out_dir = os.path.join(ROOT, "fixtures/golden/reference")
    os.makedirs(out_dir, exist_ok=True)
    e = Engine(engine_path)
    hello = e.call("hello")
    manifest = {"engine": hello, "cases": {}}
    for case in cases["cases"]:
        if "preset" in case:
            xmp = open(os.path.join(presets_dir, case["preset"] + ".xmp")).read()
            settings = e.call("presetSettings", {"xmp": xmp})["settings"]
        else:
            settings = case["settings"]
        manifest["cases"][case["name"]] = settings
    from PIL import Image  # Pillow: lossless PNG from the JPEG
    import shutil

    for name in cases["inputs"]:
        stem = os.path.splitext(name)[0]
        src = os.path.join(in_dir, name)
        png = os.path.join(out_dir, stem + ".png")
        if name.endswith(".png"):
            # Already lossless (16-bit, embedded ICC): both render the file itself.
            shutil.copyfile(src, png)
        else:
            Image.open(src).convert("RGB").save(png)
            opened = e.call("open", {"path": src})
            dst = os.path.join(out_dir, f"{stem}__jpeg-decode.jpg")
            e.call("export", {"photoId": opened["photoId"], "settings": opened["settings"], "destinationPath": dst, "jpegQuality": 1.0})
            e.call("close", {"photoId": opened["photoId"]})
        opened = e.call("open", {"path": png})
        for case in cases["cases"]:
            settings = dict(opened["settings"])
            settings.update(manifest["cases"][case["name"]])
            manifest["cases"][case["name"]] = settings
            dst = os.path.join(out_dir, f"{os.path.splitext(name)[0]}__{case['name']}.jpg")
            e.call("export", {"photoId": opened["photoId"], "settings": settings, "destinationPath": dst, "jpegQuality": 1.0})
            print("wrote", os.path.relpath(dst, ROOT))
        e.call("close", {"photoId": opened["photoId"]})
    e.close()
    json.dump(manifest, open(os.path.join(out_dir, "manifest.json"), "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
