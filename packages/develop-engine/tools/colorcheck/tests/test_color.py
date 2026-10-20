import unittest

import numpy as np

from colorcheck import color as C


class DeltaE00Test(unittest.TestCase):
    # Sharma, Wu, Dalal (2005) test data.
    PAIRS = [
        ((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485), 2.0425),
        ((50.0, 0.0, 0.0), (50.0, -1.0, 2.0), 2.3669),
        ((50.0, 2.5, 0.0), (73.0, 25.0, -18.0), 27.1492),
        ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
        ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
    ]

    def test_known_pairs(self):
        for a, b, expected in self.PAIRS:
            self.assertAlmostEqual(float(C.delta_e00(a, b)), expected, delta=0.0005, msg=f"{a} vs {b}")

    def test_vectorized_and_symmetric(self):
        a = np.array([p[0] for p in self.PAIRS])
        b = np.array([p[1] for p in self.PAIRS])
        exp = np.array([p[2] for p in self.PAIRS])
        np.testing.assert_allclose(C.delta_e00(a, b), exp, atol=5e-4)
        np.testing.assert_allclose(C.delta_e00(b, a), exp, atol=5e-4)
        grid = np.stack([a, b])  # (2, 5, 3) leading axes
        self.assertEqual(C.delta_e00(grid, grid).shape, (2, 5))
        self.assertTrue(np.all(C.delta_e00(grid, grid) == 0))

    def test_float32_close(self):
        a = np.array([p[0] for p in self.PAIRS], dtype=np.float32)
        b = np.array([p[1] for p in self.PAIRS], dtype=np.float32)
        exp = np.array([p[2] for p in self.PAIRS])
        np.testing.assert_allclose(C.delta_e00(a, b), exp, atol=2e-3)


class MatrixTest(unittest.TestCase):
    def test_srgb_white_to_prophoto_white(self):
        w = C.apply_matrix(np.ones(3), C.M_SRGB_TO_PP)
        np.testing.assert_allclose(w, np.ones(3), atol=2e-3)

    def test_whites_to_d50(self):
        np.testing.assert_allclose(C.M_SRGB_TO_XYZ_D50.sum(axis=1), C.D50_WHITE, atol=2e-4)
        np.testing.assert_allclose(C.M_PP_TO_XYZ_D50.sum(axis=1), C.D50_WHITE, atol=2e-4)
        np.testing.assert_allclose(C.linear_prophoto_to_lab(np.ones(3)), [100, 0, 0], atol=0.05)
        np.testing.assert_allclose(C.linear_srgb_to_lab(np.ones(3)), [100, 0, 0], atol=0.05)

    def test_pp_srgb_roundtrip(self):
        rng = np.random.default_rng(1)
        x = rng.random((100, 3))
        back = C.apply_matrix(C.apply_matrix(x, C.M_SRGB_TO_PP), C.M_PP_TO_SRGB)
        np.testing.assert_allclose(back, x, atol=1e-9)

    def test_float32_preserved(self):
        x = np.ones((4, 4, 3), dtype=np.float32)
        self.assertEqual(C.apply_matrix(x, C.M_SRGB_TO_PP).dtype, np.float32)


class TransferTest(unittest.TestCase):
    def test_srgb_roundtrip(self):
        v = np.linspace(0, 1, 1001)
        np.testing.assert_allclose(C.srgb_encode(C.srgb_decode(v)), v, atol=1e-12)
        np.testing.assert_allclose(C.srgb_decode(C.srgb_encode(v)), v, atol=1e-12)

    def test_srgb_known_values(self):
        self.assertAlmostEqual(float(C.srgb_decode(0.5)), 0.21404114, places=6)
        self.assertAlmostEqual(float(C.srgb_decode(0.04045)), 0.04045 / 12.92, places=9)
        self.assertAlmostEqual(float(C.srgb_encode(0.18)), 0.46135612, places=6)

    def test_8bit_lut(self):
        u = np.arange(256, dtype=np.uint8)
        np.testing.assert_allclose(C.srgb8_decode(u), C.srgb_decode(u / 255.0), atol=1e-7)
        self.assertTrue(np.array_equal(C.quantize8(C.srgb_encode(C.srgb8_decode(u))), u))

    def test_lab_roundtrip(self):
        rng = np.random.default_rng(2)
        lab = np.column_stack([rng.uniform(0, 100, 500), rng.uniform(-80, 80, 500), rng.uniform(-80, 80, 500)])
        np.testing.assert_allclose(C.xyz_to_lab(C.lab_to_xyz(lab)), lab, atol=1e-9)

    def test_mid_gray_lab(self):
        # sRGB 119/255 is ~ L* 50 in both D65 and the Bradford D50 path.
        lab = C.srgb8_to_lab(np.array([119, 119, 119], dtype=np.uint8))
        self.assertAlmostEqual(float(lab[0]), 50.0, delta=0.3)
        self.assertLess(abs(float(lab[1])) + abs(float(lab[2])), 0.05)


