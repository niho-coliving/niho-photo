import json
import os
import sys
import unittest
from unittest.mock import patch

import numpy as np

CALIBRATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, CALIBRATE_DIR)

from look import STAGE_POINT_CURVE, STAGE_PRE_ACR3, Look, hsv_to_rgb, rgb_to_hsv  # noqa: E402
from make_lr_round7 import look_resolved  # noqa: E402

CRATE_LOOK = os.path.join(CALIBRATE_DIR, "..", "..", "crates", "niho-develop", "looks", "niho-standard-1.json")


class LookTest(unittest.TestCase):
    def test_identity_is_identity_for_both_stages(self):
        rgb = np.random.default_rng(1).random((64, 3))
        for stage in (STAGE_PRE_ACR3, STAGE_POINT_CURVE):
            look = Look.identity(tone_stage=stage)
            np.testing.assert_allclose(look.point_curve(look.pre_acr3(rgb)), rgb, atol=1e-12)

    def test_hsv_round_trip(self):
        rgb = np.random.default_rng(2).random((64, 3))
        np.testing.assert_allclose(hsv_to_rgb(*rgb_to_hsv(rgb)), rgb, atol=1e-12)

    def test_standard_1_keeps_grays_gray_and_monotone(self):
        look = Look.load(CRATE_LOOK)
        g = np.linspace(0.0, 1.0, 257)
        out = look.point_curve(look.pre_acr3(np.repeat(g[:, None], 3, axis=1)))
        np.testing.assert_allclose(out[:, 0], out[:, 1], atol=1e-12)
        np.testing.assert_allclose(out[:, 1], out[:, 2], atol=1e-12)
        self.assertTrue(np.all(np.diff(out[:, 0]) >= -1e-12))
        self.assertAlmostEqual(out[0, 0], 0.0, places=12)
        self.assertAlmostEqual(out[-1, 0], 1.0, places=12)

    def test_json_round_trip_keeps_the_stage(self):
        look = Look.load(CRATE_LOOK)
        self.assertEqual(look.tone_stage, STAGE_POINT_CURVE)
        again = Look.from_json(json.loads(json.dumps(look.to_json())))
        rgb = np.random.default_rng(3).random((32, 3))
        np.testing.assert_allclose(again.point_curve(again.pre_acr3(rgb)), look.point_curve(look.pre_acr3(rgb)), atol=1e-9)

    def test_space_must_match_stage(self):
        d = Look.identity().to_json()
        d["tone"]["space"] = "srgb-encoded"
        with self.assertRaises(ValueError):
            Look.from_json(d)


class Round7CheckTest(unittest.TestCase):
    def test_stubbed_look_is_not_resolved(self):
        profile_id = "0123456789ABCDEF0123456789ABCDEF"
        stub = f'<crs:Look><rdf:Description crs:Name="Adobe Color" crs:UUID="{profile_id}"></rdf:Description></crs:Look>'
        resolved = (f'<crs:Look><rdf:Description crs:Name="Adobe Color" crs:UUID="{profile_id}">'
                    '<crs:Parameters><rdf:Description crs:LookTable="0123"/></crs:Parameters></rdf:Description></crs:Look>')
        with patch.dict(os.environ, {"NIHO_ADOBE_COLOR_PROFILE_ID": profile_id}):
            self.assertFalse(look_resolved(stub))
            self.assertTrue(look_resolved(resolved))
            self.assertFalse(look_resolved("<x/>"))


if __name__ == "__main__":
    unittest.main()
