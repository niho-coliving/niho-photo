import contextlib
import copy
import io
import json
import os
import tempfile
import unittest

from colorcheck import cli
from colorcheck import fixtures as F
from colorcheck.compare import summarize_presets

SECRET = "OWNER_DATA_ROOT"


def compare_result(label, mean, kind="reference", scene=None, preset=None, decoder="8"):
    return {
        "schema": "colorcheck/compare/v1", "label": label, "comparison": kind, "scene": scene, "preset": preset,
        "reference": {"path": f"{SECRET}/ref/{scene or label}.jpg"},
        "candidate": {"path": f"{SECRET}/cand/{scene or label}.tif"},
        "camera": {"make": "Panasonic", "model": "DC-S5"}, "decoderVersion": decoder, "baseVersion": "b1",
        "alignment": {"scale": 1.0, "dx": 0.0, "dy": 0.0, "corr": 0.95},
        "metrics": {"deltaE00": {"mean": mean, "p50": mean, "p95": mean * 2, "p99": round(mean * 3, 4), "max": mean * 4},
                    "deltaE00Unblurred": {"mean": mean * 1.1, "p99": mean * 3.3}, "evDiff": 0.01,
                    "saturationRatio": 0.98,
                    "white": {"reference": {"a": 0.1, "b": 1.0, "fraction": 0.2},
                              "candidate": {"a": 0.2, "b": 1.5, "fraction": 0.2}}},
        "samples": {"reference": f"{SECRET}/pairs/{label}_ref.jpg", "candidate": f"{SECRET}/pairs/{label}_niho.jpg"},
    }


def preset_result(means):
    items = [compare_result(f"{p}/{s}", m, kind="preset", scene=s, preset=p) for (p, s), m in means.items()]
    return {"schema": "colorcheck/preset/v1", "manifest": f"{SECRET}/manifest.json",
            "camera": {"make": "Panasonic", "model": "DC-S5"}, "decoderVersion": "8", "baseVersion": "b1",
            "presets": summarize_presets(items), "items": items}


def chart_result(label, illuminant, mean, mx, primary="raw"):
    patches = [{"index": i, "name": f"p{i}", "deltaE00_raw": mean, "deltaE00_grayBalanced": mean / 2,
                "lab_ref": [50, 0, 0], "lab_raw": [50, 0, 0], "lab_grayBalanced": [50, 0, 0]} for i in range(1, 25)]
    s = {"mean": mean, "p95": mx, "max": mx}
    return {"schema": "colorcheck/chart/v1", "kind": "chart", "label": label, "illuminant": illuminant,
            "camera": {"make": "Panasonic", "model": "DC-S5"}, "decoderVersion": "8", "baseVersion": "b1",
            "image": {"path": f"{SECRET}/charts/{label}.tif", "size": [100, 80], "space": "linear-prophoto"},
            "detection": {"method": "auto"}, "exposure": {"ev": 0.3}, "grayBalance": {"gainsRelative": [0.9, 1, 1.1]},
            "patches": patches,
            "summary": {"primary": primary, "raw": s, "grayBalanced": {"mean": mean / 2, "p95": mx / 2, "max": mx / 2}}}


