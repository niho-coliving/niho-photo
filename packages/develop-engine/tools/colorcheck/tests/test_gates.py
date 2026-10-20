import unittest
from unittest.mock import patch

from colorcheck import gates as G
from colorcheck.compare import preset_markdown, run_preset


class PresetGateTest(unittest.TestCase):
    def test_diagnostic_preset_manifest_can_skip_and_exclude_gate(self):
        manifest = {"items": [{"preset": "bluesky2", "scene": "scene1",
                               "reference": "reference.jpg", "candidate": "candidate.jpg"}]}
        compare_result = {
            "preset": "bluesky2",
            "scene": "scene1",
            "label": "bluesky2/scene1",
            "metrics": {"deltaE00": {"mean": 5.0, "p99": 12.0},
                        "deltaE00Unblurred": {"mean": 5.0}, "evDiff": 0.0, "saturationRatio": 1.0},
            "alignment": {"scale": 1.0, "corr": 1.0},
        }
        with patch("colorcheck.compare.run_compare", return_value=compare_result):
            gated = run_preset(manifest)
            diagnostic = run_preset(manifest, evaluate_gates=False)

        self.assertEqual(gated["gates"]["overall"], "fail")
        self.assertTrue(diagnostic["gateExcluded"])
        self.assertEqual(diagnostic["gates"], {"overall": "not-evaluated", "gates": []})
        preset_gate = next(g for g in G.evaluate([diagnostic])["gates"] if g["id"] == "stage1.preset")
        self.assertEqual(preset_gate["status"], "not-evaluated")
        self.assertNotIn("gate stage1.preset:", preset_markdown(diagnostic))

    def test_failing_optional_preset_does_not_fail_required_gate(self):
        results = [{
            "schema": "colorcheck/preset/v1",
            "presets": [
                {"preset": name, "deltaE00Mean": 1.0, "deltaE00P99": 2.0}
                for name in G.REQUIRED_PRESETS
            ] + [
                {"preset": "experimental", "deltaE00Mean": 5.0, "deltaE00P99": 12.0}
            ],
        }]

        gate = next(g for g in G.evaluate(results)["gates"] if g["id"] == "stage1.preset")

        self.assertEqual(gate["status"], "pass")
        optional = next(row for row in gate["details"] if row["preset"] == "experimental")
        self.assertFalse(optional["required"])
        self.assertEqual(optional["status"], "fail")

    def test_failing_required_preset_fails_gate(self):
        presets = [
            {"preset": name, "deltaE00Mean": 1.0, "deltaE00P99": 2.0}
            for name in G.REQUIRED_PRESETS
        ]
        presets[0]["deltaE00Mean"] = 4.0
        gate = next(g for g in G.evaluate([{"schema": "colorcheck/preset/v1", "presets": presets}])["gates"]
                    if g["id"] == "stage1.preset")

        self.assertEqual(gate["status"], "fail")


def reference(label, mean, model="DC-S5"):
    return {"schema": "colorcheck/compare/v1", "label": label, "comparison": "reference",
            "camera": {"make": "X", "model": model}, "metrics": {"deltaE00": {"mean": mean}}}


class ReferenceNeutralGateTest(unittest.TestCase):
    def gate(self, results):
        return next(g for g in G.evaluate(results)["gates"] if g["id"] == "stage2.referenceNeutral")

    def test_mean_of_scene_means_per_camera_and_path(self):
        g = self.gate([reference("base/A", 1.0), reference("base/B", 2.8), reference("crate-base/A", 1.1),
                       reference("base-uncal/A", 6.0), reference("base/C", 0.8, model="ZV")])
        self.assertEqual(g["status"], "pass")   # base 1.9・crate-base 1.1・ZV 0.8（補正前は数えない）
        self.assertEqual({d["key"]: d["scenes"] for d in g["details"]},
                         {"X DC-S5 / base": 2, "X DC-S5 / crate-base": 1, "X ZV / base": 1})

    def test_one_camera_over_fails(self):
        g = self.gate([reference("base/A", 1.0), reference("base/Z", 2.2, model="ZV")])
        self.assertEqual(g["status"], "fail")

    def test_not_evaluated_without_reference_compares(self):
        self.assertEqual(self.gate([])["status"], "not-evaluated")


if __name__ == "__main__":
    unittest.main()
