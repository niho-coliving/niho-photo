import os
import sys
import unittest
from unittest import mock

import cv2
import numpy as np

LENS_CHECK_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, LENS_CHECK_DIR)

import lateral_ca  # noqa: E402


def textured(h, w, seed=0):
    rng = np.random.default_rng(seed)
    noise = rng.random((h // 8, w // 8)).astype(np.float32)
    return cv2.resize(noise, (w, h), interpolation=cv2.INTER_CUBIC).clip(0.05, 0.9)


def radially_scaled(plane, scale):
    """Magnify `plane` about the image centre by `scale` (a channel whose image is bigger than G by `scale`)."""
    h, w = plane.shape
    cx, cy = (w - 1) / 2, (h - 1) / 2
    m = np.array([[scale, 0, cx - scale * cx], [0, scale, cy - scale * cy]], dtype=np.float32)
    return cv2.warpAffine(plane, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)


class LateralCaTest(unittest.TestCase):
    def test_measures_known_radial_magnification(self):
        h, w = 640, 960
        g = textured(h, w)
        half_diagonal = np.hypot((w - 1) / 2, (h - 1) / 2)
        corner_shift = 1.5  # px at the corner
        img = np.dstack([radially_scaled(g, 1 + corner_shift / half_diagonal), g, g]).astype(np.float32)
        red = lateral_ca.radial_shift(img, 0)
        blue = lateral_ca.radial_shift(img, 2)
        self.assertIsNotNone(red)
        self.assertAlmostEqual(red["cornerPx"], corner_shift, delta=0.25)
        self.assertAlmostEqual(blue["cornerPx"], 0.0, delta=0.1)

    def test_flat_image_has_no_measurement(self):
        img = np.full((320, 480, 3), 0.5, dtype=np.float32)
        self.assertIsNone(lateral_ca.radial_shift(img, 0))

    def test_central_texture_without_enough_far_tiles_has_no_measurement(self):
        h, w = 640, 960
        half_diagonal = np.hypot((w - 1) / 2, (h - 1) / 2)
        y, x = np.ogrid[:h, :w]
        radius = np.hypot(x - (w - 1) / 2, y - (h - 1) / 2)
        green = np.full((h, w), 0.5, dtype=np.float32)
        green[radius < 0.4 * half_diagonal] = textured(h, w)[radius < 0.4 * half_diagonal]
        img = np.dstack([green, green, green])

        with mock.patch.object(
            lateral_ca.cv2, "phaseCorrelate", return_value=((0.0, 0.0), 1.0)
        ) as phase:
            self.assertIsNone(lateral_ca.radial_shift(img, 0))
        self.assertGreaterEqual(phase.call_count, lateral_ca.MIN_VALID_TILES * 2)

    def test_saturated_green_or_measurement_channel_excludes_tiles(self):
        h, w = 640, 960
        plane = textured(h, w)
        img = np.dstack([plane, plane, plane]).astype(np.float32)
        with mock.patch.object(lateral_ca.cv2, "phaseCorrelate", return_value=((0.0, 0.0), 1.0)) as phase:
            lateral_ca.radial_shift(img, 0)
            unsaturated_calls = phase.call_count
        self.assertGreater(unsaturated_calls, 0)

        for channel in (0, 1, 2):
            with self.subTest(channel=channel):
                saturated = img.copy()
                saturated[160:224, 256:320, channel] = 1.0
                measured_channel = 2 if channel == 2 else 0
                with mock.patch.object(
                    lateral_ca.cv2, "phaseCorrelate", return_value=((0.0, 0.0), 1.0)
                ) as phase:
                    lateral_ca.radial_shift(saturated, measured_channel)
                self.assertLess(phase.call_count, unsaturated_calls)


if __name__ == "__main__":
    unittest.main()
