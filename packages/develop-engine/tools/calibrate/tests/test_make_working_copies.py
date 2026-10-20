import os
import sys
import unittest

import numpy as np

CALIBRATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLORCHECK_DIR = os.path.join(os.path.dirname(CALIBRATE_DIR), "colorcheck")
sys.path.insert(0, COLORCHECK_DIR)
sys.path.insert(0, CALIBRATE_DIR)

from colorcheck.calibration import SCHEMA, from_dict  # noqa: E402
from make_working_copies import gamut_mapping_is_disabled, matrix_for_scene  # noqa: E402


class WorkingCopyMatrixTest(unittest.TestCase):
    def test_table_requires_explicit_gamut_mapping_off(self):
        self.assertTrue(gamut_mapping_is_disabled({
            "appliedSettings": {"assigned": {"isGamutMappingEnabled": False}},
        }))
        for meta in (
            {},
            {"appliedSettings": {"assigned": {"isGamutMappingEnabled": True}}},
            {"appliedSettings": {"assigned": {"isGamutMappingEnabled": "false"}}},
            {"appliedSettings": {"gamutMapping": {"resolved": "off"}}},
        ):
            with self.subTest(meta=meta):
                self.assertFalse(gamut_mapping_is_disabled(meta))

    def test_two_illuminant_calibration_uses_each_scenes_neutral_temperature(self):
        calibration = from_dict({
            "schema": SCHEMA,
            "matrix": {"rowMajor": np.eye(3).tolist()},
            "illuminants": [
                {"neutralTemperatureK": 3400, "matrix": (2 * np.eye(3)).tolist()},
                {"neutralTemperatureK": 4900, "matrix": (4 * np.eye(3)).tolist()},
            ],
        })

        low = matrix_for_scene(calibration, {"temperatureK": 3400}, "low")
        high = matrix_for_scene(calibration, {"temperatureK": 4900}, "high")
        middle = matrix_for_scene(calibration, {"temperatureK": 4100}, "middle")

        np.testing.assert_array_equal(low, 2 * np.eye(3))
        np.testing.assert_array_equal(high, 4 * np.eye(3))
        self.assertTrue(np.all(np.diag(middle) > 2))
        self.assertTrue(np.all(np.diag(middle) < 4))
        self.assertFalse(np.allclose(middle, 3 * np.eye(3)))

    def test_two_illuminant_calibration_requires_scene_temperature(self):
        calibration = from_dict({
            "schema": SCHEMA,
            "matrix": {"rowMajor": np.eye(3).tolist()},
            "illuminants": [
                {"neutralTemperatureK": 3400, "matrix": np.eye(3).tolist()},
                {"neutralTemperatureK": 4900, "matrix": (2 * np.eye(3)).tolist()},
            ],
        })

        with self.assertRaisesRegex(ValueError, "missing-scene.*neutral.temperatureK"):
            matrix_for_scene(calibration, {}, "missing-scene")


if __name__ == "__main__":
    unittest.main()