class ToneTest(unittest.TestCase):
    def setUp(self):
        self.curve = C.load_tone_curve()

    def test_curve_loaded(self):
        self.assertEqual(len(self.curve.y), 1025)
        self.assertEqual(float(self.curve(0.0)), 0.0)
        self.assertEqual(float(self.curve(1.0)), 1.0)
        self.assertEqual(float(self.curve(2.0)), 1.0)  # input clipped
        self.assertEqual(float(self.curve(-1.0)), 0.0)
        self.assertTrue(np.all(np.diff(self.curve.y) >= 0))
        # interpolation between nodes
        mid = float(self.curve(0.5 / 1024))
        self.assertAlmostEqual(mid, 0.5 * (self.curve.y[0] + self.curve.y[1]), places=12)

    def test_rgbtone_monotonic_gray(self):
        v = np.linspace(0, 1, 2001)
        g = np.stack([v, v, v], axis=-1)
        out = C.rgb_tone(g, self.curve)
        self.assertTrue(np.all(np.diff(out[:, 0]) >= 0))
        np.testing.assert_allclose(out[:, 0], out[:, 1])
        np.testing.assert_allclose(out[:, 0], self.curve(v))

    def test_rgbtone_monotonic_in_each_channel(self):
        rng = np.random.default_rng(3)
        base = rng.random((200, 3)) * 0.8
        for ch in range(3):
            prev = None
            for k in np.linspace(0, 0.2, 21):
                x = base.copy()
                x[:, ch] += k
                out = C.rgb_tone(x, self.curve)[:, ch]
                if prev is not None:
                    self.assertTrue(np.all(out >= prev - 1e-12))
                prev = out

    def test_rgbtone_hue_ratio_preserved(self):
        rng = np.random.default_rng(4)
        x = rng.random((500, 3))
        out = C.rgb_tone(x, self.curve)
        hi, lo = x.max(1), x.min(1)
        mid = x.sum(1) - hi - lo
        ohi, olo = out.max(1), out.min(1)
        omid = out.sum(1) - ohi - olo
        ok = hi - lo > 1e-6
        np.testing.assert_allclose(((omid - olo) / (ohi - olo))[ok], ((mid - lo) / (hi - lo))[ok], atol=1e-9)
        np.testing.assert_allclose(ohi, self.curve(hi), atol=1e-12)
        np.testing.assert_allclose(olo, self.curve(lo), atol=1e-12)
        # channel order kept
        np.testing.assert_array_equal(np.argmax(out, 1)[ok], np.argmax(x, 1)[ok])

    def test_rgbtone_equal_channels(self):
        out = C.rgb_tone(np.array([0.3, 0.3, 0.3]), self.curve)
        np.testing.assert_allclose(out, self.curve(0.3) * np.ones(3))
        out = C.rgb_tone(np.array([0.6, 0.2, 0.2]), self.curve)
        np.testing.assert_allclose(out, [self.curve(0.6), self.curve(0.2), self.curve(0.2)])

    def test_render_display(self):
        gray = np.full((2, 2, 3), 0.18)
        u8 = C.render_display(gray, 0.0, self.curve)
        self.assertEqual(u8.dtype, np.uint8)
        self.assertTrue(np.all(u8 == u8[0, 0, 0]))  # neutral stays neutral
        expected = C.quantize8(C.srgb_encode(self.curve(0.18)))
        self.assertEqual(int(u8[0, 0, 0]), int(expected))
        # +1 EV equals doubling the input
        np.testing.assert_array_equal(C.render_display(gray, 1.0, self.curve), C.render_display(gray * 2, 0.0, self.curve))
        # white clips to 255, negatives to 0
        self.assertTrue(np.all(C.render_display(np.full((1, 1, 3), 4.0), 0.0, self.curve) == 255))
        self.assertTrue(np.all(C.render_display(np.full((1, 1, 3), -1.0), 0.0, self.curve) == 0))

    def test_display_encode(self):
        self.assertTrue(np.all(C.display_encode(np.ones((1, 3))) == 255))
        self.assertTrue(np.all(C.display_encode(np.zeros((1, 3))) == 0))


class HueSatTest(unittest.TestCase):
    def test_hsv_roundtrip(self):
        rng = np.random.default_rng(5)
        x = rng.random((1000, 3))
        h, s, v = C.rgb_to_hsv6(x)
        np.testing.assert_allclose(C.hsv6_to_rgb(h, s, v), x, atol=1e-12)

    def test_identity_table(self):
        rng = np.random.default_rng(6)
        x = rng.random((1000, 3))
        ident = [[0.0, 1.0]] * 12
        np.testing.assert_allclose(C.apply_huesat(x, ident), x, atol=1e-12)

    def test_shift_and_scale(self):
        red = np.array([[1.0, 0.0, 0.0]])
        # +120 deg everywhere: red -> green
        out = C.apply_huesat(red, [[120.0, 1.0]] * 12)
        np.testing.assert_allclose(out, [[0.0, 1.0, 0.0]], atol=1e-12)
        # saturation 0 everywhere -> gray at value
        out = C.apply_huesat(np.array([[0.8, 0.4, 0.2]]), [[0.0, 0.0]] * 12)
        np.testing.assert_allclose(out, [[0.8, 0.8, 0.8]], atol=1e-12)
        # gray pixels untouched
        g = np.array([[0.5, 0.5, 0.5]])
        np.testing.assert_allclose(C.apply_huesat(g, [[30.0, 1.5]] * 12), g)


class ColorCheckerDataTest(unittest.TestCase):
    def test_reference(self):
        lab = C.colorchecker_lab()
        self.assertEqual(lab.shape, (24, 3))
        self.assertGreater(lab[18, 0], lab[23, 0])  # white > black


if __name__ == "__main__":
    unittest.main()
