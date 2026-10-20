#!/usr/bin/env python3
"""Lightroom の参照 round7 を作る（Epic #16939 S8 #16947・runbook §5）。

S8 の NIHO 標準ルックは「owner のプリセット 3 本が Lightroom で作ったときの仕上がり」に寄せる。owner のプリセットは
**Adobe Color** の上で作られている（colorful は Look「Adobe Color」を持ち、bluesky2 / pastel は旧名の
`CameraProfile="Default Color"`）。round6 のプリセットは Adobe Standard・Look 無しに揃えてあるので、S8 の目標には使えない。

round7 は round6 と同じ場面（FX30 を除く。色の校正が無く、土台の誤差がルックの当てはめに混ざるため）に 4 通りを並べる:

- `color_neutral`: 中立（撮影時の WB・Linear・レンズ補正なし）＋ Adobe Color。ルックそのものの目標。
- `color_bluesky2` / `color_pastel` / `color_colorful`: プリセットの設定＋ Adobe Color。プリセットの近さの目標。

Adobe Color は XMP では `CameraProfile="Adobe Standard"` ＋ `<crs:Look crs:Name="Adobe Color">` で表す。サイドカーには
中身の無い参照（`crs:Stubbed="true"`）しか書かない。**罠（2026-09-29 の 1 回目）: Lightroom は読み込み時にサイドカーの
Stubbed な Look を解決せず、中身が空の Look（LookTable もトーンカーブも無し）で描く**。1 回目の `lr-export/` は 80 枚とも
round6 の Adobe Standard と ΔE00 0.00 で、目標に使えない。プリセットとして当てたときは解決される（colorful のプリセットも
Stubbed）ので、Lightroom（Classic でない方）で 1 枚のプロファイルを「Adobe 標準 → Adobe カラー」と選び直し、
プロファイルだけをコピーして全枚に貼ってから `lr-export-color/` へ書き出す（runbook §5 の round7）。Adobe の表の数値は読まない・写さない（書き出した画像を目標にするだけ。
spec「段 1」の合わせ込みの方針）。

  python3 make_lr_round7.py [--ref <lr-measure>] [--photobench <photo-edit-app>] [--dry-run] [--check [--export-dir lr-export-color]]

- RAW は APFS のクローン（`cp -c`）なので実容量は増えない。出力先が空でなければ上書きせず止まる。
- 書き出し後は `--check` で、全枚数、Adobe Color の解決（LookTable の参照だけを確認）、生成時の manifest と
  写真の設定が一致することを確かめる。Lightroom が更新するサイドカーは期待値に使わない。
"""
from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_lr_round6 import NEUTRAL, PHOTOBENCH, PRESETS, clone, packet, preset_settings  # noqa: E402

EXCLUDE_MODELS = {"ILME-FX30"}
def adobe_color_uuid() -> str:
    """A caller-supplied Adobe profile identifier for optional Lightroom comparison."""
    value = os.environ.get("NIHO_ADOBE_COLOR_PROFILE_ID", "")
    if not re.fullmatch(r"[0-9A-Fa-f]{32}", value):
        raise ValueError("NIHO_ADOBE_COLOR_PROFILE_ID must be a 32-digit hex profile identifier")
    return value.upper()
