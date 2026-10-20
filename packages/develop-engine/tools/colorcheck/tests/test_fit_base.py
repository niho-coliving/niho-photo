import os
import sys
import unittest


CALIBRATE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../calibrate"))
if CALIBRATE_DIR not in sys.path:
    sys.path.insert(0, CALIBRATE_DIR)

import fit_base as FIT  # noqa: E402


class FitBaseValidationTest(unittest.TestCase):
    def test_manifest_split_rejects_unknown_values(self):
        with self.assertRaisesRegex(ValueError, r"manifest.items\[0\].split.*validation"):
            FIT.validate_manifest_splits([{"scene": "typo", "split": "validation"}])

    def test_manifest_split_defaults_to_train_and_accepts_val(self):
        self.assertIsNone(FIT.validate_manifest_splits([{}, {"split": "val"}]))
        self.assertEqual(FIT.scene_split({}), "train")
        self.assertEqual(FIT.scene_split({"split": "val"}), "val")

    def test_no_pixel_evaluation_aggregates_cell_metrics_by_split(self):
        rows = [
            {"split": "train", "cellBefore": 2.0, "cellBeforeP99": 3.0,
             "cellAfter": 1.0, "cellAfterP99": 1.5},
            {"split": "train", "cellBefore": 4.0, "cellBeforeP99": 9.0,
             "cellAfter": 2.0, "cellAfterP99": 4.0},
            {"split": "val", "cellBefore": 7.0, "cellBeforeP99": 8.0,
             "cellAfter": 5.0, "cellAfterP99": 6.0},
        ]

        totals = FIT.evaluation_totals(rows, "train", cell_metrics=True)

        self.assertEqual(totals, {
            "n": 2,
            "before": {"mean": 3.0, "p99": 9.0},
            "after": {"mean": 1.5, "p99": 4.0},
        })


if __name__ == "__main__":
    unittest.main()
