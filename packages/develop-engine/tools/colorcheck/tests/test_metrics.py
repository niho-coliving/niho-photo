import unittest

import numpy as np

from colorcheck import color as C
from colorcheck import metrics as M


class MetricsTest(unittest.TestCase):
    def test_de_stats(self):
        d = M.de_stats(np.arange(101, dtype=float))
        self.assertEqual(d["mean"], 50.0)
        self.assertEqual(d["p50"], 50.0)
        self.assertEqual(d["p99"], 99.0)
        self.assertEqual(d["max"], 100.0)
        self.assertEqual(d["pixels"], 101)
        self.assertIsNone(M.de_stats(np.array([]))["mean"])

    def test_ev_diff(self):
        rng = np.random.default_rng(0)
        y = rng.uniform(0.03, 0.35, (50, 50))
        mask = np.ones_like(y, bool)
        self.assertAlmostEqual(M.ev_diff(y, y * 2.0, mask), 1.0, places=9)
        self.assertAlmostEqual(M.ev_diff(y, y * 0.5, mask), -1.0, places=9)

    def test_saturation_ratio_and_white(self):
        rng = np.random.default_rng(1)
        lab = np.stack([rng.uniform(30, 80, (40, 40)), rng.uniform(-40, 40, (40, 40)),
                        rng.uniform(-40, 40, (40, 40))], -1)
        lab2 = lab.copy()
        lab2[..., 1:] *= 1.2
        mask = np.ones((40, 40), bool)
        self.assertAlmostEqual(M.saturation_ratio(lab, lab2, mask), 1.2, places=9)
        gray = np.zeros((40, 40, 3))
        gray[..., 0] = 60
        gray[..., 1] = 1.5
        gray[..., 2] = -2.0
        w = M.white_estimate(gray, mask)
        self.assertAlmostEqual(w["a"], 1.5)
        self.assertAlmostEqual(w["b"], -2.0)
        self.assertEqual(w["fraction"], 1.0)

    def test_measure_identical(self):
        rng = np.random.default_rng(2)
        img = rng.uniform(0.01, 0.9, (30, 30, 3))
        mask = np.ones((30, 30), bool)
        m = M.measure(img, img, mask, img, img, mask)
        self.assertTrue(m["flatFallback"])  # random noise has no flat pixels
        self.assertEqual(m["deltaE00"]["mean"], 0.0)
        self.assertEqual(m["evDiff"], 0.0)
        self.assertEqual(m["saturationRatio"], 1.0)

    def test_flat_pixels_exclude_edges(self):
        img = np.full((40, 60, 3), 0.05)
        img[:, 30:] = 0.6                      # one hard vertical edge
        shifted = np.full((40, 60, 3), 0.05)
        shifted[:, 31:] = 0.6                  # candidate misregistered by 1 px
        mask = np.ones((40, 60), bool)
        m = M.measure(img, shifted, mask, img, shifted, mask)
        self.assertEqual(m["deltaE00"]["mean"], 0.0)          # flat pixels agree exactly
        self.assertGreater(m["deltaE00All"]["mean"], 0.0)     # the edge column shows up in the all-pixel numbers
        self.assertGreater(m["deltaE00Edges"]["mean"], 1.0)
        self.assertFalse(m["flatFallback"])
        self.assertLess(m["flatFraction"], 1.0)
        self.assertGreater(m["flatFraction"], 0.7)

    def test_median_gain(self):
        rng = np.random.default_rng(3)
        img = rng.uniform(0.05, 0.3, (30, 30, 3))
        mask = np.ones((30, 30), bool)
        self.assertAlmostEqual(M.median_gain(img, img * 0.25, mask), 4.0, places=6)
        self.assertIsNotNone(C.luminance(img, C.SPACE_LINEAR_SRGB))


if __name__ == "__main__":
    unittest.main()