# 1 回目の lr-export/ は Look が解決されず Adobe Standard と同じ（docstring の罠）。プロファイルを当て直した書き出しの置き場
EXPORT_DIR = "lr-export-color"
# Lightroom omits some default properties on export. Check explicit values
# against this table even when the generation manifest did not set them; any
# unrecognized outer CRS property is rejected below instead of being ignored.
OMITTED_DEFAULTS = {
    "IncrementalTemperature": "0", "IncrementalTint": "0", "ConvertToGrayscale": "False",
    "Exposure2012": "0", "Contrast2012": "0", "Highlights2012": "0", "Shadows2012": "0",
    "Whites2012": "0", "Blacks2012": "0", "Texture": "0", "Clarity2012": "0", "Dehaze": "0",
    "Vibrance": "0", "Saturation": "0", "HueAdjustmentRed": "0", "HueAdjustmentOrange": "0",
    "HueAdjustmentYellow": "0", "HueAdjustmentGreen": "0", "HueAdjustmentAqua": "0", "HueAdjustmentBlue": "0",
    "HueAdjustmentPurple": "0", "HueAdjustmentMagenta": "0", "SaturationAdjustmentRed": "0",
    "SaturationAdjustmentOrange": "0", "SaturationAdjustmentYellow": "0", "SaturationAdjustmentGreen": "0",
    "SaturationAdjustmentAqua": "0", "SaturationAdjustmentBlue": "0", "SaturationAdjustmentPurple": "0",
    "SaturationAdjustmentMagenta": "0", "LuminanceAdjustmentRed": "0", "LuminanceAdjustmentOrange": "0",
    "LuminanceAdjustmentYellow": "0", "LuminanceAdjustmentGreen": "0", "LuminanceAdjustmentAqua": "0",
    "LuminanceAdjustmentBlue": "0", "LuminanceAdjustmentPurple": "0", "LuminanceAdjustmentMagenta": "0",
    "SplitToningShadowHue": "0", "SplitToningShadowSaturation": "0", "SplitToningHighlightHue": "0",
    "SplitToningHighlightSaturation": "0", "SplitToningBalance": "0", "Sharpness": "40",
    "SharpenRadius": "1.0", "SharpenDetail": "25", "SharpenEdgeMasking": "0", "LuminanceSmoothing": "0",
    "LuminanceNoiseReductionDetail": "50", "LuminanceNoiseReductionContrast": "0",
    "ColorNoiseReduction": "25", "ColorNoiseReductionDetail": "50", "ColorNoiseReductionSmoothness": "50",
    "LensProfileEnable": "0", "AutoLateralCA": "0", "PostCropVignetteAmount": "0", "GrainAmount": "0",
    "DefringePurpleAmount": "0", "DefringePurpleHueLo": "30", "DefringePurpleHueHi": "70",
    "DefringeGreenAmount": "0", "DefringeGreenHueLo": "40", "DefringeGreenHueHi": "60",
    "WhiteBalance": "As Shot", "ToneCurveName2012": "Linear", "Treatment": "Color",
    "LensProfileSetup": "LensDefaults", "LensProfileDistortionScale": "100", "LensProfileVignettingScale": "100",
    "LensProfileChromaticAberrationScale": "100", "PostCropVignetteStyle": "1", "PostCropVignetteFeather": "50",
    "PostCropVignetteMidpoint": "50", "PostCropVignetteRoundness": "0", "PostCropVignetteHighlightContrast": "0",
    "GrainSize": "25", "GrainFrequency": "50",
    "PerspectiveUpright": "0", "PerspectiveVertical": "0", "PerspectiveHorizontal": "0",
    "PerspectiveRotate": "0", "PerspectiveAspect": "0", "PerspectiveScale": "100",
    "PerspectiveX": "0", "PerspectiveY": "0", "HDREditMode": "0", "CurveRefineSaturation": "100",
    "CropTop": "0", "CropLeft": "0", "CropBottom": "1", "CropRight": "1", "CropAngle": "0",
    "CropConstrainToUnitSquare": "1", "HasCrop": "False", "CropConstrainToWarp": "0",
    "LensManualDistortionAmount": "0", "VignetteAmount": "0",
    "ParametricShadows": "0", "ParametricDarks": "0", "ParametricLights": "0", "ParametricHighlights": "0",
    "ParametricShadowSplit": "25", "ParametricMidtoneSplit": "50", "ParametricHighlightSplit": "75",
    "ColorGradeMidtoneHue": "0", "ColorGradeMidtoneSat": "0", "ColorGradeShadowLum": "0",
    "ColorGradeMidtoneLum": "0", "ColorGradeHighlightLum": "0", "ColorGradeBlending": "50",
    "ColorGradeGlobalHue": "0", "ColorGradeGlobalSat": "0", "ColorGradeGlobalLum": "0",
    "ShadowTint": "0", "RedHue": "0", "RedSaturation": "0", "GreenHue": "0", "GreenSaturation": "0",
    "BlueHue": "0", "BlueSaturation": "0", "OverrideLookVignette": "False",
}
IGNORED_CRS_METADATA = {
    "AlreadyApplied", "CameraProfileDigest", "LookTable", "CameraProfileName", "CameraProfileGroup",
    "CameraProfileIsRaw", "CameraProfileVersion", "LookTableDigest", "LookTableName", "LookTableVersion",
    "RawFileName",
}
# Lightroom resolves these from the camera/lens only in LensDefaults mode.
RESOLVED_LENS_METADATA = {"LensProfileName", "LensProfileFilename", "LensProfileDigest", "LensProfileIsEmbedded"}
# Same measured contract as xmp.rs::LIGHTROOM_CUSTOM_WHITE (round5 / S9).
CUSTOM_WHITE_DEFAULTS = {"Temperature": "5001", "Tint": "10"}
NON_SETTING = re.compile(
    r"^(PresetType|Cluster|UUID|Supports\w+|RequiresRGBTables|ShowInPresets|ShowInQuickActions|"
    r"CameraModelRestriction|Copyright|ContactInfo|Version|ProcessVersion|HasSettings)$"
)
CRS_NS = "http://ns.adobe.com/camera-raw-settings/1.0/"
RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
LOOK_TEMPLATE = (
    "<crs:Look>\n"
    "    <rdf:Description\n"
    '     crs:Name="Adobe Color"\n'
    '     crs:Amount="1"\n'
    '     crs:UUID="{profile_id}"\n'
    '     crs:SupportsAmount="false"\n'
    '     crs:SupportsMonochrome="false"\n'
    '     crs:SupportsOutputReferred="false"\n'
    '     crs:Stubbed="true">\n'
    "    <crs:Group>\n"
    "     <rdf:Alt>\n"
    '      <rdf:li xml:lang="x-default">Profiles</rdf:li>\n'
    "     </rdf:Alt>\n"
    "    </crs:Group>\n"
    "    </rdf:Description>\n"
    "   </crs:Look>"
)


