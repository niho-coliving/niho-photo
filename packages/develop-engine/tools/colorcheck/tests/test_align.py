import unittest
from unittest import mock

import numpy as np

from colorcheck import align as A
from colorcheck import color as C
from colorcheck import imageops

from . import synth


class AlignTest(unittest.TestCase):
    def _check(self, s, dx, dy, tone=1.0):
        ref_lin = synth.scene_linear_srgb(400, 600, seed=7)
        cand_lin = synth.warp(ref_lin, s, dx, dy) ** tone
        y_ref = C.luminance(ref_lin, C.SPACE_LINEAR_SRGB)
        y_cand = C.luminance(cand_lin, C.SPACE_LINEAR_SRGB)
        al = A.estimate(y_ref, y_cand)
        self.assertAlmostEqual(al.scale, s, delta=0.002)
        self.assertAlmostEqual(al.dx, dx, delta=0.6)
        self.assertAlmostEqual(al.dy, dy, delta=0.6)
        self.assertGreater(al.corr, 0.9)
        return al

    def test_identity(self):
        self._check(1.0, 0.0, 0.0)

    def test_scale_shift_with_tone_difference(self):
        self._check(1.018, 6.5, -4.2, tone=1.6)

    def test_shrink(self):
        self._check(0.975, -9.0, 5.0)

    def test_numpy_only_path(self):
        with mock.patch.object(imageops, "HAVE_CV2", False):
            self._check(1.01, 3.0, 2.0)

    def test_radial_residual(self):
        ref_lin = synth.scene_linear_srgb(600, 900, seed=11)
        k = (0.015, -0.05)
        cand_lin = synth.warp_radial(synth.warp(ref_lin, 0.99, 2.0, -1.0), k)
        y_ref = C.luminance(ref_lin, C.SPACE_LINEAR_SRGB)
        y_cand = C.luminance(cand_lin, C.SPACE_LINEAR_SRGB)
        al = A.estimate(y_ref, y_cand)
        self.assertIsNotNone(al.radial)
        self.assertEqual(al.method, "phase-correlation-tiles+radial")
        self.assertLess(al.radial.residual_px_after, 0.8 * al.radial.residual_px_before)
        without = A.Alignment(scale=al.scale, dx=al.dx, dy=al.dy, method="phase-correlation-tiles")
        self.assertGreater(al.corr, A.alignment_corr(y_ref, y_cand, without))
        j = al.to_json()
        self.assertEqual(len(j["radial"]["k"]), 2)
        # the radial term must not appear for a pure similarity warp
        al2 = A.estimate(y_ref, C.luminance(synth.warp(ref_lin, 1.01, 3.0, 2.0), C.SPACE_LINEAR_SRGB))
        self.assertIsNone(al2.radial)

    def test_remap_identity(self):
        img = synth.scene_linear_srgb(40, 60, seed=3)
        ys, xs = np.mgrid[0:40, 0:60]
        out, valid = imageops.remap(img, xs.astype(float), ys.astype(float))
        self.assertTrue(np.allclose(out, img))
        self.assertTrue(valid.all())
        out2, valid2 = imageops.remap(img, xs + 3.0, ys.astype(float))
        self.assertFalse(valid2[:, -3:].any())

    def test_apply_valid_mask(self):
        img = np.ones((50, 80, 3))
        out, valid = A.apply(img, A.Alignment(scale=1.0, dx=5.0, dy=0.0, method="phase-correlation"), (50, 80))
        self.assertFalse(valid[:, :5].any())
        self.assertTrue(valid[:, 5:].all())


if __name__ == "__main__":
    unittest.main()
