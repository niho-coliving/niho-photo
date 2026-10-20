import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

import numpy as np

LENS_CHECK_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, LENS_CHECK_DIR)

import lens_geom  # noqa: E402


class LensGeometryTest(unittest.TestCase):
    def test_no_valid_tiles_returns_empty_measurements(self):
        image = np.zeros((10, 10), dtype=float)
        alignment = types.SimpleNamespace(scale=1.0, dx=0.0, dy=0.0, corr=0.9, radial=None)
        empty_centers = np.empty((0, 2))
        empty_shifts = np.empty((0, 2))
        empty_peaks = np.empty((0,))

        with mock.patch.object(lens_geom, "lum", side_effect=[(image, 3000), (image, 3000)]), \
                mock.patch.object(lens_geom.A, "estimate", return_value=alignment), \
                mock.patch.object(lens_geom.imageops, "warp_scale_shift", return_value=(image, None)), \
                mock.patch.object(lens_geom.A, "_bandpass_log", return_value=image), \
                mock.patch.object(lens_geom.A, "_tile_shifts", return_value=(empty_centers, empty_shifts, empty_peaks)):
            result = lens_geom.measure("reference.jpg", "candidate.tiff", "linear-prophoto")

        self.assertEqual(result["tiles"], 0)
        self.assertIsNone(result["residualPxRms"])
        self.assertIsNone(result["residualPxMax"])
        self.assertIsNone(result["outerPxMean"])

    def test_cli_formats_missing_residuals_and_writes_json(self):
        result = {
            "scale": 1.0,
            "corr": 0.9,
            "radialAccepted": False,
            "tiles": 0,
            "residualPxRms": None,
            "residualPxMax": None,
            "outerPxMean": None,
            "fullResLongEdge": 3000,
        }
        with tempfile.TemporaryDirectory() as root:
            output = os.path.join(root, "measurements.json")
            stdout = io.StringIO()
            with mock.patch.object(lens_geom, "measure", return_value=result), \
                    mock.patch.object(lens_geom.sys, "argv", ["lens_geom.py", output, "empty", "ref.jpg", "cand.tiff", "linear-prophoto"]), \
                    contextlib.redirect_stdout(stdout):
                lens_geom.main()

            with open(output, encoding="utf-8") as source:
                rows = json.load(source)

        self.assertIn("残差 RMS n/a  最大 n/a  周辺平均 n/a", stdout.getvalue())
        self.assertEqual(rows[0]["tiles"], 0)
        self.assertIsNone(rows[0]["residualPxMax"])


if __name__ == "__main__":
    unittest.main()
