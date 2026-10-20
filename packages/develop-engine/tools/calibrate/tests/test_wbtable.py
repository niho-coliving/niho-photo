import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

CALIBRATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, CALIBRATE_DIR)

import wbtable as WT  # noqa: E402
from fit_wb_table import calibration_decoder_version, render_cache_key  # noqa: E402


def synthetic(mired, tint, f):
    """節点ごとの M(w) = f(mired, tint) から表を作る。"""
    inv = [[np.linalg.inv(f(m, t)) for t in tint] for m in mired]
    return WT.build(mired, tint, inv, {"source": "synthetic"})


class WhiteBalanceTableTest(unittest.TestCase):
    def test_table_calibration_rejects_multiple_illuminants(self):
        with self.assertRaisesRegex(ValueError, "single calibration matrix"):
            WT.require_single_illuminant_for_table({"illuminants": [{}, {}]}, "fixture")
        WT.require_single_illuminant_for_table({"illuminants": [{"matrix": []}]}, "fixture")
        WT.require_single_illuminant_for_table({}, "fixture")

    def test_renderer_cache_key_tracks_all_output_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            raw = Path(temp) / "scene.RW2"
            raw.write_bytes(b"fixture raw")
            values = {
                "binary": Path(temp) / "apple-raw-linear",
                "binary_version": "apple-raw-linear 0.4.2",
                "macos": "15.6 (24G84)",
                "decoder_version": "7",
                "long_edge": 384,
                "white_balance_map": {"model": "uv-offset", "du": -0.006, "dv": 0.001},
                "lightroom_white": (5000.0, 0.0),
                "apple_white": (5100.0, 1.0),
            }

            def key(**changes):
                return render_cache_key(raw, **(values | changes))

            baseline = key()
            for field, value in (
                ("white_balance_map", {"model": "uv-offset", "du": -0.005, "dv": 0.001}),
                ("binary_version", "apple-raw-linear 0.4.3"),
                ("macos", "15.7 (24G91)"),
                ("decoder_version", "8"),
                ("long_edge", 512),
            ):
                with self.subTest(field=field):
                    self.assertNotEqual(baseline, key(**{field: value}))

    def test_decoder_version_comes_from_calibration(self):
        self.assertEqual(calibration_decoder_version({"decoder": {"decoderVersion": "7"}}), "7")
        self.assertEqual(calibration_decoder_version({"decoder": {"decoderVersion": 8}}), "8")
        with self.assertRaises(SystemExit):
            calibration_decoder_version({"decoder": {"decoderVersion": "unknown"}})

    def test_identity_table_is_identity(self):
        d = synthetic([100.0, 200.0, 300.0], [-50.0, 0.0, 50.0], lambda m, t: np.eye(3))
        table = WT.WhiteBalanceTable(d)
        np.testing.assert_allclose(table.transfer((5000.0, 0.0), (3000.0, 20.0)), np.eye(3), atol=1e-12)
        c = np.array([[1.1, -0.05, -0.05], [0.02, 0.97, 0.01], [0.0, -0.03, 1.03]])
        np.testing.assert_allclose(table.working_copy_transfer(c.ravel(), (5000.0, 0.0), (7500.0, -10.0)), np.eye(3), atol=1e-12)

    def test_exact_at_nodes_and_inverse_bilinear_between(self):
        # 対角の倍率（DNG の形）: 逆行列は倍率の逆数に線形なので、ミレッドと tint に線形な逆数なら補間は厳密
        def f(m, t):
            return np.diag([1.0 / (1.0 + 0.002 * m + 0.001 * t), 1.0, 1.0 / (1.2 - 0.001 * m + 0.0005 * t)])
        mired, tint = [100.0, 200.0, 300.0], [-50.0, 0.0, 50.0]
        table = WT.WhiteBalanceTable(synthetic(mired, tint, f))
        for m in mired:
            for t in tint:
                np.testing.assert_allclose(table.matrix(1e6 / m, t), f(m, t), rtol=1e-6)
        np.testing.assert_allclose(table.matrix(1e6 / 150.0, 25.0), f(150.0, 25.0), rtol=1e-6)
        np.testing.assert_allclose(table.matrix(1e6 / 237.0, -13.0), f(237.0, -13.0), rtol=1e-6)

    def test_outside_the_grid_clamps_to_the_edge(self):
        f = lambda m, t: np.diag([1.0 + 0.001 * m, 1.0, 1.0 + 0.002 * t])  # noqa: E731
        table = WT.WhiteBalanceTable(synthetic([100.0, 200.0], [-50.0, 50.0], f))
        np.testing.assert_allclose(table.matrix(1e6 / 50.0, 0.0), table.matrix(1e6 / 100.0, 0.0), rtol=1e-12)
        np.testing.assert_allclose(table.matrix(5000.0, 120.0), table.matrix(5000.0, 50.0), rtol=1e-12)

    def test_transfer_composes(self):
        rng = np.random.default_rng(1)
        base = {(m, t): np.eye(3) + 0.05 * rng.standard_normal((3, 3)) for m in (100.0, 200.0) for t in (-50.0, 50.0)}
        table = WT.WhiteBalanceTable(synthetic([100.0, 200.0], [-50.0, 50.0], lambda m, t: base[(m, t)]))
        a, b, c = (1e6 / 120.0, -20.0), (1e6 / 180.0, 10.0), (1e6 / 150.0, 40.0)
        np.testing.assert_allclose(table.transfer(b, c) @ table.transfer(a, b), table.transfer(a, c), atol=1e-12)

    def test_validation(self):
        good = synthetic([100.0, 200.0], [-50.0, 50.0], lambda m, t: np.eye(3))
        for mutate in (lambda d: d.update(schema="x"), lambda d: d.update(mired=[200.0, 100.0]),
                       lambda d: d.update(tint=[0.0]), lambda d: d.update(inverseMatrices=d["inverseMatrices"][:3]),
                       lambda d: d["inverseMatrices"].__setitem__(0, [0.0] * 9)):
            d = {k: (list(v) if isinstance(v, list) else v) for k, v in good.items()}
            d["inverseMatrices"] = [list(r) for r in good["inverseMatrices"]]
            mutate(d)
            with self.assertRaises(ValueError):
                WT.WhiteBalanceTable(d)

    def test_dumps_keeps_values_and_puts_number_arrays_on_one_line(self):
        d = {"whiteBalanceTable": synthetic([100.0, 200.0], [-50.0, 50.0], lambda m, t: np.eye(3) * (1 + m * 1e-3)),
             "matrix": {"rowMajor": [[1.0, -2.5e-07, 0.0], [0, 1, 0], [0, 0, 1]]}, "note": "a [1, 2] b", "empty": []}
        text = WT.dumps(d)
        self.assertEqual(json.loads(text), d)
        self.assertIn("[1.0, -2.5e-07, 0.0]", text)
        self.assertIn('"note": "a [1, 2] b"', text)
        rows = [line for line in text.splitlines() if line.strip().startswith("[") and line.strip().rstrip(",").endswith("]")]
        self.assertEqual(len(rows), 4 + 3)  # 逆行列 4 節点 + rowMajor 3 行
        self.assertTrue(text.endswith("}\n"))

    def test_lightroom_to_apple_inverts_the_uv_offset(self):
        wb_map = {"model": "uv-offset", "du": -0.0068, "dv": 0.0012}
        apple = (0.4151909, 0.4021632)
        u, v = WT.uv_from_xy(*apple)
        adobe = WT.xy_from_uv(u + wb_map["du"], v + wb_map["dv"])
        np.testing.assert_allclose(WT.lightroom_to_apple(adobe, wb_map), apple, atol=1e-12)
        self.assertEqual(WT.lightroom_to_apple(apple, None), apple)


if __name__ == "__main__":
    unittest.main()