class FixturesTest(unittest.TestCase):
    def setUp(self):
        self.results = [
            compare_result("base/A", 1.2, scene="A"),
            compare_result("camjpeg/A", 3.5, kind="camera-jpeg", scene="A"),
            compare_result("decoder-7vs8/A", 0.2, kind="version", scene="A", decoder="7vs8"),
            preset_result({("bluesky2", "A"): 2.0, ("bluesky2", "B"): 2.5, ("pastel", "A"): 1.5,
                           ("colorful", "A"): 2.6}),
            chart_result("chart/daylight", "daylight", 1.2, 3.0),
            chart_result("chart/tungsten", "tungsten", 1.6, 4.0, primary="grayBalanced"),
        ]

    def test_build_numbers_only(self):
        fx = F.build(self.results)
        self.assertEqual(fx["schema"], "colorcheck/fixture/v2")
        self.assertEqual(fx["camera"], {"make": "Panasonic", "model": "DC-S5"})
        self.assertEqual(fx["decoderVersion"], "8")
        self.assertEqual(fx["baseVersion"], "b1")
        keys = [e["label"] for e in fx["entries"]]
        for k in ("base/A", "camjpeg/A", "decoder-7vs8/A", "bluesky2/A", "bluesky2/B", "pastel/A", "colorful/A",
                  "preset:bluesky2", "preset:pastel", "preset:colorful", "chart/daylight", "chart/tungsten"):
            self.assertIn(k, keys)
        self.assertEqual(fx["counts"], {"chart": 2, "compare": 3, "preset": 4, "preset-summary": 3})
        by = {e["label"]: e for e in fx["entries"]}
        self.assertEqual(by["base/A"]["deltaE00"], {"mean": 1.2, "p99": 3.6})
        self.assertEqual(by["preset:bluesky2"]["deltaE00"], {"mean": 2.25, "p99": 7.5})
        self.assertEqual(by["chart/tungsten"]["deltaE00"]["mean"], 0.8)  # primary = grayBalanced
        self.assertEqual(len(by["chart/daylight"]["patchesDeltaE00"]["raw"]), 24)
        self.assertEqual(by["decoder-7vs8/A"]["decoderVersion"], "7vs8")  # differs from the top level
        self.assertNotIn("decoderVersion", by["base/A"])
        text = json.dumps(fx, ensure_ascii=False)
        self.assertNotIn(SECRET, text)
        self.assertNotIn(".jpg", text)
        self.assertNotIn(".tif", text)
        gates = {g["id"]: g for g in fx["gates"]["gates"]}
        self.assertEqual(gates["stage1.preset"]["status"], "pass")
        self.assertEqual(gates["stage2.chart"]["status"], "pass")
        self.assertEqual(gates["stage1.versionDrift"]["details"][0]["label"], "decoder-7vs8/A")

    def test_check_same_results_ok(self):
        fx = F.build(self.results)
        rep = F.check(fx, self.results)
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["missing"], [])
        self.assertEqual(rep["extra"], [])
        self.assertEqual(len(rep["compared"]), len(fx["entries"]))
        self.assertTrue(all(c["ok"] and c["diff"] == 0 for c in rep["compared"]))
        self.assertIn("OK", F.check_markdown(rep))

    def test_check_drift(self):
        fx = F.build(self.results)
        cur = copy.deepcopy(self.results)
        cur[0]["metrics"]["deltaE00"]["mean"] = 1.55  # +0.35
        rep = F.check(fx, cur)
        self.assertFalse(rep["ok"])
        row = {c["key"]: c for c in rep["compared"]}["base/A"]
        self.assertFalse(row["ok"])
        self.assertAlmostEqual(row["diff"], 0.35, places=6)
        self.assertIn("**NG**", F.check_markdown(rep))
        self.assertTrue(F.check(fx, cur, tolerance=0.4)["ok"])
        cur[0]["metrics"]["deltaE00"]["mean"] = 0.9  # improvements count too
        self.assertFalse(F.check(fx, cur)["ok"])

    def test_missing_and_extra(self):
        fx = F.build(self.results)
        rep = F.check(fx, self.results[:3] + self.results[4:])  # preset result left out
        self.assertFalse(rep["ok"])
        self.assertIn("preset:bluesky2", rep["missing"])
        self.assertIn("bluesky2/A", rep["missing"])
        rep = F.check(fx, self.results[:3] + self.results[4:], allow_missing=True)
        self.assertTrue(rep["ok"], F.check_markdown(rep))
        rep = F.check(fx, self.results + [compare_result("base/C", 1.0, scene="C")])
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["extra"], ["base/C"])

    def test_gate_getting_worse_fails(self):
        fx = F.build(self.results)
        cur = copy.deepcopy(self.results)
        cur[4]["summary"]["raw"]["max"] = 6.0  # chart max over 5.0 -> stage2.chart fails, mean unchanged
        rep = F.check(fx, cur)
        self.assertTrue(all(c["ok"] for c in rep["compared"]))
        self.assertFalse(rep["gates"]["ok"])
        self.assertFalse(rep["ok"])
        row = {r["id"]: r for r in rep["gates"]["rows"]}["stage2.chart"]
        self.assertEqual((row["fixture"], row["current"], row["ok"]), ("pass", "fail", False))
        self.assertIn("悪化", F.check_markdown(rep))

    def test_duplicate_keys_and_unlabeled(self):
        a = compare_result("same", 1.0)
        b = compare_result("same", 2.0)
        c = compare_result(None, 3.0, kind="camera-jpeg", scene="Z")
        keys = [e["label"] for e in F.build([a, b, c])["entries"]]
        self.assertEqual(keys, ["same", "same#2", "camera-jpeg/Z"])

    def test_bad_fixture(self):
        with self.assertRaises(ValueError):
            F.check({"schema": "something-else"}, self.results)

    def test_cli(self):
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for i, r in enumerate(self.results):
                p = os.path.join(d, f"r{i}.json")
                with open(p, "w", encoding="utf-8") as fh:
                    json.dump(r, fh)
                paths.append(p)
            fx = os.path.join(d, "fixtures", "v1.json")
            out = os.path.join(d, "check.json")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                self.assertEqual(cli.main(["fixture", "write", "--results", *paths, "--out", fx]), cli.EXIT_OK)
                self.assertEqual(cli.main(["fixture", "check", "--fixture", fx, "--results", *paths, "--out", out]),
                                 cli.EXIT_OK)
                self.assertEqual(cli.main(["fixture", "check", "--fixture", fx, "--results", *paths[:2]]),
                                 cli.EXIT_FAIL)
                self.assertEqual(cli.main(["fixture", "check", "--fixture", fx, "--results", *paths[:2],
                                           "--allow-missing"]), cli.EXIT_OK)
                self.assertEqual(cli.main(["gates", "--results", *paths]), cli.EXIT_OK)
            with open(out, encoding="utf-8") as fh:
                self.assertTrue(json.load(fh)["ok"])
            self.assertIn("fixture の照合: NG", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
