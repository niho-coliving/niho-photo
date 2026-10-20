import os
import sys
import unittest

CALIBRATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, CALIBRATE_DIR)

from run_s11_wb import CAMERAS, scenes_for_cameras  # noqa: E402


class S11CameraSelectionTest(unittest.TestCase):
    def test_working_copy_and_accuracy_scene_selection_is_camera_scoped(self):
        panasonic = {"scene": "panasonic-scene", "model": CAMERAS["panasonic-dc-s5"]["model"]}
        sony = {"scene": "sony-scene", "model": CAMERAS["sony-zv-e10m2"]["model"]}
        selected = scenes_for_cameras([panasonic, sony], ["panasonic-dc-s5"])
        self.assertEqual(selected, [panasonic])

    def test_selection_fails_if_the_manifest_has_no_scenes_for_a_camera(self):
        scene = {"scene": "panasonic-scene", "model": CAMERAS["panasonic-dc-s5"]["model"]}
        with self.assertRaisesRegex(SystemExit, "sony-zv-e10m2"):
            scenes_for_cameras([scene], ["sony-zv-e10m2"])


if __name__ == "__main__":
    unittest.main()
