"""Regression coverage for reused teacher-review work directories."""

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


REPOSITORY = Path(__file__).resolve().parents[5]
TEACHER_REVIEW_SCRIPT = REPOSITORY / "packages/develop-engine/tools/color-review-teachers.py"
sys.path.insert(0, str(REPOSITORY / "packages/develop-engine/tools/colorcheck"))
spec = importlib.util.spec_from_file_location("color_review_teachers", TEACHER_REVIEW_SCRIPT)
teacher_review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(teacher_review)


class TeacherRenderCacheTests(unittest.TestCase):
    def test_reused_work_directory_rerenders_after_input_settings_and_binary_change(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            repository = root / "repo"
            work = root / "work"
            source = work / "data/teachers/inputs/scene__neutral.jpg"
            reference = work / "data/teachers/lr-export/scene__neutral.jpg"
            settings = work / "settings/neutral-niho-6.json"
            binary = repository / "packages/develop-engine/target/release/niho-develop-render"
            for path, contents in (
                (source, b"input-v1"),
                (reference, b"reference"),
                (settings, b"settings-v1"),
                (binary, b"renderer-v1"),
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(contents)

            render_calls = []

            def render(command, **_kwargs):
                output = Path(command[command.index("--out") + 1])
                self.assertFalse(output.exists(), "a previous PNG must be removed before rendering")
                render_calls.append(command)
                output.write_bytes(f"candidate-v{len(render_calls)}".encode())
                return types.SimpleNamespace(returncode=0)

            compare_module = types.ModuleType("colorcheck.compare")
            compare_module.run_compare = lambda *_args, **_kwargs: {
                "metrics": {
                    "deltaE00": {"mean": 0.1, "p99": 0.2, "max": 0.3},
                    "flatFraction": 0.0,
                }
            }
            job = (repository, work, "teachers", "scene", "neutral", "niho-6")

            with patch.dict(sys.modules, {"colorcheck.compare": compare_module}), patch.object(teacher_review.subprocess, "run", side_effect=render):
                first = teacher_review.run_job(job)
                source.write_bytes(b"input-v2")
                settings.write_bytes(b"settings-v2")
                binary.write_bytes(b"renderer-v2")
                second = teacher_review.run_job(job)

            self.assertEqual(len(render_calls), 2)
            self.assertNotEqual(first["inputSha256"], second["inputSha256"])
            self.assertNotEqual(first["settingsSha256"], second["settingsSha256"])
            self.assertNotEqual(first["executableSha256"], second["executableSha256"])
            self.assertNotEqual(first["candidateSha256"], second["candidateSha256"])


if __name__ == "__main__":
    unittest.main()
