import os
import sys
import unittest

CALIBRATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, CALIBRATE_DIR)

from make_lr_round6 import NEUTRAL  # noqa: E402
import make_lr_round8  # noqa: E402
from make_lr_round9 import BANDS, SHAPE_AMOUNT, variants  # noqa: E402


class Round9VariantsTest(unittest.TestCase):
    def test_every_variant_keeps_the_round6_neutral_base(self):
        for name, settings in variants().items():
            for key, value in NEUTRAL.items():
                self.assertEqual(settings[key], value, f"{name}.{key}")
            self.assertNotIn("Look", settings)
            self.assertNotIn("GrainSeed", settings)

    def test_shape_variants_change_one_key_from_the_round8_default(self):
        table = variants()
        default = make_lr_round8.vignette(SHAPE_AMOUNT)
        for name, key, value in (
            ("vig_mid0", "PostCropVignetteMidpoint", "0"),
            ("vig_mid100", "PostCropVignetteMidpoint", "100"),
            ("vig_fea0", "PostCropVignetteFeather", "0"),
            ("vig_fea100", "PostCropVignetteFeather", "100"),
            ("vig_round_p100", "PostCropVignetteRoundness", "100"),
            ("vig_round_m100", "PostCropVignetteRoundness", "-100"),
            ("vig_hc50", "PostCropVignetteHighlightContrast", "50"),
            ("vig_hc100", "PostCropVignetteHighlightContrast", "100"),
        ):
            changed = {k for k in default if table[name][k] != default[k]}
            self.assertEqual(changed, {key}, name)
            self.assertEqual(table[name][key], value, name)

    def test_bright_variants_cover_the_three_styles(self):
        table = variants()
        self.assertEqual((table["vig_p100"]["PostCropVignetteAmount"], table["vig_p100"]["PostCropVignetteStyle"]), ("100", "1"))
        self.assertEqual((table["vig_color_p50"]["PostCropVignetteAmount"], table["vig_color_p50"]["PostCropVignetteStyle"]), ("50", "2"))
        self.assertEqual((table["vig_paint_p50"]["PostCropVignetteAmount"], table["vig_paint_p50"]["PostCropVignetteStyle"]), ("50", "3"))

    def test_grain_and_mixer_extremes(self):
        table = variants()
        self.assertEqual((table["grain_size0"]["GrainSize"], table["grain_size100"]["GrainSize"]), ("0", "100"))
        self.assertEqual((table["grain_rough0"]["GrainFrequency"], table["grain_rough100"]["GrainFrequency"]), ("0", "100"))
        for name, value in (("bw_all_p100", "100"), ("bw_all_m100", "-100")):
            self.assertEqual(table[name]["ConvertToGrayscale"], "True")
            self.assertEqual([table[name][f"GrayMixer{band}"] for band in BANDS], [value] * 8, name)

    def test_every_effect_key_is_checked_after_the_export(self):
        for name, settings in variants().items():
            extra = [k for k in settings if k not in NEUTRAL and not make_lr_round8.is_effect_key(k)]
            self.assertEqual(extra, [], name)


if __name__ == "__main__":
    unittest.main()
