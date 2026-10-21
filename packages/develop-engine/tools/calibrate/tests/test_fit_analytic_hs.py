"""Guards and objective of fit_analytic_hs.py (#26); synthetic data only."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fit_analytic_hs as F  # noqa: E402


class GuardTests(unittest.TestCase):
    def test_work_directory_inside_the_repository_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            (repo / "private").mkdir(parents=True)
            with self.assertRaises(SystemExit):
                F.guard_work(repo, repo / "private")
            F.guard_work(repo, Path(tmp) / "outside")

    def test_sealed_or_independent_cohorts_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp) / "work"
            (work / "data").mkdir(parents=True)
            sealed = Path(tmp) / "sealed"
            sealed.mkdir()
            (sealed / "manifest.json").write_text(json.dumps({"sealed": True, "scenes": []}))
            (work / "data" / "teachers").symlink_to(sealed)
            with self.assertRaises(SystemExit):
                F.cohort_root(work, "teachers")
            # The path is refused before its manifest is opened.
            independent = Path(tmp) / "independent"
            independent.mkdir()
            (work / "data" / "teachers2").symlink_to(independent)
            with self.assertRaises(SystemExit):
                F.cohort_root(work, "teachers2")
            open_cohort = Path(tmp) / "open"
            open_cohort.mkdir()
            (open_cohort / "manifest.json").write_text(json.dumps({"sealed": False, "scenes": []}))
            (work / "data" / "other").symlink_to(open_cohort)
            self.assertEqual(F.cohort_root(work, "other"), open_cohort.resolve())


class ModelTests(unittest.TestCase):
    def test_subsets_follow_metadata_only(self):
        self.assertEqual(F.subset_of({"band": "dark", "model": "DC-S5"}), "dark")
        self.assertEqual(F.subset_of({"band": "dark", "model": "iPhone 11"}), "dark")
        self.assertEqual(F.subset_of({"band": "bright", "model": "iPhone 13 Pro"}), "brightIphone")
        self.assertEqual(F.subset_of({"band": "mid", "model": "iPhone 13 Pro"}), "daylight")
        self.assertEqual(F.subset_of({"band": "bright", "model": "DC-S5"}), "daylight")

    def test_candidate_layout_and_residual_bound(self):
        theta = np.arange(10, dtype=float)
        candidate = F.candidate_of(theta, None)
        self.assertEqual(candidate["formula"]["highlightScale"], [0.0, 1.0])
        self.assertEqual(candidate["formula"]["highlightChromaAlpha"], 4.0)
        self.assertEqual(candidate["formula"]["shadowShift"], [7.0, 8.0])
        self.assertEqual(candidate["residual"]["maxResidualEV"], 0.0)
        with_residual = F.candidate_of(theta, np.ones(6))
        self.assertEqual(with_residual["residual"]["maxResidualEV"], F.MAX_RESIDUAL_EV)
        self.assertLessEqual(F.MAX_RESIDUAL_EV, 0.5)
        self.assertTrue(np.all(F.START >= F.LOWER) and np.all(F.START <= F.UPPER))

    def test_tail_and_guard_terms(self):
        base = np.array([[1.0, 4.0, 0, 0], [1.0, 4.0, 0, 0]])
        weights = np.ones(2)
        guarded = np.array([1.0, 0.0])
        calm = F.loss(np.array([[1.0, 5.0, 0, 0], [1.0, 5.0, 0, 0]]), base, weights, guarded)
        tail = F.loss(np.array([[1.0, 5.0, 0, 0], [1.0, 9.0, 0, 0]]), base, weights, guarded)
        self.assertGreater(tail - calm, F.P99_WEIGHT * 4)
        worse_guarded = F.loss(np.array([[2.0, 5.0, 0, 0], [1.0, 5.0, 0, 0]]), base, weights, guarded)
        worse_unguarded = F.loss(np.array([[1.0, 5.0, 0, 0], [2.0, 5.0, 0, 0]]), base, weights, guarded)
        self.assertGreater(worse_guarded, worse_unguarded)

    def test_family_selection_prefers_fewer_target_tails_but_guards_daylight(self):
        scenes = [{"subset": "dark"}, {"subset": "brightIphone"}, {"subset": "daylight"}]
        items = [{"scene": j, "variant": "preset_pastel"} for j in range(3)]
        plan = {"scenes": scenes, "items": items}
        b1 = np.array([[2.0, 9.0, 0, 0], [2.0, 7.0, 0, 0], [2.0, 5.0, 0, 0]])
        b2 = np.array([[2.0, 7.5, 0, 0], [2.0, 7.0, 0, 0], [2.04, 5.0, 0, 0]])
        self.assertEqual(F.select_family(plan, {"B1": b1, "B2": b2})["family"], "B2")
        b2_worse_daylight = b2.copy()
        b2_worse_daylight[2, 0] = 2.2
        self.assertEqual(F.select_family(plan, {"B1": b1, "B2": b2_worse_daylight})["family"], "B1")
        self.assertEqual(F.select_family(plan, {"B1": b1, "B2": b1.copy()})["family"], "B1")

    def test_gate_tables_allow_missing_subsets_and_variants(self):
        scenes = [{"subset": "dark"}, {"subset": "brightIphone"}]
        variants = ("neutral",) + F.PRESETS
        items = [{"scene": j, "variant": v} for j in range(2) for v in variants]
        rows = []
        for i, it in enumerate(items):
            metric = {"mean": 1.0 + i, "p99": 5.0 + i, "max": 9.0}
            if it["variant"] == "neutral":
                rows.append({"item": i, "kind": "neutral", "A": metric})
            else:
                better = {"mean": 0.5 + i, "p99": 4.0 + i, "max": 9.0}
                rows.append({"item": i, "kind": "oof", "A": metric, "B": better})
                rows.append({"item": i, "kind": "insample", "A": metric, "B": better})
        tables = F.gate_tables({"scenes": scenes, "items": items}, rows)
        self.assertIsNone(tables["daylight"]["presetsTotal"]["niho10"])
        self.assertIsNone(tables["daylight"]["presetsTotal"]["pairedOutOfFold"])
        self.assertIsNone(tables["all"]["h100"]["candidateOutOfFold"])
        total = tables["all"]["presetsTotal"]
        self.assertEqual(total["candidateOutOfFold"]["n"], 6)
        self.assertEqual(total["pairedOutOfFold"]["meanWorse"], 0)
        verdict = F.gate_verdict(tables["all"], "candidateOutOfFold")
        # Neutral items 0 and 4 have means 1 and 5: the neutral gate fails.
        self.assertFalse(verdict["neutralMean<=2"])
        self.assertFalse(verdict["presetP99<=8 (every scene)"])


if __name__ == "__main__":
    unittest.main()
