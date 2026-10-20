import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from colorcheck import cli


class RenderCliErrorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = os.path.join(self.tmp.name, "source.png")
        Image.fromarray(np.full((8, 12, 3), 128, dtype=np.uint8), "RGB").save(self.source)

    def tearDown(self):
        self.tmp.cleanup()

    def run_render(self, out, *extra):
        return cli.main([
            "render", "--input", self.source, "--space", "linear-srgb",
            "--out", out, *extra,
        ])

    def test_explicit_format_must_match_output_extension(self):
        for fmt in ("jpg", "tif16-srgb"):
            out = os.path.join(self.tmp.name, "mismatched.png")
            with self.subTest(fmt=fmt):
                self.assertEqual(self.run_render(out, "--format", fmt), cli.EXIT_INPUT)
                self.assertFalse(os.path.exists(out))

    def test_missing_cv2_is_reported_as_input_error(self):
        with patch("colorcheck.io.cv2", None):
            result = self.run_render(os.path.join(self.tmp.name, "out.tif"), "--format", "tif16-srgb")

        self.assertEqual(result, cli.EXIT_INPUT)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "out.tif")))

    def test_write_oserror_is_reported_as_input_error(self):
        with patch("colorcheck.io.save_srgb8", side_effect=OSError("disk full")):
            result = self.run_render(os.path.join(self.tmp.name, "out.png"), "--format", "png")

        self.assertEqual(result, cli.EXIT_INPUT)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "out.png")))


if __name__ == "__main__":
    unittest.main()
