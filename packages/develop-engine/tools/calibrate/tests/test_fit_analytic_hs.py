"""Guards and objective of fit_analytic_hs.py (#26); synthetic data only."""

import json
import sys
import tempfile
import unittest
from types import ModuleType, SimpleNamespace
from pathlib import Path
from unittest.mock import patch

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

    def test_holdout_verdict_includes_each_subset_even_when_aggregate_passes(self):
        scenes = [{"subset": subset} for subset in F.SUBSETS]
        variants = ("neutral",) + F.PRESETS
        items = [{"scene": scene_index, "variant": variant}
                 for scene_index in range(len(scenes)) for variant in variants]
        rows = []
        for index, item in enumerate(items):
            baseline = {"mean": 1.0, "p99": 7.0, "max": 9.0}
            if item["variant"] == "neutral":
                rows.append({"item": index, "kind": "neutral", "A": baseline})
                continue
            candidate = {"mean": 4.0 if item["scene"] == 0 else 1.0, "p99": 7.0, "max": 9.0}
            rows.extend([{"item": index, "kind": "oof", "A": baseline, "B": candidate},
                         {"item": index, "kind": "insample", "A": baseline, "B": candidate}])

        tables = F.gate_tables({"scenes": scenes, "items": items}, rows)
        verdicts = F.holdout_verdicts(tables)
        self.assertTrue(verdicts["all"]["presetMean<=3"])
        self.assertFalse(verdicts["bySubset"]["dark"]["presetMean<=3"])
        self.assertTrue(verdicts["bySubset"]["brightIphone"]["presetMean<=3"])
        self.assertTrue(verdicts["bySubset"]["daylight"]["presetMean<=3"])

    def test_holdout_requires_frozen_nonblank_minimum_in_every_subset(self):
        scenes = [{"subset": subset} for subset in F.SUBSETS for _ in range(2)]
        counts = F.require_holdout_subset_counts(scenes, 2)
        self.assertEqual(counts, {subset: 2 for subset in F.SUBSETS})
        with self.assertRaisesRegex(SystemExit, "every subset"):
            F.require_holdout_subset_counts(scenes[:-1], 2)

    def test_holdout_frozen_executable_guard_checks_calibrator_and_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            probe = Path(tmp) / "analytic_hs_probe"
            calibrate = Path(tmp) / "analytic_hs_calibrate"
            probe.write_bytes(b"frozen probe")
            calibrate.write_bytes(b"frozen calibrator")
            record = {"executables": {"analyticHsProbeSha256": F.digest(probe),
                                      "analyticHsCalibrateSha256": F.digest(calibrate)}}
            F.validate_frozen_executables(record, probe, calibrate)
            calibrate.write_bytes(b"rebuilt calibrator")
            with self.assertRaisesRegex(SystemExit, "analytic_hs_calibrate"):
                F.validate_frozen_executables(record, probe, calibrate)

    def test_holdout_underpowered_cohort_does_not_consume_one_time_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root / "private-work"
            cohort = root / "cohort"
            (cohort / "inputs").mkdir(parents=True)
            (cohort / "lr-export").mkdir()
            scenes = [
                {"scene": "dark", "date": "2026-10-01", "model": "Camera", "band": "dark"},
                {"scene": "iphone", "date": "2026-10-02", "model": "iPhone 13 Pro", "band": "bright"},
                {"scene": "day", "date": "2026-10-03", "model": "Camera", "band": "mid"},
            ]
            (cohort / "manifest.json").write_text(json.dumps({"scenes": scenes}))
            for scene in scenes:
                (cohort / "inputs" / f"{scene['scene']}__neutral.jpg").write_bytes(b"input")
                for variant in ("neutral",) + F.PRESETS:
                    (cohort / "lr-export" / f"{scene['scene']}__{variant}.jpg").write_bytes(b"reference")
            probe, calibrate = root / "probe", root / "calibrate"
            probe.write_bytes(b"probe")
            calibrate.write_bytes(b"calibrator")
            candidate = root / "candidate.json"
            candidate.write_text(json.dumps({"coefficientsSha256": "coefficients"}))
            freeze = root / "freeze.json"
            repo = Path(__file__).resolve().parents[5]
            tool = repo / "packages/develop-engine/tools/calibrate/fit_analytic_hs.py"
            record = {
                "sourceCommit": "a" * 40,
                "executableBuildCommit": "b" * 40,
                "executables": {"analyticHsProbeSha256": F.digest(probe),
                                "analyticHsCalibrateSha256": F.digest(calibrate)},
                "evaluationToolSha256": F.digest(tool),
                "candidateManifest": {"path": candidate.name, "sha256": F.digest(candidate),
                                      "coefficientsSha256": "coefficients"},
                "evaluationManifest": {"selection": {"minimumScenesPerSubset": 2}},
            }
            freeze.write_text(json.dumps(record))
            calibrate_module = ModuleType("fit_niho6_response")
            calibrate_module.blank_input = lambda _path: False
            args = SimpleNamespace(repo=repo, work=work, cohort=cohort, freeze=freeze,
                                   probe=None, calibrate=None, threads=1)
            with patch.dict(sys.modules, {"fit_niho6_response": calibrate_module}), \
                    patch.object(F, "binaries", return_value={"probe": probe, "calibrate": calibrate}), \
                    patch.object(F.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
                with self.assertRaisesRegex(SystemExit, "at least 2 non-blank scenes"):
                    F.holdout(args)
            self.assertFalse((work / "holdout-started.json").exists())
            self.assertEqual(run.call_count, 2)

    def test_surrogate_baseline_cache_is_bound_to_plan_and_input_contents(self):
        class FakeServer:
            def __init__(self):
                self.calls = 0

            def baseline(self, items):
                self.calls += 1
                return np.full((len(items), 4), float(self.calls))

        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            plan_path, config_path = work / "plan.json", work / "server-config.json"
            calibrate, source, settings, reference = (work / name for name in
                                                       ("calibrate", "input.jpg", "settings.json", "reference.jpg"))
            for path in (calibrate, source, settings, reference):
                path.write_bytes(b"initial")
            plan_doc = {"items": [{"scene": 0}, {"scene": 1}]}
            plan_path.write_text(json.dumps(plan_doc))
            config = {"scenes": [{"input": str(source)} for _ in plan_doc["items"]],
                      "items": [{"settings": str(settings), "reference": str(reference)}
                                for _ in plan_doc["items"]]}
            config_path.write_text(json.dumps(config))
            server = FakeServer()

            first = F.surrogate_baseline(server, work, plan_doc, plan_path, config_path, calibrate)
            cached = F.surrogate_baseline(server, work, plan_doc, plan_path, config_path, calibrate)
            self.assertTrue(np.array_equal(first, cached))
            self.assertEqual(server.calls, 1)

            plan_doc = {"items": [{"scene": 1}, {"scene": 0}]}
            plan_path.write_text(json.dumps(plan_doc))
            reordered = F.surrogate_baseline(server, work, plan_doc, plan_path, config_path, calibrate)
            self.assertEqual(server.calls, 2)
            self.assertFalse(np.array_equal(first, reordered))

            source.write_bytes(b"changed teacher photo at same path")
            changed_input = F.surrogate_baseline(server, work, plan_doc, plan_path, config_path, calibrate)
            self.assertEqual(server.calls, 3)
            self.assertFalse(np.array_equal(reordered, changed_input))


if __name__ == "__main__":
    unittest.main()
