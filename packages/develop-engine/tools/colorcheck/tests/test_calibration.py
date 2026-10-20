import unittest

import numpy as np

from colorcheck import calibration as CAL


class CalibrationValidationTest(unittest.TestCase):
    def test_matrix_is_required_and_must_be_finite_3x3(self):
        base = {"schema": CAL.SCHEMA}
        for data, message in (
            (base, "matrix is required"),
            ({**base, "matrix": {}}, "matrix.rowMajor is required"),
            ({**base, "matrix": {"rowMajor": [[1, 0], [0, 1]]}}, "matrix.rowMajor must be 3x3"),
            ({**base, "matrix": {"rowMajor": [[1, 0, 0], [0, float("nan"), 0], [0, 0, 1]]}},
             "matrix.rowMajor must contain only finite values"),
            ({**base, "matrix": {"rowMajor": [[1, 0, 0], [0, float("inf"), 0], [0, 0, 1]]}},
             "matrix.rowMajor must contain only finite values"),
        ):
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, message):
                CAL.from_dict(data)

    def test_valid_matrix_loads(self):
        calibration = CAL.from_dict({
            "schema": CAL.SCHEMA,
            "matrix": {"rowMajor": np.eye(3).tolist()},
        })
        np.testing.assert_array_equal(calibration.matrix, np.eye(3))


if __name__ == "__main__":
    unittest.main()