def variants(photobench: Path) -> dict[str, tuple[dict[str, str], dict[str, str]]]:
    look = LOOK_TEMPLATE.format(profile_id=adobe_color_uuid())
    out = {"color_neutral": ({**NEUTRAL, "CameraProfile": "Adobe Standard"}, {"Look": look})}
    for name, file in PRESETS.items():
        attributes, elements = preset_settings(photobench / file)
        out[f"color_{name}"] = ({"CameraProfile": "Adobe Standard", **attributes}, {**elements, "Look": look})
    return out


def scenes(round6: Path) -> list[dict]:
    manifest = json.loads((round6 / "manifest.json").read_text(encoding="utf-8"))
    first: dict[str, dict] = {}
    for e in manifest:
        first.setdefault(e["scene"], e)
    return [e for _, e in sorted(first.items()) if e["model"] not in EXCLUDE_MODELS]


def write_readme(round_dir: Path, out: Path, export: Path, manifest: list[dict], n_scenes: int, n_variants: int) -> None:
    models = sorted({e["model"] for e in manifest})
    (round_dir / "README.md").write_text(
        "# LR計測 round7（Adobe Color の中立とプリセット 3 本・S8 #16947 の目標）— 書き出し 1 回、10 分ほど\n\n"
        "1. Lightroom「ローカル」で次のフォルダを開く（Finder ⇧⌘G に貼る）:\n"
        f"   `{out}`\n"
        "2. 1 枚を開いて編集 → プロファイルのブラウザで「Adobe 標準」→「Adobe カラー」と選び直す → 下の「編集設定をコピー」の"
        "歯車で **プロファイルだけ** にチェックしてコピー → グリッドで全選択（⌘A）→「編集設定をペースト」"
        "（サイドカーの Adobe Color は読み込み時に解決されないため）\n"
        "3. 書き出し（⇧⌘E）: **JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・メタデータをすべて含める・ファイル名そのまま**\n"
        f"   保存先: `{export}`\n"
        "4. ほかの現像設定には触らない。終わったら「round7 終わった」と伝える。\n\n"
        f"内容: RAW {len(manifest)} 枚（round6 と同じ {n_scenes} 場面 × {n_variants} 通り・{', '.join(models)}。"
        "APFS のクローンなので実容量は増えない）。\n"
        "1 場面の 4 通り: 中立＋Adobe Color、プリセット 3 本（bluesky2 / pastel / colorful）＋Adobe Color。\n"
        "書き出し後の確認（担当）: `python3 packages/develop-engine/tools/calibrate/make_lr_round7.py --check`"
        "（全枚数・Adobe Color の解決・生成時 manifest との設定一致）。設定不一致を直すまで当てはめ・受入計測に進まない。\n",
        encoding="utf-8",
    )


