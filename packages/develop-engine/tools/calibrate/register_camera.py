#!/usr/bin/env python3
"""register_camera.py - register one more camera for the Apple base (土台 A) in one session (#18398).

One command for the whole registration: the owner's RAW (4 scenes or more) and the Lightroom neutral export
→ fit (fit_base.py through run-dc-s5-apple.sh) → gate → the registry → the API snapshot → the Desktop lock check.
The steps keep their state in files, so a step can be re-run; `status` says what is done.

  python3 register_camera.py plan --make Canon --model "Canon EOS R6" [--scenes IMG_0001 ...] [--val IMG_0002 ...]
                                  [--lens apple|embedded] [--illuminant-nodes 3400,5100]
  python3 register_camera.py lr       --camera canon-eos-r6     # Lightroom の書き出しの準備（make_lr_round6.py --add）
  python3 register_camera.py check    --camera canon-eos-r6     # 書き出しの確認（全場面の中立が Adobe Standard・Look 無し）
  python3 register_camera.py fit      --camera canon-eos-r6 [--version v1]   # render → manifest → fit → wb-map → base
  python3 register_camera.py gate     --camera canon-eos-r6 [--version v1]   # 補正なし・汎用・この機種の校正を比べる
  python3 register_camera.py register --camera canon-eos-r6 [--version v1]   # 登録表・API の写し・lock の照合
  python3 register_camera.py status   --camera canon-eos-r6

The camera settings live in `cameras/<camera id>.json` next to this file (committed with the calibration), and
run-dc-s5-apple.sh reads them for any camera it does not know (`shell-vars`).  Runbook:
ops/runbooks/photo-color-calibration.md「新しい機種を登録する」.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from raw_extensions import RAW_SUFFIXES

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ENGINE = ROOT / "packages" / "develop-engine"
CALIBRATION_DIR = ENGINE / "calibration"
REGISTRY = CALIBRATION_DIR / "apple-registry.json"
CAMERAS_DIR = HERE / "cameras"
RUN = HERE / "run-dc-s5-apple.sh"
APPLE_BIN_DEFAULT = ENGINE / "tools" / "apple-raw-linear" / ".build" / "release" / "apple-raw-linear"
SNAPSHOT_SYNC = ROOT / "apps" / "api" / "scripts" / "sync-photo-cloud-work-calibration-snapshot.mjs"
DESKTOP_LOCK = ROOT / "apps" / "desktop" / "scripts" / "develop-sidecars-lock.mjs"

CONFIG_SCHEMA = "niho-calibrate-camera/v1"
REGISTRY_SCHEMA = "niho-develop-calibration-registry/v1"
MIN_SCENES = 4
LENS_MODES = ("apple", "embedded")
# runbook §4: 段階 2（当面）のカメラごとの Lightroom Adobe Standard 中立との差
GATE_VAL_MEAN = 2.0
VERSION_PATTERN = re.compile(r"^v[0-9]+$")
ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
# 機種の設定にだけ使う built-in の 3 機種（run-dc-s5-apple.sh の case に直書きされている）
BUILTIN_CAMERAS = ("panasonic-dc-s5", "sony-zv-e10m2", "sony-ilme-fx30")


class RegistrationError(Exception):
    """A step cannot go on; the message says what to do."""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def ref_root() -> Path:
    return Path(os.environ.get("NIHO_COLOR_REF_ROOT") or "OWNER_DATA_ROOT")


def work_root() -> Path:
    return Path(os.environ.get("NIHO_COLOR_WORK_DIR") or "OWNER_DATA_ROOT")


def apple_bin() -> Path:
    return Path(os.environ.get("APPLE_RAW_LINEAR_BIN") or APPLE_BIN_DEFAULT)


# ------------------------------------------------------------------ pure helpers (tested)

def normalized_model(make: str, model: str) -> str:
    """The model without a leading make ("Canon EOS R6" → "EOS R6"), as apple-raw-linear matches cameras."""
    make_text, model_text = make.strip(), model.strip()
    if make_text and model_text.lower().startswith(make_text.lower() + " "):
        return model_text[len(make_text) + 1:].strip()
    return model_text


def camera_id(make: str, model: str) -> str:
    """The calibration's camera.id (the working copy's baseVersion `cal-<id>-apple-<version>`)."""
    text = f"{make.strip()}-{normalized_model(make, model)}"
    slugged = re.sub(r"[^0-9A-Za-z]+", "-", text).strip("-").lower()
    if not ID_PATTERN.match(slugged):
        raise RegistrationError(f"camera id を作れません: {make!r} {model!r}")
    return slugged


def split_scenes(scenes: dict[str, str]) -> tuple[list[str], list[str]]:
    """Train / val by the capture date (`scene → YYYY:MM:DD …`): the dates alternate, so a day's near-duplicate
    shots stay on one side (FX30 #17085).  With one date, the scenes alternate in name order (DC-S5)."""
    names = sorted(scenes)
    dates = sorted({(scenes[name] or "")[:10] for name in names})
    if len(dates) >= 2:
        val_dates = set(dates[1::2])
        val = [name for name in names if (scenes[name] or "")[:10] in val_dates]
        train = [name for name in names if name not in val]
        # 日付の偏りで片側が 2 場面を切るときは名前の交互に戻す
        if len(train) >= 2 and len(val) >= 1 and len(train) >= len(val):
            return train, val
    return names[0::2], names[1::2]


def validate_config(config: dict, where: str = "camera config") -> dict:
    if not isinstance(config, dict) or config.get("schema") != CONFIG_SCHEMA:
        raise RegistrationError(f"{where}: schema must be {CONFIG_SCHEMA}")
    camera = config.get("camera") or {}
    make, model, cid = camera.get("make"), camera.get("model"), camera.get("id")
    if not all(isinstance(v, str) and v.strip() for v in (make, model, cid)):
        raise RegistrationError(f"{where}: camera.make / model / id are required")
    if not ID_PATTERN.match(cid):
        raise RegistrationError(f"{where}: camera.id {cid!r} must be lowercase letters and digits joined by - (例 {camera_id(make, model)})")
    scenes, val = config.get("scenes"), config.get("valScenes")
    if not isinstance(scenes, list) or len(scenes) < MIN_SCENES or not all(isinstance(s, str) and s for s in scenes):
        raise RegistrationError(f"{where}: scenes needs {MIN_SCENES} RAW scenes or more")
    if len(set(scenes)) != len(scenes):
        raise RegistrationError(f"{where}: scenes has duplicates")
    if not isinstance(val, list) or not val or not set(val) < set(scenes):
        raise RegistrationError(f"{where}: valScenes must be a non-empty subset of scenes (train needs the rest)")
    if len(set(scenes) - set(val)) < 2:
        raise RegistrationError(f"{where}: train needs 2 scenes or more")
    for scene in scenes:
        if not re.match(r"^[A-Za-z0-9_-]+$", scene):
            raise RegistrationError(f"{where}: scene {scene!r} must be letters, digits, _ or -")
    lens = config.get("lens") or {}
    if lens.get("mode") not in LENS_MODES:
        raise RegistrationError(f"{where}: lens.mode must be one of {', '.join(LENS_MODES)}")
    nodes = config.get("illuminantNodes", "3400,5100")
    if not re.match(r"^[0-9]+,[0-9]+$", str(nodes)):
        raise RegistrationError(f"{where}: illuminantNodes must be like 3400,5100")
    return config


def shell_vars(config: dict) -> str:
    """The variables run-dc-s5-apple.sh needs for a configured camera (shell-quoted)."""
    validate_config(config)
    camera = config["camera"]
    scenes = " ".join(shlex.quote(s) for s in config["scenes"])
    val = " ".join(shlex.quote(s) for s in config["valScenes"])
    return "\n".join([
        f"MAKE={shlex.quote(camera['make'])}",
        f"MODEL={shlex.quote(camera['model'])}",
        f"SCENES=({scenes})",
        f"VAL_SCENES=({val})",
        # 見本（リポジトリに残す画像）は残さない。プリセットの比較は全場面
        "SAMPLE_SCENES=()",
        f"PRESET_SCENES=({scenes})",
        f"ROUND6_SCENES=({scenes})",
        f"ILLUMINANT_NODES={shlex.quote(str(config.get('illuminantNodes', '3400,5100')))}",
    ]) + "\n"


def registry_text(registry: dict) -> str:
    """The registry in its committed layout (one camera per line; review-friendly diffs)."""
    lines = ["{", f'  "schema": {json.dumps(registry["schema"], ensure_ascii=False)},',
             f'  "track": {json.dumps(registry["track"], ensure_ascii=False)},']
    if "$comment" in registry:
        lines.append(f'  "$comment": {json.dumps(registry["$comment"], ensure_ascii=False)},')
    lines.append('  "cameras": [')
    cameras = registry["cameras"]
    for index, entry in enumerate(cameras):
        body = ", ".join(f'{json.dumps(key)}: {json.dumps(entry[key], ensure_ascii=False)}' for key in ("make", "model", "file"))
        lines.append(f"    {{ {body} }}{',' if index < len(cameras) - 1 else ''}")
    fallback = registry.get("fallback")
    lines.append("  ]," if fallback else "  ]")
    if fallback:
        lines.append(f'  "fallback": {{ "file": {json.dumps(fallback["file"], ensure_ascii=False)} }}')
    return "\n".join(lines) + "\n}\n"


def with_camera(registry: dict, make: str, model: str, file: str) -> tuple[dict, str | None]:
    """The registry with this camera's entry added (or its file replaced). Returns (registry, previous file)."""
    if registry.get("schema") != REGISTRY_SCHEMA or not isinstance(registry.get("cameras"), list):
        raise RegistrationError(f"登録表の形が違います（schema {REGISTRY_SCHEMA}・cameras）")
    unknown = set(registry) - {"schema", "track", "$comment", "cameras", "fallback"}
    if unknown:
        raise RegistrationError(f"登録表に知らない項目があります: {sorted(unknown)}（registry_text が書けない）")
    target = (make.strip().lower(), normalized_model(make, model).lower())
    cameras, previous = [], None
    for entry in registry["cameras"]:
        key = (str(entry.get("make", "")).strip().lower(), normalized_model(str(entry.get("make", "")), str(entry.get("model", ""))).lower())
        if key == target:
            previous = entry["file"]
            cameras.append({"make": entry["make"], "model": entry["model"], "file": file})
        else:
            cameras.append(entry)
    if previous is None:
        cameras.append({"make": make, "model": model, "file": file})
    return {**registry, "cameras": cameras}, previous


def gate_result(rows: dict, version: str) -> dict:
    """rows: method → {"all": {mean, p99, n}, "val": {...}}. Pass = the camera's own calibration is within the
    runbook's per-camera gate on val, and better than both no correction and the generic default (else the
    registration does not pay for itself)."""
    own, generic, none = rows["own"]["val"]["mean"], rows["generic"]["val"]["mean"], rows["none"]["val"]["mean"]
    checks = {
        "valWithinGate": own is not None and own <= GATE_VAL_MEAN,
        "betterThanNone": own is not None and none is not None and own < none,
        "betterThanGeneric": own is not None and generic is not None and own < generic,
    }
    return {"version": version, "rule": f"val の ΔE00 mean ≤ {GATE_VAL_MEAN}・補正なしより良い・汎用（登録表の fallback）より良い",
            "checks": checks, "passed": all(checks.values()), "rows": rows}


# ------------------------------------------------------------------ files

def config_path(cid: str) -> Path:
    if not ID_PATTERN.match(cid):
        raise RegistrationError(f"--camera {cid!r} は camera id（英小文字・数字を - でつないだもの）")
    return CAMERAS_DIR / f"{cid}.json"


def load_config(cid: str) -> dict:
    path = config_path(cid)
    if not path.exists():
        raise RegistrationError(f"{path} がありません。先に plan を流してください")
    return validate_config(json.loads(path.read_text(encoding="utf-8")), str(path))


def camera_work(cid: str) -> Path:
    return work_root() / cid


def calibration_file(cid: str, version: str) -> Path:
    return CALIBRATION_DIR / cid / f"apple-{version}.json"


def gate_file(cid: str, version: str) -> Path:
    return camera_work(cid) / "results" / f"gate-{version}.json"


def calibration_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def gate_matches_calibration(gate: dict, calibration_path: Path) -> bool:
    return gate.get("calibrationSha256") == calibration_sha256(calibration_path)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    log("$ " + " ".join(shlex.quote(str(c)) for c in cmd))
    return subprocess.run([str(c) for c in cmd], check=True, **kwargs)


def exif(raw: Path) -> dict[str, str]:
    if not shutil.which("exiftool"):
        raise RegistrationError("exiftool が要ります（brew install exiftool）")
    out = subprocess.run(["exiftool", "-j", "-Make", "-Model", "-DateTimeOriginal", str(raw)],
                         capture_output=True, text=True, check=True).stdout
    d = json.loads(out)[0]
    return {"make": str(d.get("Make", "")), "model": str(d.get("Model", "")), "captured": str(d.get("DateTimeOriginal", ""))}


def apple_supports(raw: Path) -> list[str]:
    binary = apple_bin()
    if not binary.exists():
        raise RegistrationError(f"{binary} がありません（cd packages/develop-engine/tools/apple-raw-linear && swift build -c release）")
    result = subprocess.run([str(binary), "info", str(raw), "--json"], capture_output=True, text=True)
    if result.returncode == 2:
        raise RegistrationError(f"{raw.name}: Apple の RAW 現像が開けない機種です（unsupported_camera）。土台 A では登録できない")
    if result.returncode != 0:
        raise RegistrationError(f"{raw.name}: apple-raw-linear info が失敗しました（exit {result.returncode}）: {result.stderr.strip()[:300]}")
    return list(json.loads(result.stdout).get("supportedDecoderVersions") or [])


# ------------------------------------------------------------------ steps

def step_plan(args) -> int:
    make, model = args.make.strip(), args.model.strip()
    cid = args.id or camera_id(make, model)
    if cid in BUILTIN_CAMERAS:
        raise RegistrationError(f"{cid} は run-dc-s5-apple.sh に直書きの機種です（設定ファイルは作らない）")
    round_dir = ref_root() / "round6"
    if not round_dir.is_dir():
        raise RegistrationError(f"{round_dir} がありません（hihirohub をマウントし、owner の RAW を round6/ 直下に置く）")
    raws = sorted(p for p in round_dir.iterdir() if p.is_file() and p.suffix.lower() in RAW_SUFFIXES)
    wanted = set(args.scenes or [])
    found: dict[str, tuple[Path, dict]] = {}
    for raw in raws:
        if wanted and raw.stem not in wanted:
            continue
        meta = exif(raw)
        same = meta["make"].strip().lower() == make.lower() and normalized_model(meta["make"], meta["model"]).lower() == normalized_model(make, model).lower()
        if same:
            found[raw.stem] = (raw, meta)
        elif wanted:
            raise RegistrationError(f"{raw.name} は {meta['make']} {meta['model']} です（--make / --model と違う）")
    missing = wanted - set(found)
    if missing:
        raise RegistrationError(f"round6/ に無い場面: {sorted(missing)}")
    if len(found) < MIN_SCENES:
        raise RegistrationError(f"{make} {model} の RAW が round6/ 直下に {len(found)} 枚しかありません（{MIN_SCENES} 場面以上）")
    versions = apple_supports(next(iter(found.values()))[0])
    if "8" not in versions:
        raise RegistrationError(f"Apple の RAW 現像の decoderVersion 8 がありません（{versions}）。DNG（8.DNG）は登録の対象外")
    scenes = {name: meta["captured"] for name, (_, meta) in found.items()}
    if args.val:
        val = sorted(args.val)
        train = sorted(set(scenes) - set(val))
    else:
        train, val = split_scenes(scenes)
    config = {
        "schema": CONFIG_SCHEMA,
        "camera": {"make": make, "model": model, "id": cid},
        "scenes": sorted(scenes),
        "valScenes": val,
        "lens": {"mode": args.lens, "note": args.lens_note or ("Core Image の補正（歪み）" if args.lens == "apple"
                                                              else "RAW 埋め込みの補正データ（tools/lens-check で LR と幾何を確かめた）")},
        "illuminantNodes": args.illuminant_nodes,
        "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    validate_config(config)
    path = config_path(cid)
    CAMERAS_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"→ {path.relative_to(ROOT)}: {len(scenes)} 場面（train {len(train)}: {', '.join(train)} / val {len(val)}: {', '.join(val)}）")
    print(f"次: python3 {Path(__file__).relative_to(ROOT)} lr --camera {cid}")
    return 0


def step_lr(args) -> int:
    config = load_config(args.camera)
    run([sys.executable, HERE / "make_lr_round6.py", "--add", "--variants", "neutral,neutral_lens"])
    print("owner の作業（10 分）: Lightroom「ローカル」で上の round6-photos-<n> を開き、全選択 → 書き出し"
          "（JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・ファイル名そのまま）→ round6/lr-export/。"
          "写真の設定には触らない。")
    print(f"書き出し後: python3 {Path(__file__).relative_to(ROOT)} check --camera {config['camera']['id']}")
    return 0


def neutral_export(scene: str) -> Path:
    return ref_root() / "round6" / "lr-export" / f"p6_{scene}_neutral.jpg"


def step_check(args) -> int:
    config = load_config(args.camera)
    status = subprocess.run([sys.executable, str(HERE / "make_lr_round6.py"), "--check"]).returncode
    missing = [s for s in config["scenes"] if not neutral_export(s).exists()]
    if missing:
        raise RegistrationError(f"中立の書き出しが無い場面: {missing}（lr の後に owner が書き出す）")
    if status != 0:
        raise RegistrationError("make_lr_round6.py --check が欠け・Adobe Standard でない書き出しを報告しました（上の一覧）")
    print(f"{len(config['scenes'])} 場面の中立の書き出しを確かめました。次: fit --camera {config['camera']['id']}")
    return 0


def run_steps(cid: str, version: str, steps: list[str]) -> None:
    for step in steps:
        run(["bash", RUN, step, "--camera", cid, "--version", version])


def step_fit(args) -> int:
    config = load_config(args.camera)
    cid, version = config["camera"]["id"], args.version
    for scene in config["scenes"]:
        if not neutral_export(scene).exists():
            raise RegistrationError(f"中立の書き出しが無い: {neutral_export(scene)}（check を先に）")
    run_steps(cid, version, ["render", "manifest", "fit"])
    cal_path = calibration_file(cid, version)
    calibration = json.loads(cal_path.read_text(encoding="utf-8"))
    # レンズ補正の方式は色の当てはめと独立（S10 #17031）。機種の設定から入れ、作業コピーは常に補正あり
    calibration["lens"] = dict(config["lens"])
    cal_path.write_text(json.dumps(calibration, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    run_steps(cid, version, ["wb-map", "base"])
    print(f"→ {cal_path.relative_to(ROOT)}（fit: train {calibration['fit']['train']} / val {calibration['fit']['val']}）")
    print(f"次: gate --camera {cid} --version {version}")
    return 0


def step_gate(args) -> int:
    sys.path.insert(0, str(HERE))
    import fit_base as FB  # noqa: E402  (puts ../colorcheck on sys.path)
    from colorcheck import calibration as CAL  # noqa: E402

    config = load_config(args.camera)
    cid, version = config["camera"]["id"], args.version
    manifest_path = camera_work(cid) / "fit" / f"manifest-{cid}-{version}.json"
    cal_path = calibration_file(cid, version)
    if not manifest_path.exists() or not cal_path.exists():
        raise RegistrationError(f"{manifest_path} か {cal_path} がありません（fit を先に）")
    calibration_digest = calibration_sha256(cal_path)
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    fallback = registry.get("fallback")
    if not fallback:
        raise RegistrationError("登録表に fallback（汎用の補正）がありません。比べる相手が無い")
    calibrations = {"none": CAL.identity(), "generic": CAL.load(str(CALIBRATION_DIR / fallback["file"])),
                    "own": CAL.load(str(cal_path))}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    r_root, c_root = manifest.get("referenceRoot") or str(ref_root()), manifest.get("candidateRoot") or str(work_root())
    scenes = []
    for item in manifest["items"]:
        log(f"[measure] {cid} {item['scene']}")
        scene = FB.prepare_scene(item, 1500, 2.0, FB.DEFAULT_GRID, 8.0, 0.01, keep_pair=True, r_root=r_root, c_root=c_root)
        scenes.append({"scene": scene.name, "split": scene.split,
                       "results": {name: FB.pixel_stats(scene, cal, 2.0) for name, cal in calibrations.items()}})
        scene.pair = None

    def total(method: str, split: str | None) -> dict:
        chosen = [s for s in scenes if split is None or s["split"] == split]
        return {"n": len(chosen), **FB.summarize([s["results"][method] for s in chosen])}

    rows = {method: {"all": total(method, None), "val": total(method, "val")} for method in calibrations}
    if calibration_sha256(cal_path) != calibration_digest:
        raise RegistrationError(f"{cal_path} が gate の計測中に変わりました（gate をやり直す）")
    result = gate_result(rows, version)
    result.update({
        "camera": config["camera"],
        "fallback": fallback["file"],
        "calibrationSha256": calibration_digest,
        "scenes": scenes,
    })
    out = gate_file(cid, version)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"| 集合 | 補正なし | 汎用（{fallback['file']}） | この機種の校正（{version}） |")
    print("|---|---:|---:|---:|")
    for split in ("val", "all"):
        print(f"| {split} | " + " | ".join(f"{rows[m][split]['mean']:.2f} / {rows[m][split]['p99']:.2f}" for m in ("none", "generic", "own")) + " |")
    print(f"gate（{result['rule']}）: {'合格' if result['passed'] else '不合格'} {result['checks']}")
    print(f"→ {out}")
    if not result["passed"]:
        return 3
    print(f"次: register --camera {cid} --version {version}")
    return 0


def step_register(args) -> int:
    config = load_config(args.camera)
    cid, version = config["camera"]["id"], args.version
    gate = gate_file(cid, version)
    if not gate.exists():
        raise RegistrationError(f"{gate} が無いか不合格です（gate を先に。不合格なら登録しない）")
    cal_path = calibration_file(cid, version)
    gate_result = json.loads(gate.read_text(encoding="utf-8"))
    if not gate_result.get("passed"):
        raise RegistrationError(f"{gate} が無いか不合格です（gate を先に。不合格なら登録しない）")
    if not gate_matches_calibration(gate_result, cal_path):
        raise RegistrationError(f"{gate} は現在の校正と一致しません（fit の後に gate を再実行）")
    calibration = json.loads(cal_path.read_text(encoding="utf-8"))
    if calibration.get("camera", {}).get("id") != cid or calibration.get("version") != version:
        raise RegistrationError(f"{cal_path} の camera.id / version が {cid} / {version} と違います")
    if (calibration.get("lens") or {}).get("mode") not in LENS_MODES:
        raise RegistrationError(f"{cal_path} の lens.mode が apple / embedded ではありません（作業コピーは常に補正あり）")
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    updated, previous = with_camera(registry, config["camera"]["make"], config["camera"]["model"],
                                    str(cal_path.relative_to(CALIBRATION_DIR)))
    REGISTRY.write_text(registry_text(updated), encoding="utf-8")
    log(f"登録表: {config['camera']['make']} {config['camera']['model']} → {cal_path.relative_to(CALIBRATION_DIR)}"
        + (f"（前は {previous}）" if previous else "（新しい機種）"))
    try:
        # ワーカーの起動時と同じ検査（機種の重複・lens.mode・camera.id・fallback の決まり）
        run([apple_bin(), "registry", REGISTRY], stdout=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        REGISTRY.write_text(registry_text(registry), encoding="utf-8")
        raise RegistrationError(f"apple-raw-linear registry が登録表を受けません（元に戻しました）: {exc}") from exc
    run(["node", SNAPSHOT_SYNC, "--write"])
    run(["node", DESKTOP_LOCK, "check", "--allow-ahead"])
    paths = [REGISTRY, cal_path, config_path(cid), ROOT / "apps/api/src/ops/photo-cloud-work-calibration-snapshot.ts"]
    print("登録しました。PR に入れるもの:")
    for path in paths:
        print(f"  {path.relative_to(ROOT)}")
    if previous:
        # 前の版で保存した補正（developSettings.base）を NIHO Desktop が原寸で描き直せるように、前の版の校正は残して同梱する
        print(f"前の版 {previous} は消さない。Desktop の復元用（apps/desktop/scripts/develop-sidecars-lock.mjs の"
              " RESTORATION_CALIBRATION_FILES と packages/desktop-photo/src/develop.rs の RESTORATION_CALIBRATIONS）"
              "に足す PR を、公開の PR の後に出す")
    print("この後（ops/runbooks/photo-color-calibration.md「新しい機種を登録する」）: エンジンの PR → 公開の PR"
          "（release-engine.mjs release。Desktop・camera の lock）→ ワーカーの git pull と起動し直し → stg で 1 枚")
    return 0


def step_status(args) -> int:
    path = config_path(args.camera)
    cid, version = args.camera, args.version
    config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    files = [entry["file"] for entry in registry.get("cameras", [])]
    gate_path = gate_file(cid, version)
    current_calibration = calibration_file(cid, version)
    gate_result = json.loads(gate_path.read_text(encoding="utf-8")) if gate_path.exists() else {}
    rows = [
        ("plan（機種の設定）", path.exists()),
        ("check（中立の書き出し）", bool(config) and all(neutral_export(s).exists() for s in config["scenes"])),
        ("fit（校正 JSON）", current_calibration.exists()),
        ("gate", bool(gate_result.get("passed")) and current_calibration.exists() and gate_matches_calibration(gate_result, current_calibration)),
        ("register（登録表）", f"{cid}/apple-{version}.json" in files),
    ]
    for label, done in rows:
        print(f"{'済' if done else '　'} {label}")
    return 0


def step_shell_vars(args) -> int:
    sys.stdout.write(shell_vars(load_config(args.camera)))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="新しい機種の土台 A の校正を 1 セッションで登録する（#18398）",
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = ap.add_subparsers(dest="step", required=True)
    plan = sub.add_parser("plan", help="round6/ 直下の RAW から機種の設定（場面・train/val・レンズ）を作る")
    plan.add_argument("--make", required=True)
    plan.add_argument("--model", required=True)
    plan.add_argument("--id", help="camera id（省けば make と model から）")
    plan.add_argument("--scenes", nargs="+", help="使う場面（RAW のファイル名の拡張子なし。省けばこの機種の全部）")
    plan.add_argument("--val", nargs="+", help="検証の場面（省けば撮影日で交互に分ける）")
    plan.add_argument("--lens", choices=LENS_MODES, default="apple", help="作業コピーのレンズ補正の方式（既定 apple）")
    plan.add_argument("--lens-note", help="lens.note（embedded にした根拠など）")
    plan.add_argument("--illuminant-nodes", default="3400,5100", help="2 光源の節点 K（既定 3400,5100）")
    for name, helptext in (("lr", "Lightroom の書き出しの準備"), ("check", "書き出しの確認"), ("fit", "当てはめ"),
                           ("gate", "補正なし・汎用・校正を比べる"), ("register", "登録表・API の写し・lock の照合"),
                           ("status", "どこまで済んだか"), ("shell-vars", "run-dc-s5-apple.sh が読む変数")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("--camera", required=True, help="camera id（plan が出したもの）")
        p.add_argument("--version", default="v1", help="校正の版（既定 v1。作り直すなら上げる）")
    args = ap.parse_args(argv)
    if getattr(args, "version", None) and not VERSION_PATTERN.match(args.version):
        log("error: --version は v<数字>")
        return 2
    steps = {"plan": step_plan, "lr": step_lr, "check": step_check, "fit": step_fit, "gate": step_gate,
             "register": step_register, "status": step_status, "shell-vars": step_shell_vars}
    try:
        return steps[args.step](args)
    except RegistrationError as exc:
        log(f"error: {exc}")
        return 2
    except subprocess.CalledProcessError as exc:
        log(f"error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
