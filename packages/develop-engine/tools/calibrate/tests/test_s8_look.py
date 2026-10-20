import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

CALIBRATE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CALIBRATE_DIR))

import fit_look  # noqa: E402
import run_s8_look  # noqa: E402


class FitLookCacheTest(unittest.TestCase):
    def test_baseline_ev_is_part_of_prelook_cache_key(self):
        path_a = fit_look.prelook_cache_path("scene.png", "/tmp/cache", -0.25)
        path_b = fit_look.prelook_cache_path("scene.png", "/tmp/cache", 0.25)
        self.assertNotEqual(path_a, path_b)
        self.assertTrue(path_a.endswith(".tiff"))


class S8LookBuildTest(unittest.TestCase):
    def _prepare_s8_fixture(self, root):
        ref = root / "refs" / "round7"
        export = ref / "lr-export-color"
        s8 = root / "work" / "s8"
        working = root / "work" / "working-copy" / "scene1.png"
        export.mkdir(parents=True)
        working.parent.mkdir(parents=True)
        working.write_bytes(b"working-copy")
        (ref / "manifest.json").write_text('[{"scene":"scene1","model":"camera"}]', encoding="utf-8")

        def ref_path(scene, variant):
            return export / f"p7_{scene}_color_{variant}.jpg"

        for variant in run_s8_look.VARIANTS:
            ref_path("scene1", variant).write_bytes(f"reference-{variant}".encode())

        replacements = [
            patch.object(run_s8_look, "ROUND", ref),
            patch.object(run_s8_look, "EXPORT", export),
            patch.object(run_s8_look, "S8", s8),
            patch.object(run_s8_look, "scenes", return_value=[{"scene": "scene1", "model": "camera", "split": "train"}]),
            patch.object(run_s8_look, "reference", side_effect=ref_path),
            patch.object(run_s8_look, "working_copy", return_value=working),
        ]
        for replacement in replacements:
            replacement.start()
            self.addCleanup(replacement.stop)
        return ref_path, working, s8

    def test_invalid_reference_settings_stop_every_reference_consumer(self):
        for step in ["manifest", "fit", "adopt", "render", "measure", "page", "all"]:
            with self.subTest(step=step), patch.object(sys, "argv", ["run_s8_look.py", step]):
                with patch.object(run_s8_look.make_lr_round7, "check", return_value=1), patch.object(run_s8_look, "log"):
                    with patch.dict(run_s8_look.STEPS, {key: unittest.mock.Mock() for key in run_s8_look.STEPS}):
                        self.assertEqual(run_s8_look.main(), 1)
                        for action in run_s8_look.STEPS.values():
                            action.assert_not_called()

    def test_crate_build_does_not_require_private_reference_images(self):
        with patch.object(sys, "argv", ["run_s8_look.py", "crate-build"]):
            with patch.object(run_s8_look.make_lr_round7, "check") as check:
                with patch.dict(run_s8_look.STEPS, {"crate-build": unittest.mock.Mock()}):
                    self.assertEqual(run_s8_look.main(), 0)
                    check.assert_not_called()
                    run_s8_look.STEPS["crate-build"].assert_called_once()

    def test_fingerprint_tracks_cargo_inputs_crate_sources_and_toolchain(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files = {
                "Cargo.toml": "[workspace]\n",
                "Cargo.lock": "version = 4\n",
                "rust-toolchain.toml": "[toolchain]\nchannel = '1.98.1'\n",
                ".cargo/config.toml": "[build]\nrustflags = []\n",
                "crates/niho-develop/Cargo.toml": "[package]\nname='niho-develop'\n",
                "crates/niho-develop/src/lib.rs": "pub fn render() {}\n",
            }
            for relative, contents in files.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents, encoding="utf-8")

            original = run_s8_look.source_fingerprint(root, compiler_info="rustc 1.98.1")
            for relative, contents in files.items():
                path = root / relative
                path.write_text(contents + "# changed\n", encoding="utf-8")
                self.assertNotEqual(
                    original,
                    run_s8_look.source_fingerprint(root, compiler_info="rustc 1.98.1"),
                    relative,
                )
                path.write_text(contents, encoding="utf-8")

            self.assertNotEqual(
                original,
                run_s8_look.source_fingerprint(root, compiler_info="rustc 1.98.2"),
            )

    def test_missing_selected_coefficients_fail_before_replacing_build_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            build_tree = root / "crate-src"
            build_tree.mkdir()
            sentinel = build_tree / "keep.txt"
            sentinel.write_text("existing build", encoding="utf-8")
            missing = root / "selected-look.json"
            args = argparse.Namespace(look_json=str(missing))
            with patch.object(run_s8_look, "S8", root):
                with self.assertRaisesRegex(FileNotFoundError, str(missing)):
                    run_s8_look.step_crate_build(args)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "existing build")

    def test_fit_regenerates_manifest_and_adopt_rejects_stale_inputs_or_coefficients(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ref_path, working, s8 = self._prepare_s8_fixture(root)
            fit_dir = s8 / "fit"
            fit_dir.mkdir(parents=True)
            stale = {"target": "old reference", "items": []}
            (fit_dir / "manifest.json").write_text(json.dumps(stale), encoding="utf-8")

            def fake_fit(command, check):
                output = Path(command[command.index("--out") + 1])
                output.write_text('{"schema":"test-look"}', encoding="utf-8")

            with patch.object(run_s8_look.subprocess, "run", side_effect=fake_fit):
                run_s8_look.step_fit(argparse.Namespace(reg=0.3, sat_node=0.3, hue_nodes=12, max_iter=60))

            look = fit_dir / "look.json"
            manifest = json.loads((fit_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["items"][0]["scene"], "scene1")
            self.assertNotEqual(manifest, stale)
            provenance = run_s8_look.validate_fit_provenance(look)
            self.assertEqual(provenance["lookSha256"], run_s8_look.sha256_file(look))

            original_look = look.read_bytes()
            look.write_bytes(original_look + b" ")
            with self.assertRaisesRegex(SystemExit, "変更"):
                run_s8_look.validate_fit_provenance(look)
            look.write_bytes(original_look)

            ref_path("scene1", "neutral").write_bytes(b"repaired reference")
            with patch.object(run_s8_look, "ENGINE", root / "engine"):
                with self.assertRaisesRegex(SystemExit, "参照画像"):
                    run_s8_look.step_adopt(argparse.Namespace(look_json=None))
            self.assertFalse((root / "engine" / "crates" / "niho-develop" / "looks" / "niho-standard-1.json").exists())

            # The working copy is independently part of the exact fitted input set.
            ref_path("scene1", "neutral").write_bytes(b"reference-neutral")
            working.write_bytes(b"changed working copy")
            with self.assertRaisesRegex(SystemExit, "参照画像"):
                run_s8_look.validate_fit_provenance(look)

    def test_regularization_default_matches_fitted_look(self):
        args = run_s8_look.build_parser().parse_args(["all"])
        self.assertEqual(args.reg, 0.3)


if __name__ == "__main__":
    unittest.main()
