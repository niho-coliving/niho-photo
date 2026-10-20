import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import make_lr_round7 as round7  # noqa: E402


def xmp(attributes="", children=""):
    return (
        f'<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="{round7.RDF_NS}" xmlns:crs="{round7.CRS_NS}">'
        f'<rdf:RDF><rdf:Description {attributes}>{children}</rdf:Description></rdf:RDF></x:xmpmeta>'
    )


class ExportSettingsTest(unittest.TestCase):
    def test_equivalent_numeric_and_boolean_serializations(self):
        self.assertEqual(round7.settings_mismatches(
            xmp('crs:GreenHue="8.0" crs:ConvertToGrayscale="false"'),
            {"GreenHue": "+8", "ConvertToGrayscale": "False"},
        ), [])

    def test_profile_resolution_does_not_hide_reset_calibration(self):
        nested = '<crs:Look><rdf:Description crs:GreenHue="8"/></crs:Look>'
        errors = round7.settings_mismatches(xmp('crs:GreenHue="0"', nested), {"GreenHue": "+8"})
        self.assertEqual(errors, ["GreenHue: 期待 +8 / 書き出し 0"])

    def test_missing_control_cannot_be_satisfied_by_profile_property(self):
        nested = '<crs:Look><rdf:Description crs:BlueSaturation="23"/></crs:Look>'
        self.assertEqual(round7.settings_mismatches(xmp(children=nested), {"BlueSaturation": "23"}),
                         ["BlueSaturation: 期待 23 / 書き出し 0"])

    def test_only_known_neutral_omissions_are_accepted(self):
        self.assertEqual(round7.settings_mismatches(xmp(), round7.OMITTED_DEFAULTS), [])
        self.assertTrue(round7.settings_mismatches(xmp(), {"IncrementalTint": "20"}))
        self.assertTrue(round7.settings_mismatches(xmp(), {"ConvertToGrayscale": "True"}))
        self.assertTrue(round7.settings_mismatches(xmp(), {"GreenHue": "8"}))
        self.assertTrue(round7.settings_mismatches(xmp(), {"CameraProfile": "Adobe Standard"}))

    def test_manifest_omitted_non_default_controls_are_rejected(self):
        errors = round7.settings_mismatches(xmp('crs:Exposure2012="5"'), {})
        self.assertEqual(errors, ["Exposure2012: manifest 未指定の既定値 0 / 書き出し 5"])

    def test_unrecognized_outer_control_is_rejected(self):
        errors = round7.settings_mismatches(xmp('crs:NewActiveControl="1"'), {})
        self.assertEqual(errors, ["NewActiveControl: manifest に期待値が無い / 書き出し 1"])

    def test_export_metadata_and_neutral_geometry(self):
        attrs = ('crs:RawFileName="photo.RW2" crs:HasCrop="False" crs:CropRight="1" '
                 'crs:PerspectiveScale="100" crs:PerspectiveRotate="0.0" '
                 'crs:CurveRefineSaturation="100" crs:HDREditMode="0"')
        self.assertEqual(round7.settings_mismatches(xmp(attrs), {}), [])
        for key, value in [("HasCrop", "True"), ("CropRight", "0.9"),
                           ("PerspectiveScale", "105"), ("HDREditMode", "1"),
                           ("CurveRefineSaturation", "80")]:
            with self.subTest(key=key):
                self.assertTrue(round7.settings_mismatches(xmp(f'crs:{key}="{value}"'), {}))

    def test_white_balance_resolution_is_mode_specific(self):
        custom = {"WhiteBalance": "Custom", "IncrementalTemperature": "0", "IncrementalTint": "0"}
        resolved = xmp('crs:WhiteBalance="Custom" crs:Temperature="5001" crs:Tint="+10"')
        self.assertEqual(round7.settings_mismatches(resolved, custom), [])
        self.assertTrue(round7.settings_mismatches(resolved.replace('5001', '5500'), custom))
        self.assertTrue(round7.settings_mismatches(resolved.replace('+10', '+11'), custom))
        self.assertTrue(round7.settings_mismatches(resolved, {**custom, "Temperature": "5500"}))
        self.assertTrue(round7.settings_mismatches(resolved, {**custom, "Temperature": "5001"}))
        self.assertTrue(round7.settings_mismatches(resolved, {**custom, "IncrementalTint": "5"}))
        as_shot = xmp('crs:WhiteBalance="As Shot" crs:Temperature="4250" crs:Tint="-6"')
        self.assertEqual(round7.settings_mismatches(as_shot, {"WhiteBalance": "As Shot"}), [])
        self.assertEqual(round7.settings_mismatches(as_shot, {}), [])
        self.assertTrue(round7.settings_mismatches(as_shot, {"Temperature": "5001"}))

    def test_resolved_lens_identity_requires_default_setup(self):
        attrs = ('crs:LensProfileName="Camera Settings" crs:LensProfileFilename="lens.lcp" '
                 'crs:LensProfileDigest="resolved-id" crs:LensProfileIsEmbedded="True"')
        self.assertEqual(round7.settings_mismatches(xmp(attrs), {}), [])
        custom = xmp(attrs + ' crs:LensProfileSetup="Custom"')
        self.assertTrue(round7.settings_mismatches(custom, {}))
        self.assertTrue(round7.settings_mismatches(custom, {"LensProfileSetup": "Custom"}))
        self.assertTrue(round7.settings_mismatches(xmp(attrs), {"LensProfileDigest": "expected-id"}))

    def test_simple_element_and_alternative_namespace_prefix(self):
        value = xmp(children='<crs:GreenHue>8</crs:GreenHue>').replace("crs:", "camera:").replace("xmlns:crs", "xmlns:camera")
        self.assertEqual(round7.settings_mismatches(value, {"GreenHue": "+8"}), [])

    def test_malformed_xml_and_nonfinite_values_fail(self):
        self.assertTrue(round7.settings_mismatches("<broken>", {"GreenHue": "8"}))
        self.assertTrue(round7.settings_mismatches(xmp('crs:GreenHue="NaN"'), {"GreenHue": "8"}))

    def test_check_uses_manifest_even_if_lightroom_overwrites_sidecar(self):
        profile_id = "0123456789ABCDEF0123456789ABCDEF"
        look = f'<crs:Look><rdf:Description crs:UUID="{profile_id}" crs:LookTable="reference-id"/></crs:Look>'
        reset = xmp('crs:CameraProfile="Adobe Standard" crs:GreenHue="0" crs:AlreadyApplied="True"', look)
        not_applied = reset.replace('crs:GreenHue="0"', 'crs:GreenHue="8"').replace('AlreadyApplied="True"', 'AlreadyApplied="False"')
        restored = reset.replace('crs:GreenHue="0"', 'crs:GreenHue="8"')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            export = root / round7.EXPORT_DIR
            export.mkdir()
            (export / "photo.jpg").touch()
            (root / "photo.xmp").write_text(reset)
            (root / "manifest.json").write_text(json.dumps([
                {"file": "photo.RW2", "settings": {"CameraProfile": "Adobe Standard", "GreenHue": "+8"}}
            ]))
            with patch.dict(round7.os.environ, {"NIHO_ADOBE_COLOR_PROFILE_ID": profile_id}):
                for text, exit_code in [(reset, 1), (not_applied, 1), (restored, 0)]:
                    with patch.object(round7.subprocess, "run", return_value=SimpleNamespace(stdout=text, returncode=0)):
                        with contextlib.redirect_stdout(io.StringIO()):
                            self.assertEqual(round7.check(root), exit_code)
                with patch.object(round7.subprocess, "run", return_value=SimpleNamespace(stdout=restored, returncode=1)):
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(round7.check(root), 1)


if __name__ == "__main__":
    unittest.main()