def look_resolved(xmp: str) -> bool:
    """書き出しの XMP の Look が Adobe Color で、LookTable の参照まで解決されているか（中身の無い Look は False）。"""
    block = re.search(r"<crs:Look>(.*?)</crs:Look>", xmp, re.S)
    return bool(block) and adobe_color_uuid() in block.group(1) and "crs:LookTable=" in block.group(1)


def settings_mismatches(xmp: str, expected: dict[str, str]) -> list[str]:
    """Compare the photo's settings with the immutable generation manifest.

    Lightroom can rewrite the input sidecar, so that sidecar cannot be the
    expected value. Read only the outer description: properties inside a Look
    describe the profile, not the photo's controls.
    """
    try:
        root = ET.fromstring(xmp)
    except ET.ParseError:
        return ["XMP XML が不正"]
    description = root.find(f"{{{RDF_NS}}}RDF/{{{RDF_NS}}}Description")
    if description is None:
        return ["写真の rdf:Description が無い"]
    prefix = f"{{{CRS_NS}}}"
    actual = {k[len(prefix):]: v for k, v in description.attrib.items() if k.startswith(prefix)}
    for child in description:
        if child.tag.startswith(prefix) and len(child) == 0 and child.text is not None:
            actual[child.tag[len(prefix):]] = child.text.strip()

    def equivalent(left: str, right: str) -> bool:
        try:
            a, b = Decimal(left), Decimal(right)
            return a.is_finite() and b.is_finite() and a == b
        except InvalidOperation:
            if left.lower() in {"true", "false"}:
                return left.lower() == right.lower()
            return left == right

    defaults = dict(OMITTED_DEFAULTS)
    white = str(expected.get("WhiteBalance", defaults["WhiteBalance"])).lower()
    if (white == "custom" and not {"Temperature", "Tint"}.intersection(expected)
            and all(equivalent(str(expected.get(key, "0")), "0")
                    for key in ("IncrementalTemperature", "IncrementalTint"))):
        defaults.update(CUSTOM_WHITE_DEFAULTS)
    lens_setup = expected.get("LensProfileSetup", defaults["LensProfileSetup"])
    errors = []
    for key, wanted in expected.items():
        got = actual.get(key, defaults.get(key))
        if got is None or not equivalent(str(wanted), got):
            errors.append(f"{key}: 期待 {wanted} / 書き出し {got if got is not None else '欠落'}")
    for key, got in actual.items():
        if key in expected or key in IGNORED_CRS_METADATA or NON_SETTING.match(key):
            continue
        if key in {"Temperature", "Tint"} and white == "as shot":
            # In As Shot mode Lightroom writes the camera-derived white balance,
            # which varies by photo and is not an edit setting from the manifest.
            continue
        if (key in RESOLVED_LENS_METADATA and lens_setup == "LensDefaults"
                and actual.get("LensProfileSetup", lens_setup) == "LensDefaults"):
            continue
        default = defaults.get(key)
        if default is None:
            errors.append(f"{key}: manifest に期待値が無い / 書き出し {got}")
        elif not equivalent(default, got):
            errors.append(f"{key}: manifest 未指定の既定値 {default} / 書き出し {got}")
    return errors


