import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

CALIBRATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, CALIBRATE_DIR)

from make_lr_round6 import NEUTRAL  # noqa: E402
import make_lr_round8  # noqa: E402
from make_lr_round8 import SCENES, variants  # noqa: E402


class Round8VariantsTest(unittest.TestCase):
    def test_every_variant_keeps_the_round6_neutral_base(self):
        for name, settings in variants().items():
            for key, value in NEUTRAL.items():
                self.assertEqual(settings[key], value, f"{name}.{key}")
            self.assertNotIn("Look", settings)
            self.assertNotIn("GrainSeed", settings)

    def test_black_and_white_variants_write_every_mixer_band(self):
        table = variants()
        for name in ("bw", "bw_warm", "bw_cool", "bw_toned", "film_bw"):
            mixers = [k for k in table[name] if k.startswith("GrayMixer")]
            self.assertEqual(len(mixers), 8, name)
            self.assertEqual(table[name]["ConvertToGrayscale"], "True")
        self.assertEqual(table["bw_warm"]["GrayMixerBlue"], "-40")
        self.assertEqual(table["bw_cool"]["GrayMixerBlue"], "40")

    def test_vignette_variants_carry_every_shape_key(self):
        table = variants()
        for name in ("vig_m50", "vig_m100", "vig_p50", "vig_shape", "vig_square", "vig_color", "vig_paint"):
            keys = {k for k in table[name] if k.startswith("PostCropVignette")}
            self.assertEqual(len(keys), 6, name)
        self.assertEqual(table["vig_color"]["PostCropVignetteStyle"], "2")
        self.assertEqual(table["vig_paint"]["PostCropVignetteStyle"], "3")

    def test_scene_list_mixes_both_cameras_and_orientations(self):
        self.assertEqual(len(SCENES), 6)
        self.assertEqual(len(set(SCENES)), 6)
        self.assertTrue(any(s.startswith("DSC") for s in SCENES))
        self.assertTrue(any(s.startswith("P") for s in SCENES))

    def test_check_validates_every_effect_parameter_in_the_manifest(self):
        settings = {
            "ConvertToGrayscale": "True",
            "GrayMixerBlue": "-40",
            "PostCropVignetteMidpoint": "25",
            "GrainAmount": "30",
            "GrainSize": "40",
            "GrainFrequency": "70",
        }
        xmp = '<rdf:Description crs:CameraProfile="Adobe Standard" ' + " ".join(
            f'crs:{key}="{value}"' for key, value in settings.items()
        ) + "/>"

        with tempfile.TemporaryDirectory() as temporary:
            round_dir = Path(temporary)
            export_dir = round_dir / make_lr_round8.EXPORT_DIR
            export_dir.mkdir()
            (export_dir / "photo.jpg").touch()
            manifest_path = round_dir / "manifest.json"
            entry = {"file": "photo.raw", "settings": settings}

            def run_check() -> int:
                manifest_path.write_text(json.dumps([entry]), encoding="utf-8")
                with contextlib.redirect_stdout(io.StringIO()):
                    return make_lr_round8.check(round_dir)

            with patch.object(make_lr_round8, "export_xmp", return_value=xmp):
                self.assertEqual(run_check(), 0)
                for key in ("GrayMixerBlue", "PostCropVignetteMidpoint", "GrainSize", "GrainFrequency"):
                    original = entry["settings"][key]
                    entry["settings"][key] = "999"
                    self.assertEqual(run_check(), 1, key)
                    entry["settings"][key] = original
                # 書き出しに無い「ハイライト」は、期待が 0 のときだけ通す。
                entry["settings"]["PostCropVignetteHighlightContrast"] = "0"
                self.assertEqual(run_check(), 0)
                entry["settings"]["PostCropVignetteHighlightContrast"] = "50"
                self.assertEqual(run_check(), 1)


if __name__ == "__main__":
    unittest.main()
