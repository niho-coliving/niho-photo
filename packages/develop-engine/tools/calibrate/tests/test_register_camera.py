"""register_camera.py の決まり（#18398）: camera id・train / val の分け方・機種の設定・登録表の書き方・gate。

実データ（RAW・Lightroom の書き出し・Apple の現像）を使う手順は runbook の「新しい機種を登録する」で回す。
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import register_camera as R  # noqa: E402
import make_lr_round6 as LR  # noqa: E402


def config(**overrides):
    base = {
        "schema": R.CONFIG_SCHEMA,
        "camera": {"make": "Canon", "model": "Canon EOS R6", "id": "canon-eos-r6"},
        "scenes": ["IMG_0001", "IMG_0002", "IMG_0003", "IMG_0004"],
        "valScenes": ["IMG_0002", "IMG_0004"],
        "lens": {"mode": "apple"},
        "illuminantNodes": "3400,5100",
    }
    base.update(overrides)
    return base


class CameraIdTest(unittest.TestCase):
    def test_id_is_the_slug_of_make_and_model_without_a_repeated_make(self):
        self.assertEqual(R.camera_id("Canon", "Canon EOS R6"), "canon-eos-r6")
        self.assertEqual(R.camera_id("SONY", "ILME-FX30"), "sony-ilme-fx30")
        self.assertEqual(R.camera_id("Panasonic", "DC-S5"), "panasonic-dc-s5")
        self.assertEqual(R.camera_id(" FUJIFILM ", "X-T5 "), "fujifilm-x-t5")
        # apple-raw-linear と同じく、make 全体が先頭にあるときだけ外す
        self.assertEqual(R.camera_id("NIKON CORPORATION", "NIKON Z 6_2"), "nikon-corporation-nikon-z-6-2")
        self.assertEqual(R.normalized_model("Panasonic", "Panasonic DC-S5"), "DC-S5")

    def test_the_built_in_cameras_keep_their_ids(self):
        for make, model, cid in (("Panasonic", "DC-S5", "panasonic-dc-s5"), ("SONY", "ZV-E10M2", "sony-zv-e10m2"),
                                 ("SONY", "ILME-FX30", "sony-ilme-fx30")):
            self.assertEqual(R.camera_id(make, model), cid)
            self.assertIn(cid, R.BUILTIN_CAMERAS)


class RawExtensionTest(unittest.TestCase):
    def test_registration_and_lightroom_search_match_the_app_raw_list(self):
        source = (R.ROOT / "apps/api/src/ops/photo-cloud.ts").read_text(encoding="utf-8")

        def array(name):
            start = source.index(name)
            start = source.index("=", start)
            start = source.index("[", start)
            end = source.index("]", start)
            return set(re.findall(r'"([a-z0-9]+)"', source[start:end]))

        app_files = array("PHOTO_CLOUD_FILE_EXTENSIONS")
        non_raw = array("PHOTO_CLOUD_NON_RAW_EXTENSIONS")
        expected = {f".{extension}" for extension in app_files - non_raw}
        self.assertEqual(R.RAW_SUFFIXES, expected)
        self.assertEqual(LR.RAW_SUFFIXES, expected)


class SplitTest(unittest.TestCase):
    def test_dates_alternate_so_a_days_shots_stay_on_one_side(self):
        scenes = {"A1": "2026:09:01 10:00:00", "A2": "2026:09:01 10:05:00", "B1": "2026:09:02 09:00:00",
                  "C1": "2026:09:03 12:00:00", "C2": "2026:09:03 12:01:00", "D1": "2026:09:04 08:00:00"}
        train, val = R.split_scenes(scenes)
        self.assertEqual(train, ["A1", "A2", "C1", "C2"])
        self.assertEqual(val, ["B1", "D1"])

    def test_one_date_alternates_by_name(self):
        scenes = {f"P{i}": "2026:09:01 10:00:00" for i in range(1, 6)}
        self.assertEqual(R.split_scenes(scenes), (["P1", "P3", "P5"], ["P2", "P4"]))

    def test_a_lopsided_date_split_falls_back_to_names(self):
        # 2 日目に 3 枚・1 日目に 1 枚なら train が 1 場面になるので名前の交互にする
        scenes = {"A1": "2026:09:01 10:00:00", "B1": "2026:09:02 10:00:00", "B2": "2026:09:02 10:01:00",
                  "B3": "2026:09:02 10:02:00"}
        self.assertEqual(R.split_scenes(scenes), (["A1", "B2"], ["B1", "B3"]))

    def test_missing_dates_count_as_one_date(self):
        self.assertEqual(R.split_scenes({"X1": "", "X2": "", "X3": "", "X4": ""}), (["X1", "X3"], ["X2", "X4"]))


class ConfigTest(unittest.TestCase):
    def test_a_valid_config(self):
        self.assertIs(R.validate_config(config())["camera"]["id"], "canon-eos-r6")

    def test_invalid_configs(self):
        cases = {
            "schema": config(schema="v0"),
            "camera": config(camera={"make": "Canon", "model": "", "id": "canon-eos-r6"}),
            "id": config(camera={"make": "Canon", "model": "EOS R6", "id": "Canon_EOS"}),
            "few scenes": config(scenes=["A", "B", "C"], valScenes=["B"]),
            "duplicates": config(scenes=["A", "A", "B", "C"], valScenes=["B"]),
            "val outside": config(valScenes=["IMG_9999"]),
            "val everything": config(valScenes=["IMG_0001", "IMG_0002", "IMG_0003", "IMG_0004"]),
            "train of one": config(valScenes=["IMG_0002", "IMG_0003", "IMG_0004"]),
            "scene name": config(scenes=["IMG 1", "IMG_0002", "IMG_0003", "IMG_0004"]),
            "lens off": config(lens={"mode": "off"}),
            "nodes": config(illuminantNodes="3400"),
        }
        for label, value in cases.items():
            with self.subTest(label), self.assertRaises(R.RegistrationError):
                R.validate_config(value)

    def test_shell_vars_are_quoted_for_run_dc_s5_apple(self):
        text = R.shell_vars(config(camera={"make": "Canon", "model": "Canon EOS R6", "id": "canon-eos-r6"}))
        self.assertIn("MAKE=Canon\n", text)
        self.assertIn("MODEL='Canon EOS R6'\n", text)
        self.assertIn("SCENES=(IMG_0001 IMG_0002 IMG_0003 IMG_0004)\n", text)
        self.assertIn("VAL_SCENES=(IMG_0002 IMG_0004)\n", text)
        self.assertIn("SAMPLE_SCENES=()\n", text)
        out = subprocess.run(["bash", "-c", text + 'printf "%s|%s|%s|%s" "$MODEL" "${#SCENES[@]}" "${VAL_SCENES[1]}" "$ILLUMINANT_NODES"'],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(out, "Canon EOS R6|4|IMG_0004|3400,5100")
        self.assertEqual(shlex.split("MODEL='Canon EOS R6'")[0], "MODEL=Canon EOS R6")


class RegistryTest(unittest.TestCase):
    def registry(self):
        return {
            "schema": R.REGISTRY_SCHEMA,
            "track": "apple",
            "$comment": "説明",
            "cameras": [
                {"make": "Panasonic", "model": "DC-S5", "file": "panasonic-dc-s5/apple-v4.json"},
                {"make": "SONY", "model": "ZV-E10M2", "file": "sony-zv-e10m2/apple-v3.json"},
            ],
            "fallback": {"file": "generic/apple-v1.json"},
        }

    def test_the_repository_registry_keeps_its_layout(self):
        text = R.REGISTRY.read_text(encoding="utf-8")
        self.assertEqual(R.registry_text(json.loads(text)), text)

    def test_a_new_camera_goes_last_and_the_fallback_stays(self):
        updated, previous = R.with_camera(self.registry(), "Canon", "Canon EOS R6", "canon-eos-r6/apple-v1.json")
        self.assertIsNone(previous)
        self.assertEqual(updated["cameras"][-1], {"make": "Canon", "model": "Canon EOS R6", "file": "canon-eos-r6/apple-v1.json"})
        self.assertEqual(updated["fallback"], {"file": "generic/apple-v1.json"})
        text = R.registry_text(updated)
        self.assertIn('    { "make": "Canon", "model": "Canon EOS R6", "file": "canon-eos-r6/apple-v1.json" }\n  ],\n', text)
        self.assertEqual(json.loads(text), updated)

    def test_the_same_camera_replaces_its_file_in_place(self):
        updated, previous = R.with_camera(self.registry(), "Sony", "Sony ZV-E10M2", "sony-zv-e10m2/apple-v4.json")
        self.assertEqual(previous, "sony-zv-e10m2/apple-v3.json")
        self.assertEqual(len(updated["cameras"]), 2)
        self.assertEqual(updated["cameras"][1], {"make": "SONY", "model": "ZV-E10M2", "file": "sony-zv-e10m2/apple-v4.json"})

    def test_a_registry_without_a_fallback_has_no_fallback_line(self):
        registry = self.registry()
        del registry["fallback"]
        text = R.registry_text(registry)
        self.assertNotIn("fallback", text)
        self.assertTrue(text.endswith('"sony-zv-e10m2/apple-v3.json" }\n  ]\n}\n'))
        self.assertEqual(json.loads(text), registry)

    def test_unknown_keys_and_shapes_are_refused(self):
        with self.assertRaises(R.RegistrationError):
            R.with_camera({**self.registry(), "extra": 1}, "Canon", "EOS R6", "x.json")
        with self.assertRaises(R.RegistrationError):
            R.with_camera({**self.registry(), "schema": "v0"}, "Canon", "EOS R6", "x.json")


class GateTest(unittest.TestCase):
    def rows(self, none, generic, own):
        return {name: {"all": {"n": 4, "mean": value, "p99": 5.0}, "val": {"n": 2, "mean": value, "p99": 5.0}}
                for name, value in (("none", none), ("generic", generic), ("own", own))}

    def test_passes_when_within_the_gate_and_better_than_both(self):
        result = R.gate_result(self.rows(4.5, 1.5, 0.9), "v1")
        self.assertTrue(result["passed"])
        self.assertEqual(result["version"], "v1")

    def test_fails_outside_the_gate_or_not_better(self):
        for label, rows in {"over 2.0": self.rows(4.5, 2.5, 2.1), "not better than the generic": self.rows(4.5, 1.0, 1.1),
                            "not better than none": self.rows(1.0, 1.2, 1.1)}.items():
            with self.subTest(label):
                self.assertFalse(R.gate_result(rows, "v1")["passed"])


class GateBindingTest(unittest.TestCase):
    def test_register_gate_is_bound_to_the_calibration_bytes_that_were_measured(self):
        with tempfile.TemporaryDirectory() as directory:
            calibration = os.path.join(directory, "apple-v1.json")
            with open(calibration, "wb") as target:
                target.write(b'{"version":"v1","matrix":[1]}')
            calibration_path = Path(calibration)
            gate = {"passed": True, "calibrationSha256": R.calibration_sha256(calibration_path)}
            self.assertTrue(R.gate_matches_calibration(gate, calibration_path))

            with open(calibration, "wb") as target:
                target.write(b'{"version":"v1","matrix":[2]}')
            self.assertFalse(R.gate_matches_calibration(gate, calibration_path))
            self.assertFalse(R.gate_matches_calibration({"passed": True}, calibration_path))


class RunScriptTest(unittest.TestCase):
    def test_run_dc_s5_apple_reads_a_configured_camera(self):
        cid = "zz-test-camera"
        path = R.config_path(cid)
        self.assertFalse(path.exists())
        with tempfile.TemporaryDirectory() as work:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(config(camera={"make": "ZZ", "model": "Test Camera", "id": cid})), encoding="utf-8")
                env = {**os.environ, "NIHO_COLOR_WORK_DIR": work, "NIHO_COLOR_REF_ROOT": os.path.join(work, "no-ref")}
                # render は機種の設定の場面の RAW を round6/ に探す（無いので最初の場面で止まる）
                result = subprocess.run(["bash", str(R.RUN), "render", "--camera", cid], capture_output=True, text=True, env=env)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("round6/IMG_0001.*", result.stderr)
                self.assertTrue(os.path.isdir(os.path.join(work, cid, "apple-linear")), "the camera's own work dir")
                unknown = subprocess.run(["bash", str(R.RUN), "render", "--camera", "zz-none"], capture_output=True, text=True, env=env)
                self.assertEqual(unknown.returncode, 2)
                self.assertIn("unknown camera: zz-none", unknown.stderr)
            finally:
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
