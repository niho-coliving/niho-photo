import os
import sys
import tempfile
import unittest

CALIBRATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, CALIBRATE_DIR)

from refs import LOOK_CONTAMINATED, neutral, preset  # noqa: E402


class ReferenceSelectionTest(unittest.TestCase):
    def _touch(self, root, relative):
        path = os.path.join(root, relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as out:
            out.write(b"fixture")
        return path

    def test_contaminated_neutral_requires_round6_even_if_legacy_exists(self):
        scene = LOOK_CONTAMINATED[0]
        with tempfile.TemporaryDirectory() as root:
            legacy = self._touch(root, f"round2/lr-export-photos/p2_{scene}_neutral.jpg")

            with self.assertRaisesRegex(FileNotFoundError, "round6 neutral reference is required"):
                neutral(root, scene)

            current = self._touch(root, f"round6/lr-export/p6_{scene}_neutral.jpg")
            self.assertEqual(neutral(root, scene), current)
            self.assertTrue(os.path.exists(legacy))

    def test_contaminated_preset_requires_round6_even_if_legacy_exists(self):
        scene = LOOK_CONTAMINATED[1]
        with tempfile.TemporaryDirectory() as root:
            legacy = self._touch(root, f"round5/lr-export/p5_{scene}_full_bluesky2.jpg")

            with self.assertRaisesRegex(FileNotFoundError, "round6 full_bluesky2 reference is required"):
                preset(root, scene, "bluesky2")

            current = self._touch(root, f"round6/lr-export/p6_{scene}_full_bluesky2.jpg")
            self.assertEqual(preset(root, scene, "bluesky2"), current)
            self.assertTrue(os.path.exists(legacy))

    def test_uncontaminated_scene_keeps_legacy_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            legacy = self._touch(root, "round2/lr-export-photos/p2_P1522877_neutral.jpg")
            self.assertEqual(neutral(root, "P1522877"), legacy)


if __name__ == "__main__":
    unittest.main()
