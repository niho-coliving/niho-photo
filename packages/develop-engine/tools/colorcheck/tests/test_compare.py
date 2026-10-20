import json
import os
import tempfile
import unittest

import numpy as np
from PIL import Image

from colorcheck import cli
from colorcheck import color as C
from colorcheck import io as IO
from colorcheck.compare import run_compare

from . import synth


def _write_tiff16_linear(path, lin):
    IO.cv2.imwrite(path, np.ascontiguousarray(C.quantize16(np.clip(lin, 0, 1))[..., ::-1]))


@unittest.skipIf(IO.cv2 is None, "cv2 needed for 16-bit TIFF fixtures")
class CompareTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = cls.tmp.name
        cls.scene = synth.scene_linear_srgb(300, 450, seed=11)
        cls.ref = os.path.join(d, "ref.png")
        IO.save_srgb8(cls.ref, synth.render_reference_u8(cls.scene))
        cls.cand = os.path.join(d, "cand.tif")
        _write_tiff16_linear(cls.cand, cls.scene)
        cls.cand_moved = os.path.join(d, "cand_moved.tif")
        _write_tiff16_linear(cls.cand_moved, synth.warp(cls.scene, 1.015, 4.0, -3.0))
        cls.cand_dark = os.path.join(d, "cand_dark.tif")
        _write_tiff16_linear(cls.cand_dark, cls.scene * 0.5)
        cls.cand_srgb = os.path.join(d, "cand_srgb.png")
        IO.save_srgb8(cls.cand_srgb, C.quantize8(C.srgb_encode(np.clip(C.srgb_decode(
            np.asarray(Image.open(cls.ref), dtype=np.float64) / 255.0) * 0.7, 0, 1))))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_same_scene_rendered(self):
        r = run_compare(self.ref, self.cand, "linear-srgb", render=True)
        m = r["metrics"]
        self.assertLess(m["deltaE00"]["mean"], 0.3)
        self.assertLess(abs(m["evDiff"]), 0.02)
        self.assertAlmostEqual(m["saturationRatio"], 1.0, delta=0.02)
        self.assertAlmostEqual(r["alignment"]["scale"], 1.0, delta=0.002)
        self.assertEqual(r["analysisSize"], [450, 300])

    def test_moved_candidate_aligned(self):
        r = run_compare(self.ref, self.cand_moved, "linear-srgb", render=True)
        al = r["alignment"]
        self.assertAlmostEqual(al["scale"], 1.015, delta=0.002)
        self.assertAlmostEqual(al["dx"], 4.0, delta=0.6)
        self.assertAlmostEqual(al["dy"], -3.0, delta=0.6)
        self.assertLess(r["metrics"]["deltaE00"]["mean"], 0.8)
        r2 = run_compare(self.ref, self.cand_moved, "linear-srgb", render=True, do_align=False)
        self.assertGreater(r2["metrics"]["deltaE00"]["mean"], r["metrics"]["deltaE00"]["mean"] * 2)

    def test_exposure_normalization_rendered(self):
        r = run_compare(self.ref, self.cand_dark, "linear-srgb", render=True, normalize_exposure=True)
        self.assertLess(r["metrics"]["evDiff"], -0.3)
        n = r["normalized"]
        self.assertEqual(n["method"], "pre-tone-ev")
        self.assertAlmostEqual(n["evOffset"], 1.0, delta=0.05)
        self.assertLess(abs(n["evDiff"]), 0.01)
        self.assertLess(n["deltaE00"]["mean"], 0.5)

    def test_exposure_normalization_display(self):
        r = run_compare(self.ref, self.cand_srgb, "srgb", normalize_exposure=True)
        self.assertAlmostEqual(r["metrics"]["evDiff"], np.log2(0.7), delta=0.03)
        n = r["normalized"]
        self.assertEqual(n["method"], "display-linear-gain")
        self.assertAlmostEqual(n["gain"], 1 / 0.7, delta=0.03)
        self.assertLess(n["deltaE00"]["mean"], 0.5)

    def test_calibration_baseline_ev(self):
        cal = os.path.join(self.tmp.name, "cal.json")
        with open(cal, "w") as fh:
            json.dump({"schema": "niho-develop-calibration/v1",
                       "matrix": {"space": "linear-prophoto-d50", "rowMajor": np.eye(3).tolist()},
                       "baselineEV": 1.0, "illuminants": None, "hueSat": None}, fh)
        r = run_compare(self.ref, self.cand_dark, "linear-srgb", render=True, calibration=cal)
        self.assertLess(r["metrics"]["deltaE00"]["mean"], 0.3)
        self.assertEqual(r["candidate"]["calibration"]["baselineEV"], 1.0)

    def test_cli_compare_and_samples(self):
        out = os.path.join(self.tmp.name, "res.json")
        pairs = os.path.join(self.tmp.name, "pairs")
        rc = cli.main(["compare", "--reference", self.ref, "--candidate", self.cand, "--candidate-space",
                       "linear-srgb", "--render", "--camera-make", "Panasonic", "--camera-model", "DC-S5",
                       "--decoder-version", "8", "--base-version", "b1", "--label", "synthetic", "--out", out,
                       "--save-pair", pairs])
        self.assertEqual(rc, 0)
        with open(out) as fh:
            d = json.load(fh)
        for k in ("schema", "reference", "candidate", "camera", "decoderVersion", "baseVersion", "alignment",
                  "analysisSize", "blurSigma", "metrics", "createdAt"):
            self.assertIn(k, d)
        self.assertEqual(d["schema"], "colorcheck/compare/v1")
        for k in ("deltaE00", "deltaE00Unblurred", "evDiff", "saturationRatio", "white"):
            self.assertIn(k, d["metrics"])
        for k in ("mean", "p50", "p95", "p99", "max"):
            self.assertIn(k, d["metrics"]["deltaE00"])
        self.assertEqual(d["camera"], {"make": "Panasonic", "model": "DC-S5"})
        for p in d["samples"].values():
            with Image.open(p) as im:
                self.assertLessEqual(max(im.size), 480)

    def test_cli_errors(self):
        out = os.path.join(self.tmp.name, "x.json")
        rc = cli.main(["compare", "--reference", self.ref, "--candidate", self.cand_srgb, "--render", "--out", out])
        self.assertEqual(rc, cli.EXIT_INPUT)
        rc = cli.main(["compare", "--reference", "/nonexistent.jpg", "--candidate", self.cand, "--out", out])
        self.assertEqual(rc, cli.EXIT_INPUT)

    def test_render_cli_formats(self):
        for ext in ("png", "jpg", "tif"):
            out = os.path.join(self.tmp.name, f"render.{ext}")
            rc = cli.main(["render", "--input", self.cand, "--space", "linear-srgb", "--out", out, "--long-edge", "200"])
            self.assertEqual(rc, 0)
            img = IO.load_image(out)
            self.assertEqual(max(img.size), 200)
            self.assertEqual(img.bit_depth, 16 if ext == "tif" else 8)
        # the 16-bit render matches the 8-bit reference rendering after the same shrink
        tif = IO.load_image(os.path.join(self.tmp.name, "render.tif"))
        png = IO.load_image(os.path.join(self.tmp.name, "render.png"))
        diff = np.abs(tif.normalized() * 255 - png.normalized() * 255)
        self.assertLessEqual(float(diff.max()), 0.51)


if __name__ == "__main__":
    unittest.main()