def export_already_applied(xmp: str) -> bool:
    """Lightroom が現像設定を JPEG に適用して書き出したか。"""
    try:
        root = ET.fromstring(xmp)
    except ET.ParseError:
        return False
    description = root.find(f"{{{RDF_NS}}}RDF/{{{RDF_NS}}}Description")
    if description is None:
        return False
    value = description.attrib.get(f"{{{CRS_NS}}}AlreadyApplied", "")
    return value.strip().lower() == "true"


def check(round_dir: Path, export_dir: str = EXPORT_DIR) -> int:
    manifest = json.loads((round_dir / "manifest.json").read_text(encoding="utf-8"))
    export = round_dir / export_dir
    bad, missing, drift = [], [], []
    for e in manifest:
        jpg = export / (Path(e["file"]).stem + ".jpg")
        if not jpg.exists():
            missing.append(jpg.name)
            continue
        result = subprocess.run(["exiftool", "-b", "-XMP", str(jpg)], capture_output=True, text=True)
        if result.returncode:
            bad.append(f"{jpg.name}: XMP 読み取り失敗")
            continue
        xmp = result.stdout
        profile = re.search(r'crs:CameraProfile="([^"]*)"', xmp)
        if (not look_resolved(xmp) or not profile or profile.group(1) != "Adobe Standard"
                or not export_already_applied(xmp)):
            bad.append(jpg.name)
        expected = e.get("settings")
        errors = settings_mismatches(xmp, expected) if isinstance(expected, dict) and expected else ["manifest の期待設定が無い"]
        if errors:
            drift.append(f"{jpg.name}: {'; '.join(errors)}")
    print(f"{export.name}: {len(manifest)} 枚中 欠け {len(missing)}・プロファイル/XMP/AlreadyApplied 不正 {len(bad)}・設定不一致 {len(drift)}")
    for name in missing[:20] + bad[:20]:
        print(" ", name)
    for detail in drift[:20]:
        print(" ", detail)
    return 1 if missing or bad or drift else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", type=Path, default=Path(os.environ.get("NIHO_COLOR_REF_ROOT", PHOTOBENCH / "exports/lr-measure")))
    ap.add_argument("--photobench", type=Path, default=PHOTOBENCH)
    ap.add_argument("--dry-run", action="store_true", help="書かずに一覧だけ出す")
    ap.add_argument("--check", action="store_true", help="書き出し後の確認（枚数・Adobe Color・manifest との設定一致）")
    ap.add_argument("--export-dir", default=EXPORT_DIR, help=f"--check で見る書き出し先（round7 の下。既定 {EXPORT_DIR}）")
    args = ap.parse_args()
    round_dir = args.ref / "round7"
    if args.check:
        return check(round_dir, args.export_dir)
    out, export = round_dir / "round7-photos", round_dir / EXPORT_DIR
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} が空でない。上書きしないので中止する。")
    table = variants(args.photobench)
    manifest = []
    for e in scenes(args.ref / "round6"):
        raw = Path(e["raw"])
        meta = {k: e.get(k, "") for k in ("make", "model", "captured", "orientation")}
        for variant, (attributes, elements) in table.items():
            stem = f"p7_{e['scene']}_{variant}"
            manifest.append({"file": f"{stem}{raw.suffix}", "folder": out.name, "scene": e["scene"], "variant": variant,
                             "kind": "raw", "source": "round6", "raw": str(raw), **meta, "settings": attributes,
                             "curves": sorted(k for k in elements if k != "Look"), "look": "Adobe Color"})
            if not args.dry_run:
                out.mkdir(parents=True, exist_ok=True)
                clone(raw, out / f"{stem}{raw.suffix}")
                (out / f"{stem}.xmp").write_text(packet(attributes, elements), encoding="utf-8")
    n_scenes = len({e["scene"] for e in manifest})
    if args.dry_run:
        for e in manifest[:: len(table)]:
            print(e["scene"], e["model"], e["orientation"])
        print(f"{len(manifest)} files（{n_scenes} 場面 × {len(table)} 通り）— dry run")
        return 0
    export.mkdir(parents=True, exist_ok=True)
    (round_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    write_readme(round_dir, out, export, manifest, n_scenes, len(table))
    print(f"{len(manifest)} files -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
