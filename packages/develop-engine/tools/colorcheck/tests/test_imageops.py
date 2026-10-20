import unittest

import numpy as np

from colorcheck import imageops as I


@unittest.skipUnless(I.HAVE_CV2, "cv2 not available")
class Cv2NumpyParityTest(unittest.TestCase):
    def setUp(self):
        self.a = np.random.default_rng(0).random((61, 89, 3)).astype(np.float32)

    def test_blur(self):
        for s in (0.8, 2.0, 4.0):
            np.testing.assert_allclose(I.gaussian_blur(self.a, s, True), I.gaussian_blur(self.a, s, False), atol=1e-5)

    def test_area_resize(self):
        for size in ((30, 20), (44, 31), (89, 61), (13, 9)):
            np.testing.assert_allclose(I.resize(self.a, size, True), I.resize(self.a, size, False), atol=1e-5)


class ImageOpsTest(unittest.TestCase):
    def test_area_average_exact(self):
        a = np.arange(16, dtype=np.float64).reshape(4, 4, 1)
        out = I.resize(np.repeat(a, 3, axis=2), (2, 2), False)
        np.testing.assert_allclose(out[..., 0], [[2.5, 4.5], [10.5, 12.5]])

    def test_size_for_long_edge(self):
        self.assertEqual(I.size_for_long_edge(6000, 4000, 1500), (1500, 1000))
        self.assertEqual(I.size_for_long_edge(1280, 1920, 1500), (1000, 1500))

    def test_blur_preserves_constant_and_mean(self):
        c = np.full((40, 50, 3), 0.3)
        np.testing.assert_allclose(I.gaussian_blur(c, 2.0, False), c, atol=1e-12)

    def test_blur_masked_no_leak(self):
        img = np.full((40, 60, 3), 0.5)
        img[:, :10] = 100.0  # garbage outside the mask
        mask = np.ones((40, 60), bool)
        mask[:, :10] = False
        out, valid = I.blur_masked(img, mask, 2.0, False)
        np.testing.assert_allclose(out[:, 12:], 0.5, atol=1e-9)
        self.assertFalse(valid[:, :10].any())
        self.assertTrue(valid[:, 20:].all())

    def test_warp(self):
        a = np.random.default_rng(1).random((30, 40, 3))
        w, v = I.warp_scale_shift(a, 1.0, 0.0, 0.0, (30, 40))
        np.testing.assert_allclose(w, a)
        self.assertTrue(v.all())
        w, v = I.warp_scale_shift(a, 1.0, 3.0, -2.0, (30, 40))
        np.testing.assert_allclose(w[:-2, 3:], a[2:, :-3])
        self.assertFalse(v[:, :3].any())
        self.assertFalse(v[-2:, :].any())

    def test_crop_box(self):
        self.assertEqual(I.crop_box(1000, 1500, 0.04), (40, 960, 60, 1440))


if __name__ == "__main__":
    unittest.main()
