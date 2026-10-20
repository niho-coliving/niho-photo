#!/usr/bin/env bash
# DC-S5 × Apple 現像（土台 A・S9a #16975）の補正の当てはめと計測を一括で回す（再現用）。別カメラは --camera で切り替える。
#
#   tools/calibrate/run-dc-s5-apple.sh <step|all> [--version VERSION] [--camera panasonic-dc-s5|sony-zv-e10m2|sony-ilme-fx30|<id>]
#   （ほかの機種は register_camera.py plan が書く tools/calibrate/cameras/<id>.json から読む。#18398）
#   steps: render manifest fit base camjpeg decoder preset preset-control wc crate-build crate-base preset-crate variants-crate wb-map wb-validate summary report
#   （render は DC-S5 以外のカメラ用: round6/ 直下の RAW から apple-linear/v8・v7 とカメラ JPEG を作る。DC-S5 は render-reference-set.sh）
#   DC-S5 以外の作業ディレクトリは $NIHO_COLOR_WORK_DIR/<camera>/（crate のビルドは共通の $NIHO_COLOR_WORK_DIR/s3-crate）
#   （wc 以降は段 2 の crate = niho-develop を使う本命の計測。preset / preset-control は Photo Bench の代役で参考値）
#
# 前提: tools/apple-raw-linear/scripts/render-reference-set.sh で $NIHO_COLOR_WORK_DIR に
#   apple-linear/v8/<scene>.tiff(+.json)・apple-linear/v7/...・camera-jpeg/<scene>.jpg がある。
# 参照: ${NIHO_COLOR_REF_ROOT}（Photo Bench の exports/lr-measure）。どの書き出しを使うかは refs.py（round6 優先、
#   無ければ round2 の中立・round5 のプリセット。round2/5 の P1012822/P1013207/P1013558 は Adobe Color の Look 入り）。
# 段 2 の代役: Photo Bench の photobench-render --engine coreimage（S3 の crate が入るまで）。
# 出力: $NIHO_COLOR_WORK_DIR/{fit,results,renders,base16,preset}/ と、リポジトリの
#   packages/develop-engine/calibration/panasonic-dc-s5/apple-<version>.json（fit の採用結果）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
TOOLS="$ROOT/packages/develop-engine/tools"
CC=(python3 "$TOOLS/colorcheck/colorcheck.py")
FIT=(python3 "$TOOLS/calibrate/fit_base.py")
PB="${PHOTOBENCH_RENDER_BIN:-OWNER_DATA_ROOT}"
PB_PRESET_DIR="${PHOTOBENCH_PRESET_DIR:-OWNER_DATA_ROOT}"
# 段 2 の crate（niho-develop）の出どころ: worktree に crates/niho-develop があればその HEAD、無ければ S3 PR2 branch
CRATE_REF="${NIHO_DEVELOP_CRATE_REF:-}"
CRATE_BIN="${NIHO_DEVELOP_BRIDGE_BIN:-}"
CRATE_BIN_REF="${NIHO_DEVELOP_BRIDGE_REF:-}"
# crate のビルド先（別の版を並べて測るときは NIHO_DEVELOP_CRATE_DIR で切り替える。既定 $NIHO_COLOR_WORK_DIR/s3-crate）
CRATE_DIR_OVERRIDE="${NIHO_DEVELOP_CRATE_DIR:-}"
REF="${NIHO_COLOR_REF_ROOT:-OWNER_DATA_ROOT}"
WK_ROOT="${NIHO_COLOR_WORK_DIR:-OWNER_DATA_ROOT}"
WK="$WK_ROOT"
CAMERA_ID=panasonic-dc-s5
DECODER=8
APPLE_BIN="${APPLE_RAW_LINEAR_BIN:-$TOOLS/apple-raw-linear/.build/release/apple-raw-linear}"
CRATE_DIR="${CRATE_DIR_OVERRIDE:-$WK_ROOT/s3-crate}"

usage() {
  cat <<'USAGE'
Usage: run-dc-s5-apple.sh [step|all] [--version VERSION] [--camera panasonic-dc-s5|sony-zv-e10m2|sony-ilme-fx30|<cameras/ の id>]
Steps: render manifest fit base camjpeg decoder wc crate-build crate-base preset-crate variants-crate wb-map wb-validate preset preset-control summary report all
USAGE
}

step=""
VERSION=v1
while (($# > 0)); do
  case "$1" in
    --version)
      if (($# < 2)) || [[ "$2" == -* ]]; then
        echo "--version には値が必要です" >&2
        usage >&2
        exit 2
      fi
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --camera)
      if (($# < 2)) || [[ "$2" == -* ]]; then
        echo "--camera には値が必要です" >&2
        usage >&2
        exit 2
      fi
      CAMERA_ID="$2"
      shift 2
      ;;
    --camera=*)
      CAMERA_ID="${1#--camera=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "未知の引数です: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$step" ]]; then
        echo "step は1つだけ指定できます: $1" >&2
        usage >&2
        exit 2
      fi
      step="$1"
      shift
      ;;
  esac
done
step="${step:-all}"
if [[ ! "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "--version の値が不正です: $VERSION" >&2
  exit 2
fi
case "$step" in
  render|manifest|fit|base|camjpeg|decoder|wc|crate-build|crate-base|preset-crate|variants-crate|wb-map|wb-validate|preset|preset-control|summary|report|all) ;;
  *) echo "unknown step: $step" >&2; usage >&2; exit 2 ;;
esac

# round6（2026-09-29）で昼光の屋外・窓際・肌の 10 場面を追加。旧 3 場面（P1012822/P1013207/P1013558）の参照は round6 の Look 無しに差し替え
ROUND6_SCENES=(P1570133 P1570135 P1570258 P1570266 P1570280 P1570302 P1570396 P1570586 P1570755 P1570923)
SCENES=(P1012822 P1013207 P1013558 P1522877 P1524180 P1524181 P1581215 P1581237 P1581243 P1581255 P1581256 P1581332 P1581335 P1581346 P1581356 P1581368 "${ROUND6_SCENES[@]}")
# 見本（リポジトリに長辺 480px で残す）は人物の顔が無い旧場面だけにする
SAMPLE_SCENES=(P1012822 P1013558 P1524180 P1581255)
PRESET_SCENES=(P1012822 P1013207 P1013558 P1524180 P1581215 "${ROUND6_SCENES[@]}")
# 2 光源の節点（Apple の as-shot K の分布: 電球色の屋内 ≈3400K 13 場面、昼光 4500〜5250K 13 場面）
ILLUMINANT_NODES="${NIHO_ILLUMINANT_NODES:-3400,5100}"
VAL_SCENES=()
case "$CAMERA_ID" in
  panasonic-dc-s5) MAKE=Panasonic; MODEL=DC-S5 ;;
  sony-zv-e10m2)
    # round6 の追加分（2026-09-29）: オレンジと手（ISO 2000）・窓のあるリビング・キッチン 2。見本は残さない
    MAKE=SONY; MODEL=ZV-E10M2; WK="$WK_ROOT/$CAMERA_ID"
    SCENES=(DSC09188 DSC09206 DSC09207 DSC09208); SAMPLE_SCENES=(); PRESET_SCENES=("${SCENES[@]}"); ROUND6_SCENES=("${SCENES[@]}") ;;
  sony-ilme-fx30)
    MAKE=SONY; MODEL=ILME-FX30; WK="$WK_ROOT/$CAMERA_ID"
    # 撮影日・被写体が近い連写と極端に暗い場面を除き、訓練と検証で撮影日を分ける。
    SCENES=(DSC00162 DSC00176 DSC00210 DSC00310 DSC00322 DSC00350 DSC00367 DSC00389 DSC00566 DSC00620 DSC00625 DSC00645 DSC01843)
    VAL_SCENES=(DSC00162 DSC00322 DSC00389 DSC00620 DSC00645)
    SAMPLE_SCENES=(); PRESET_SCENES=(DSC01843); ROUND6_SCENES=("${PRESET_SCENES[@]}") ;;
  *)
    # register_camera.py plan が書いた機種の設定（tools/calibrate/cameras/<id>.json。#18398）。case に機種を足さない
    if [[ ! -f "$TOOLS/calibrate/cameras/$CAMERA_ID.json" ]]; then
      echo "unknown camera: ${CAMERA_ID}（tools/calibrate/cameras/${CAMERA_ID}.json が無い。register_camera.py plan で作る）" >&2
      usage >&2
      exit 2
    fi
    camera_vars="$(python3 "$TOOLS/calibrate/register_camera.py" shell-vars --camera "$CAMERA_ID")" || exit 2
    eval "$camera_vars"
    WK="$WK_ROOT/$CAMERA_ID" ;;
esac
CAL="$ROOT/packages/develop-engine/calibration/$CAMERA_ID/apple-$VERSION.json"
FIX_DIR="$ROOT/packages/develop-engine/fixtures/color/apple/$CAMERA_ID"
PRESETS=(bluesky2 pastel colorful)
xmp_for() { case "$1" in bluesky2) echo "niho-preset bluesky2.xmp";; pastel) echo "niho-preset pastel.xmp";; colorful) echo "niho-priset_colorful.xmp";; *) echo "unknown preset $1" >&2; exit 1;; esac; }

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ref_neutral() { python3 "$TOOLS/calibrate/refs.py" neutral "$REF" "$1"; }
# 参照の書き出しの LR レンズ補正に Apple 側を合わせる（off 同士なら幾何は 0.1px で一致。colorful だけ on）
lin_for() { if [[ "$(python3 "$TOOLS/calibrate/refs.py" lens "$1")" == on ]]; then echo "$WK/apple-linear/v8"; else echo "$WK/apple-linear/v8-nolens"; fi; }
wc_for() { if [[ "$(python3 "$TOOLS/calibrate/refs.py" lens "$1")" == on ]]; then echo "$WK/working-copy"; else echo "$WK/working-copy-nolens"; fi; }
neutral_k() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['neutral']['temperatureK'])" "$WK/apple-linear/v8/$1.json"; }
base_version() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['baseVersion'])" "$CAL"; }
mkdir -p "$WK/apple-linear/v8" "$WK/apple-linear/v7" "$WK/camera-jpeg" "$WK/fit" "$WK/results/base" "$WK/results/base-uncal" "$WK/results/camjpeg" "$WK/results/decoder" "$WK/results/pairs" "$WK/renders/v7" "$WK/renders/v8" "$WK/base16" "$WK/preset" "$WK/camera-jpeg-oriented"

step_render() {
  # DC-S5 以外: round6/ 直下の RAW（拡張子は問わない）から Apple 線形の作業用 TIFF とカメラ JPEG を作る（既存は飛ばす）
  [[ "$CAMERA_ID" == panasonic-dc-s5 ]] && { echo "DC-S5 は tools/apple-raw-linear/scripts/render-reference-set.sh を使う" >&2; exit 2; }
  for s in "${SCENES[@]}"; do
    local raw="" f
    for f in "$REF/round6/$s".*; do
      local ext="${f##*.}"
      ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
      case "$ext" in jpg|jpeg|xmp) continue ;; esac
      [[ -f "$f" ]] && { raw="$f"; break; }
    done
    [[ -n "$raw" ]] || { echo "RAW が無い: $REF/round6/$s.*" >&2; exit 1; }
    for vd in 8:v8:on 7:v7:on 8:v8-nolens:off; do
      local v="${vd%%:*}" d; d="${vd#*:}"; local lens="${d#*:}"; d="${d%%:*}"
      mkdir -p "$WK/apple-linear/$d"
      [[ -s "$WK/apple-linear/$d/$s.tiff" && -s "$WK/apple-linear/$d/$s.json" ]] && continue
      log "render ${d} ${s}"
      "$APPLE_BIN" render "$raw" --out "$WK/apple-linear/$d/$s.tiff" --meta "$WK/apple-linear/$d/$s.json" --long-edge 2560 --space linear-prophoto --encoding tiff32f --decoder-version "$v" --lens-correction "$lens" >/dev/null
    done
    if [[ ! -s "$WK/camera-jpeg/$s.jpg" ]]; then
      exiftool -b -JpgFromRaw "$raw" > "$WK/camera-jpeg/$s.jpg" 2>/dev/null || true
      [[ -s "$WK/camera-jpeg/$s.jpg" ]] || exiftool -b -PreviewImage "$raw" > "$WK/camera-jpeg/$s.jpg"
    fi
  done
}

step_manifest() {
  log "manifest: ${#SCENES[@]} 場面（FX30 は撮影日単位、それ以外は sorted 順の偶数番を train）"
  CAL_MAKE="$MAKE" CAL_MODEL="$MODEL" CAL_CAMERA_ID="$CAMERA_ID" CAL_VAL_SCENES="${VAL_SCENES[*]}" python3 - "$TOOLS/calibrate" "$WK" "$REF" "$VERSION" "${SCENES[@]}" <<'PY'
import json, sys, os
sys.path.insert(0, sys.argv[1]); import refs
wk, ref, version, *scenes = sys.argv[2:]
items = []
val_scenes = set(os.environ["CAL_VAL_SCENES"].split())
for i, s in enumerate(sorted(scenes)):
    meta = json.load(open(os.path.join(wk, "apple-linear/v8", f"{s}.json")))
    r = refs.neutral(ref, s)
    if not os.path.exists(r):
        raise FileNotFoundError(f"Lightroom の中立書き出しが無い: {r}")
    items.append({"scene": s, "candidate": os.path.join(wk, "apple-linear", refs.linear_subdir(r), f"{s}.tiff"), "candidateSpace": "linear-prophoto",
                  "reference": r,
                  "neutralTemperatureK": round(float(meta["neutral"]["temperatureK"]), 1),
                  "split": "val" if s in val_scenes else ("train" if val_scenes or i % 2 == 0 else "val")})
make, model, camera_id = os.environ["CAL_MAKE"], os.environ["CAL_MODEL"], os.environ["CAL_CAMERA_ID"]
out = {"track": "apple", "camera": {"make": make, "model": model, "id": camera_id}, "decoderVersion": "8", "items": items}
if camera_id == "sony-ilme-fx30":
    out["referenceSet"] = "lr-measure round6 neutral (Adobe Standard, As Shot)"
p = os.path.join(wk, "fit", f"manifest-{camera_id}-{version}.json"); json.dump(out, open(p, "w"), indent=1, ensure_ascii=False)
print(p, len(items), [(it["scene"], it["split"]) for it in items])
PY
}

step_fit() {
  local man="$WK/fit/manifest-$CAMERA_ID-$VERSION.json"
  [[ -f "$man" ]] || step_manifest
  log "fit 1 光源（行列＋EV、HueSat 12 は検証で改善しなければ不採用）"
  "${FIT[@]}" --manifest "$man" --out "$WK/fit/cal-1ill-$VERSION.json" --report "$WK/fit/report-1ill-$VERSION.md" --illuminants 1 --huesat 12 --version "$VERSION" > "$WK/fit/fit-1ill-$VERSION.log" 2>&1 || { tail -20 "$WK/fit/fit-1ill-$VERSION.log"; exit 1; }
  log "fit 2 光源（節点 ${ILLUMINANT_NODES} K = 参照セットの実測分布）"
  "${FIT[@]}" --manifest "$man" --out "$WK/fit/cal-2ill-$VERSION.json" --report "$WK/fit/report-2ill-$VERSION.md" --illuminants 2 --illuminant-nodes "$ILLUMINANT_NODES" --huesat 12 --version "$VERSION" > "$WK/fit/fit-2ill-$VERSION.log" 2>&1 || { tail -20 "$WK/fit/fit-2ill-$VERSION.log"; exit 1; }
  python3 - "$WK/fit/cal-1ill-$VERSION.json" "$WK/fit/cal-2ill-$VERSION.json" "$CAL" "$WK/fit/report-1ill-$VERSION.md" "$WK/fit/report-2ill-$VERSION.md" "$WK/fit/report-chosen-$VERSION.md" <<'PY'
import json, sys, shutil, os
c1, c2, out, r1, r2, rout = sys.argv[1:]
a, b = json.load(open(c1)), json.load(open(c2))
va, vb = a["fit"]["val"]["mean"], b["fit"]["val"]["mean"]
# 検証 mean が 0.1 以上良くなるときだけ 2 光源を採る（節点の片側に場面が少なく外挿しやすいため）
choose = c2 if (va is not None and vb is not None and vb < va - 0.1) else c1
chosen = b if choose == c2 else a
chosen.setdefault("fit", {})["selection"] = {"candidates": {"1ill": {"train": a["fit"]["train"], "val": a["fit"]["val"]}, "2ill": {"train": b["fit"]["train"], "val": b["fit"]["val"]}}, "rule": "val mean が 0.1 以上良ければ 2 光源、そうでなければ 1 光源", "chosen": "2ill" if choose == c2 else "1ill"}
os.makedirs(os.path.dirname(out), exist_ok=True)
# レンズ補正の方式（S10 #17031。色の行列とは独立）は既存の校正 JSON から引き継ぐ
if os.path.exists(out):
    try:
        prev = json.load(open(out))
        if prev.get("lens") and not chosen.get("lens"):
            chosen["lens"] = prev["lens"]
    except (OSError, ValueError):
        pass
json.dump(chosen, open(out, "w"), indent=1, ensure_ascii=False); shutil.copy(r2 if choose == c2 else r1, rout)
print("1ill train/val:", a["fit"]["train"], a["fit"]["val"]); print("2ill train/val:", b["fit"]["train"], b["fit"]["val"]); print("chosen:", chosen["fit"]["selection"]["chosen"], "->", out)
PY
}

step_base() {
  local bv; bv="$(base_version)"
  for s in "${SCENES[@]}"; do
    local k; k="$(neutral_k "$s")"; local save=()
    for x in "${SAMPLE_SCENES[@]}"; do [[ "$x" == "$s" ]] && save=(--save-pair "$WK/results/pairs"); done
    log "base $s (K=$k)"
    local r; r="$(ref_neutral "$s")"; local lin; lin="$(lin_for "$r")"
    "${CC[@]}" compare --reference "$r" --candidate "$lin/$s.tiff" --candidate-space linear-prophoto --render --calibration "$CAL" --neutral-k "$k" --kind reference --label "base/$s" --scene "$s" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version $DECODER --base-version "$bv" --normalize-exposure --out "$WK/results/base/$s.json" "${save[@]}" >/dev/null
    "${CC[@]}" compare --reference "$r" --candidate "$lin/$s.tiff" --candidate-space linear-prophoto --render --kind reference --label "base-uncal/$s" --scene "$s" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version $DECODER --base-version "apple-ciraw8/linear-prophoto-d50/uncalibrated" --out "$WK/results/base-uncal/$s.json" >/dev/null
  done
}

step_camjpeg() {
  local bv; bv="$(base_version)"
  for s in "${SCENES[@]}"; do
    python3 -c "from PIL import Image, ImageOps; import sys; im=ImageOps.exif_transpose(Image.open(sys.argv[1])); im.save(sys.argv[2], quality=97)" "$WK/camera-jpeg/$s.jpg" "$WK/camera-jpeg-oriented/$s.jpg"
    local k; k="$(neutral_k "$s")"; local save=()
    for x in "${SAMPLE_SCENES[@]}"; do [[ "$x" == "$s" ]] && save=(--save-pair "$WK/results/pairs"); done
    log "camera-jpeg $s"
    "${CC[@]}" compare --reference "$WK/camera-jpeg-oriented/$s.jpg" --candidate "$WK/apple-linear/v8/$s.tiff" --candidate-space linear-prophoto --render --calibration "$CAL" --neutral-k "$k" --kind camera-jpeg --label "camjpeg/$s" --scene "$s" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version $DECODER --base-version "$bv" --normalize-exposure --out "$WK/results/camjpeg/$s.json" "${save[@]}" >/dev/null
  done
}

step_decoder() {
  local bv; bv="$(base_version)"
  for s in "${SCENES[@]}"; do
    local k; k="$(neutral_k "$s")"
    log "decoder 7 vs 8 $s"
    for v in v7 v8; do
      "${CC[@]}" render --input "$WK/apple-linear/$v/$s.tiff" --space linear-prophoto --calibration "$CAL" --neutral-k "$k" --format png --out "$WK/renders/$v/$s.png" >/dev/null
    done
    "${CC[@]}" compare --reference "$WK/renders/v8/$s.png" --candidate "$WK/renders/v7/$s.png" --candidate-space srgb --kind version --label "decoder-7vs8/$s" --scene "$s" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version "7vs8" --base-version "$bv" --out "$WK/results/decoder/$s.json" >/dev/null
  done
}

step_preset() {
  local bv; bv="$(base_version)"
  [[ -x "$PB" ]] || { echo "photobench-render が無い: $PB" >&2; exit 1; }
  for s in "${PRESET_SCENES[@]}"; do
    local k; k="$(neutral_k "$s")"
    log "base16 ${s}（校正済みの表示レンダリングを 16bit sRGB TIFF に）"
    "${CC[@]}" render --input "$WK/apple-linear/v8/$s.tiff" --space linear-prophoto --calibration "$CAL" --neutral-k "$k" --format tif16-srgb --out "$WK/base16/$s.tif" >/dev/null
    for p in "${PRESETS[@]}"; do
      mkdir -p "$WK/preset/$p"
      log "photobench-render $p $s"
      "$PB" "$WK/base16/$s.tif" --output-dir "$WK/preset/$p" --engine coreimage --preset "$PB_PRESET_DIR/$(xmp_for "$p")" --format jpg >/dev/null 2>&1 || { echo "photobench-render failed: $p $s" >&2; exit 1; }
    done
  done
  python3 - "$TOOLS/calibrate" "$WK" "$REF" "${PRESETS[@]}" -- "${PRESET_SCENES[@]}" <<'PY'
import json, sys, os
sys.path.insert(0, sys.argv[1]); import refs
wk, ref, *rest = sys.argv[2:]
i = rest.index("--"); presets, scenes = rest[:i], rest[i+1:]
items = [{"preset": p, "scene": s, "reference": refs.preset(ref, s, p), "candidate": os.path.join(wk, "preset", p, f"{s}.jpg"), "candidateSpace": "srgb"} for p in presets for s in scenes]
json.dump({"schema": "colorcheck/preset-manifest/v1", "stage2": "photobench-render --engine coreimage on 16bit sRGB TIFF (stand-in until S3 crate)", "items": items}, open(os.path.join(wk, "preset", "manifest.json"), "w"), indent=1, ensure_ascii=False)
print(len(items), "items")
PY
  log "preset の近さ（${#PRESETS[@]} 本 × ${#PRESET_SCENES[@]} 場面）"
  "${CC[@]}" preset --manifest "$WK/preset/manifest.json" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version $DECODER --base-version "$bv" --out "$WK/results/preset.json" --markdown "$WK/results/preset.md" --save-pairs "$WK/results/pairs" | tail -20
}

step_preset_control() {
  # 対照実験: 土台を Lightroom の中立書き出しそのもの（完全な土台）にして同じ代役の段 2 を通す。
  # ここで残る差は段 2 の代役（ラスター経路）だけの差で、上の preset との差分が土台 A の寄与。
  [[ -x "$PB" ]] || { echo "photobench-render が無い: $PB" >&2; exit 1; }
  for s in "${PRESET_SCENES[@]}"; do
    for p in "${PRESETS[@]}"; do
      mkdir -p "$WK/preset-control/$p"
      log "control photobench-render ${p} ${s}（入力 = LR 中立 JPEG）"
      cp "$(ref_neutral "$s")" "$WK/preset-control/$s.jpg"
      "$PB" "$WK/preset-control/$s.jpg" --output-dir "$WK/preset-control/$p" --engine coreimage --preset "$PB_PRESET_DIR/$(xmp_for "$p")" --format jpg >/dev/null 2>&1 || { echo "photobench-render failed: $p $s" >&2; exit 1; }
    done
  done
  python3 - "$TOOLS/calibrate" "$WK" "$REF" "${PRESETS[@]}" -- "${PRESET_SCENES[@]}" <<'PY'
import json, sys, os
sys.path.insert(0, sys.argv[1]); import refs
wk, ref, *rest = sys.argv[2:]
i = rest.index("--"); presets, scenes = rest[:i], rest[i+1:]
items = [{"preset": p, "scene": s, "reference": refs.preset(ref, s, p), "candidate": os.path.join(wk, "preset-control", p, f"{s}.jpg"), "candidateSpace": "srgb"} for p in presets for s in scenes]
json.dump({"schema": "colorcheck/preset-manifest/v1", "control": "input = Lightroom neutral JPEG (perfect base); stage 2 = photobench-render coreimage raster path", "items": items}, open(os.path.join(wk, "preset-control", "manifest.json"), "w"), indent=1, ensure_ascii=False)
PY
  log "対照: 段 2 の代役だけの差"
  "${CC[@]}" preset --manifest "$WK/preset-control/manifest.json" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version $DECODER --base-version "control-lr-neutral-jpeg" --out "$WK/results/preset-control.json" --markdown "$WK/results/preset-control.md" | tail -8
}

step_wc() {
  # 校正済みの作業コピー（16bit PNG・gamma 1.8・上限 2.0・linear ProPhoto・露出前）とメタ JSON を作る
  log "working copies ← apple-linear/v8 × ${CAL}"
  python3 "$TOOLS/calibrate/make_working_copies.py" --calibration "$CAL" --linear-dir "$WK/apple-linear/v8" --out-dir "$WK/working-copy" | tail -3
  # 色の計測用（LR のレンズ補正なしの参照に当てる）: Apple のレンズ補正なし
  python3 "$TOOLS/calibrate/make_working_copies.py" --calibration "$CAL" --linear-dir "$WK/apple-linear/v8-nolens" --out-dir "$WK/working-copy-nolens" | tail -3
}

external_bridge_ref_sha() {
  if [[ -z "$CRATE_BIN_REF" ]]; then
    echo "外部 bridge binary には NIHO_DEVELOP_BRIDGE_REF（binary のソース commit）が必要です" >&2
    return 2
  fi
  if [[ ! "$CRATE_BIN_REF" =~ ^[[:xdigit:]]{40}$ ]]; then
    echo "NIHO_DEVELOP_BRIDGE_REF には完全な40桁の commit SHA を指定してください: $CRATE_BIN_REF" >&2
    return 2
  fi
  git -C "$ROOT" rev-parse --verify "${CRATE_BIN_REF}^{commit}" 2>/dev/null || {
    echo "NIHO_DEVELOP_BRIDGE_REF をこの repository の commit として解決できません: $CRATE_BIN_REF" >&2
    return 2
  }
}

crate_bin() {
  if [[ -n "$CRATE_BIN" ]]; then
    if [[ ! -x "$CRATE_BIN" ]]; then
      echo "NIHO_DEVELOP_BRIDGE_BIN が実行可能ではありません: $CRATE_BIN" >&2
      return 1
    fi
    local expected_ref; expected_ref="$(external_bridge_ref_sha)" || return $?
    local ref_file="$CRATE_DIR/crate-ref.txt"
    if [[ ! -s "$ref_file" || "$(cat "$ref_file")" != "$expected_ref" ]]; then
      echo "外部 bridge binary の provenance が記録されていません。先に crate-build を実行してください" >&2
      return 1
    fi
    local expected_sha actual_sha
    expected_sha="$(shasum -a 256 "$CRATE_BIN" | awk '{print $1}')"
    actual_sha="$(cat "$CRATE_DIR/bridge-bin.sha256" 2>/dev/null || true)"
    if [[ -z "$actual_sha" || "$actual_sha" != "$expected_sha" ]]; then
      echo "外部 bridge binary が crate-build 後に変わったか、SHA-256 を記録できません" >&2
      return 1
    fi
    echo "$CRATE_BIN"
    return
  fi
  local ref_file="$CRATE_DIR/crate-ref.txt"
  if [[ ! -s "$ref_file" ]]; then
    echo "crate-ref.txt がありません。先に crate-build を実行してください" >&2
    return 1
  fi
  local ref; ref="$(cat "$ref_file")"
  echo "$CRATE_DIR/target/$ref/release/examples/render_working_copy"
}

step_crate_build() {
  if [[ -n "$CRATE_BIN" ]]; then
    if [[ ! -x "$CRATE_BIN" ]]; then
      echo "NIHO_DEVELOP_BRIDGE_BIN が実行可能ではありません: $CRATE_BIN" >&2
      exit 2
    fi
    local bin_ref_sha; bin_ref_sha="$(external_bridge_ref_sha)" || exit $?
    mkdir -p "$CRATE_DIR"
    printf '%s\n' "$bin_ref_sha" > "$CRATE_DIR/crate-ref.txt"
    shasum -a 256 "$CRATE_BIN" | awk '{print $1}' > "$CRATE_DIR/bridge-bin.sha256"
    log "crate-build: external bridge binary @ ${bin_ref_sha} (sha256 $(cat "$CRATE_DIR/bridge-bin.sha256"))"
    stat -f '%z bytes %N' "$(crate_bin)"
    return
  fi

  # crate のソースを git から作業ディレクトリへ出し（worktree は汚さない）、ブリッジの example を足して組む
  local ref="$CRATE_REF"
  if [[ -z "$ref" ]]; then
    if [[ -d "$ROOT/packages/develop-engine/crates/niho-develop" ]]; then ref="HEAD"; else ref="origin/paneB-5/photo-develop-engine-s3-pr2"; git -C "$ROOT" fetch -q origin paneB-5/photo-develop-engine-s3-pr2; fi
  fi
  local ref_sha; ref_sha="$(git -C "$ROOT" rev-parse --verify "${ref}^{commit}")"
  local target_dir="$CRATE_DIR/target/$ref_sha"
  log "crate-build: niho-develop @ ${ref_sha:0:10}"
  rm -rf "$CRATE_DIR/packages" && mkdir -p "$CRATE_DIR"
  git -C "$ROOT" archive "$ref_sha" packages/develop-engine | tar -x -C "$CRATE_DIR"
  cp "$TOOLS/calibrate/crate-bridge/render_working_copy.rs" "$CRATE_DIR/packages/develop-engine/crates/niho-develop/examples/"
  (cd "$CRATE_DIR/packages/develop-engine" && cargo build --release -p niho-develop --example render_working_copy --target-dir "$target_dir" 2>&1 | tail -2)
  printf '%s\n' "$ref_sha" > "$CRATE_DIR/crate-ref.txt"
  stat -f '%z bytes %N' "$(crate_bin)"
}

step_crate_base() {
  # crate の neutral 描画（作業コピー → 露出 2^baselineEV → ルック → ACR3 → …）と Lightroom 中立の差 = 段 1 ＋ 段 2 の土台
  local bv; bv="$(base_version)"; local bin; bin="$(crate_bin)"; local ref; ref="$(cat "$CRATE_DIR/crate-ref.txt" 2>/dev/null | cut -c1-10)"
  mkdir -p "$WK/crate-neutral" "$WK/results/crate-base"
  for s in "${SCENES[@]}"; do
    log "crate neutral ${s}"
    local r; r="$(ref_neutral "$s")"; local wcd; wcd="$(wc_for "$r")"
    "$bin" "$wcd/$s.png" "$wcd/$s.json" neutral 0 "$WK/crate-neutral/$s.jpg" 97 > "$WK/crate-neutral/$s.timing.json"
    local save=(); for x in "${SAMPLE_SCENES[@]}"; do [[ "$x" == "$s" ]] && save=(--save-pair "$WK/results/pairs"); done
    "${CC[@]}" compare --reference "$r" --candidate "$WK/crate-neutral/$s.jpg" --candidate-space srgb --kind reference --label "crate-base/$s" --scene "$s" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version $DECODER --base-version "${bv}+niho-develop@${ref}" --normalize-exposure --out "$WK/results/crate-base/$s.json" "${save[@]}" >/dev/null
  done
}

step_preset_crate() {
  # 本命: 段 2 の crate で同梱プリセットを当て、Lightroom の round5 書き出しと比べる（gate はこれで判定）
  local bv; bv="$(base_version)"; local bin; bin="$(crate_bin)"; local ref; ref="$(cat "$CRATE_DIR/crate-ref.txt" 2>/dev/null | cut -c1-10)"
  for p in "${PRESETS[@]}"; do mkdir -p "$WK/preset-crate/$p"; done
  for s in "${PRESET_SCENES[@]}"; do
    for p in "${PRESETS[@]}"; do
      log "crate preset ${p} ${s}"
      local wcd; wcd="$(wc_for "$(python3 "$TOOLS/calibrate/refs.py" preset "$REF" "$s" "$p")")"
      "$bin" "$wcd/$s.png" "$wcd/$s.json" "niho-$p" 0 "$WK/preset-crate/$p/$s.jpg" 97 > "$WK/preset-crate/$p/$s.timing.json"
    done
  done
  python3 - "$TOOLS/calibrate" "$WK" "$REF" "${PRESETS[@]}" -- "${PRESET_SCENES[@]}" <<'PY'
import json, sys, os
sys.path.insert(0, sys.argv[1]); import refs
wk, ref, *rest = sys.argv[2:]
i = rest.index("--"); presets, scenes = rest[:i], rest[i+1:]
items = [{"preset": p, "scene": s, "reference": refs.preset(ref, s, p), "candidate": os.path.join(wk, "preset-crate", p, f"{s}.jpg"), "candidateSpace": "srgb"} for p in presets for s in scenes]
json.dump({"schema": "colorcheck/preset-manifest/v1", "stage2": "niho-develop crate (S3) on the calibrated working copy", "items": items}, open(os.path.join(wk, "preset-crate", "manifest.json"), "w"), indent=1, ensure_ascii=False)
PY
  log "プリセットの近さ（crate・${#PRESETS[@]} 本 × ${#PRESET_SCENES[@]} 場面）"
  "${CC[@]}" preset --manifest "$WK/preset-crate/manifest.json" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version $DECODER --base-version "${bv}+niho-develop@${ref}" --out "$WK/results/preset-crate.json" --markdown "$WK/results/preset-crate.md" --save-pairs "$WK/results/pairs" | tail -8
}

step_variants_crate() {
  # 操作別の応答: round5 の機械生成 XMP（Whites / Blacks / Calibration / Split Toning / トーンの分解など）を crate で当て、
  # 同じ XMP の Lightroom 書き出しと比べる。段 2（S3）のどの操作がずれているかを見るための表（gate には使わない）。
  local bv; bv="$(base_version)"; local bin; bin="$(crate_bin)"; local ref; ref="$(cat "$CRATE_DIR/crate-ref.txt" 2>/dev/null | cut -c1-10)"
  mkdir -p "$WK/variants-crate"
  python3 - "$TOOLS/calibrate" "$REF" "$WK" "${PRESET_SCENES[@]}" <<'PY' > "$WK/variants-crate/list.txt"
import json, sys, os
sys.path.insert(0, sys.argv[1]); import refs
ref, wk, *scenes = sys.argv[2:]
scenes = [s for s in scenes if s not in refs.LOOK_CONTAMINATED]   # round5 のこの 3 場面は Adobe Color の Look 入り
d = json.load(open(os.path.join(ref, "round5", "manifest.json")))
items = d if isinstance(d, list) else next(v for v in d.values() if isinstance(v, list))
seen = set()
for it in items:
    if it.get("kind") != "raw" or it.get("scene") not in scenes: continue
    v = it["variant"]
    if v.startswith("full_") or "night" in v: continue   # プリセット全体は preset-crate、night は対象外
    base = os.path.splitext(it["file"])[0]
    xmp = os.path.join(ref, "round5", "round5-photos", base + ".xmp"); lr = os.path.join(ref, "round5", "lr-export", base + ".jpg")
    if os.path.exists(xmp) and os.path.exists(lr):
        print(f"{v}\t{it['scene']}\t{xmp}\t{lr}"); seen.add(v)
print(f"# variants: {sorted(seen)}", file=sys.stderr)
PY
  local n=0
  while IFS=$'\t' read -r v sc xmp lr; do
    [[ -z "$v" || "$v" == \#* ]] && continue
    mkdir -p "$WK/variants-crate/$v"
    local wcd; wcd="$(wc_for "$lr")"
    "$bin" "$wcd/$sc.png" "$wcd/$sc.json" "$xmp" 0 "$WK/variants-crate/$v/$sc.jpg" 97 > "$WK/variants-crate/$v/$sc.timing.json" 2> "$WK/variants-crate/$v/$sc.stderr.txt" || { echo "render failed: $v $sc" >&2; exit 1; }
    n=$((n+1))
  done < "$WK/variants-crate/list.txt"
  log "variants: ${n} 枚を描いた"
  python3 - "$WK" <<'PY'
import json, os, sys
wk = sys.argv[1]; items = []
for line in open(os.path.join(wk, "variants-crate", "list.txt")):
    if not line.strip() or line.startswith("#"): continue
    v, sc, xmp, lr = line.rstrip("\n").split("\t")
    items.append({"preset": v, "scene": sc, "reference": lr, "candidate": os.path.join(wk, "variants-crate", v, f"{sc}.jpg"), "candidateSpace": "srgb"})
json.dump({"schema": "colorcheck/preset-manifest/v1", "stage2": "niho-develop crate (S3) on the calibrated working copy; round5 machine-generated XMP variants", "items": items},
          open(os.path.join(wk, "variants-crate", "manifest.json"), "w"), indent=1, ensure_ascii=False)
print(len(items), "items")
PY
  "${CC[@]}" preset --manifest "$WK/variants-crate/manifest.json" --camera-make "$MAKE" --camera-model "$MODEL" --decoder-version $DECODER --base-version "${bv}+niho-develop@${ref}" --no-gate --out "$WK/results/variants-crate.json" --markdown "$WK/results/variants-crate.md" | grep -vE '^\[preset\]' | head -40
}

step_wb_map() {
  # Apple の as-shot 白 → Adobe（Lightroom）が as-shot と見る白の写像（uv オフセット）を全場面から当てる
  log "wb-map: Apple as-shot xy → Adobe as-shot（LR 書き出し XMP の ColorTemperature / Tint）"
  mkdir -p "$WK/wb-exp"
  (cd "$TOOLS/calibrate" && python3 fit_wb_map.py --work "$WK" --ref "$REF" --out "$WK/wb-exp/asshot-map.json" --scenes "${SCENES[@]}" | tail -3)
  # 校正 JSON（この版）の whiteBalanceMap を当て直した値にする。既存メタデータは同じカメラの apple-v1 からだけ引き継ぐ。
  python3 - "$WK/wb-exp/asshot-map.json" "$CAL" "$ROOT/packages/develop-engine/calibration/$CAMERA_ID/apple-v1.json" <<'PY'
import json, sys, os
mp, cal, v1 = sys.argv[1:]
m = json.load(open(mp)); c = json.load(open(cal))
base = c.get("whiteBalanceMap") or (json.load(open(v1)).get("whiteBalanceMap") if os.path.exists(v1) else None) or {"schema": "niho-develop-wb-map/v1", "model": "uv-offset"}
f = m["fit"]
base = {**base, "du": m["du"], "dv": m["dv"], "fit": {**{k: f[k] for k in ("scenes", "duSd", "dvSd", "residualKSd", "residualTintSd", "residualTintMax")},
        "referenceSet": "Lightroom 中立の書き出し XMP（ColorTemperature / Tint。refs.neutral = round6 優先）× Apple の as-shot xy"}}
c["whiteBalanceMap"] = base
json.dump(c, open(cal, "w"), indent=1, ensure_ascii=False)
print(f"whiteBalanceMap → {cal}: du {m['du']:+.6f} dv {m['dv']:+.6f}（{f['scenes']} 場面）")
PY
}

step_wb_validate() {
  # LR の絶対 WB（round6 の 4000K / 5500K / 7500K・Tint 0 × 13 場面、bluesky2 の 5001K/+10 × プリセットの場面）を、
  # 色順応の出発点 3 通り（Apple xy / 真の Adobe 値 / 写像）で crate に描かせて比べる
  local bin; bin="$(crate_bin)"
  log "wb-validate: round6 の絶対 WB ＋ bluesky2 × 4（as-shot / H1 / H2 / H3）"
  (cd "$TOOLS/calibrate" && python3 wb_validate.py --map "$WK/wb-exp/asshot-map.json" --bridge "$bin" --work "$WK" --ref "$REF" --out "$WK/wb-exp/validate" --cases round6,bluesky2 --preset-scenes "${PRESET_SCENES[@]}" | tail -8)
}

step_summary() {
  python3 - "$WK" "$CAL" "${SCENES[@]}" <<'PY'
import json, sys, os, glob
wk, cal, *scenes = sys.argv[1:]
c = json.load(open(cal)); fit = c["fit"]
split = {it: s for it, s in zip(fit["trainScenes"], ["train"]*len(fit["trainScenes"]))}; split.update({v: "val" for v in fit["valScenes"]})
def load(kind, s):
    p = os.path.join(wk, "results", kind, f"{s}.json")
    return json.load(open(p)) if os.path.exists(p) else None
def m(r, key="deltaE00"):
    return r["metrics"][key] if r else None
rows = []
L = [f"## 土台の色: Apple 線形（decoderVersion 8）＋補正 vs Lightroom Adobe Standard 中立（{len(scenes)} 場面、1500px・σ2 ぼかし後）", "",
     f"- 補正: `{c['baseVersion']}`（{fit.get('selection',{}).get('chosen','?')}）。baselineEV {c['baselineEV']:+.3f} 段。行列 rowMajor = {json.dumps(c['matrix']['rowMajor'])}", "",
     "| 場面 | split | as-shot K | 補正前 mean | 補正前 p99 | 補正後 mean | 補正後 p99 | EV 差 | 彩度比 | カメラ JPEG mean | カメラ JPEG p99 | v7 vs v8 mean |",
     "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
agg = {"train": [], "val": []}; cam = []; dec = []
for s in sorted(scenes):
    b, u, cj, d = load("base", s), load("base-uncal", s), load("camjpeg", s), load("decoder", s)
    k = json.load(open(os.path.join(wk, "apple-linear/v8", f"{s}.json")))["neutral"]["temperatureK"]
    mb, mu, mc, md = m(b), m(u), m(cj), m(d)
    ev = b["metrics"]["evDiff"] if b else None; sat = b["metrics"]["saturationRatio"] if b else None
    L.append(f"| {s} | {split.get(s,'?')} | {k:.0f} | {mu['mean']:.2f} | {mu['p99']:.2f} | {mb['mean']:.2f} | {mb['p99']:.2f} | {ev:+.3f} | {sat:.3f} | " + (f"{mc['mean']:.2f} | {mc['p99']:.2f}" if mc else "- | -") + " | " + (f"{md['mean']:.3f}" if md else "-") + " |")
    if b: agg[split.get(s, "train")].append((mu["mean"], mb["mean"], mu["p99"], mb["p99"]))
    if mc: cam.append(mc["mean"])
    if md: dec.append(md["mean"])
L += ["", "| 集合 | 場面数 | 補正前 mean | 補正後 mean | 補正前 p99(max) | 補正後 p99(max) |", "|---|---:|---:|---:|---:|---:|"]
for sp in ("train", "val"):
    a = agg[sp]
    if a: L.append(f"| {sp} | {len(a)} | {sum(x[0] for x in a)/len(a):.2f} | {sum(x[1] for x in a)/len(a):.2f} | {max(x[2] for x in a):.2f} | {max(x[3] for x in a):.2f} |")
if cam: L.append(f"\n- カメラ JPEG（RAW 埋め込み）との差: mean の平均 {sum(cam)/len(cam):.2f}（gate 目安 4.0。カメラ内のレンズ補正ありなので Apple の補正ありと比べる）")
if dec: L.append(f"- decoderVersion 7 vs 8（同じ補正）: mean の平均 {sum(dec)/len(dec):.3f}・最大 {max(dec):.3f}（gate 0.5）")
cb = sorted(glob.glob(os.path.join(wk, "results", "crate-base", "*.json")))
if cb:
    L += ["", "## 段 2 の crate（niho-develop）で neutral を描いた土台 vs Lightroom 中立（作業コピー → 2^baselineEV → ルック → ACR3 → sRGB）", "",
          "| 場面 | ΔE00 mean | p99 | EV 差 | 彩度比 | Python 参照レンダリングとの差（mean） |", "|---|---:|---:|---:|---:|---:|"]
    for p in cb:
        r = json.load(open(p)); mm = r["metrics"]; sc = r.get("scene"); b = load("base", sc); bm = m(b)
        L.append(f"| {sc} | {mm['deltaE00']['mean']:.2f} | {mm['deltaE00']['p99']:.2f} | {mm['evDiff']:+.3f} | {mm['saturationRatio']:.3f} | {mm['deltaE00']['mean'] - bm['mean']:+.2f} |")
    vals = [json.load(open(p))["metrics"]["deltaE00"]["mean"] for p in cb]
    L.append(f"\n- crate の土台: mean の平均 {sum(vals)/len(vals):.2f}（Python 参照レンダリング {sum(m(load('base', json.load(open(p)).get('scene')))['mean'] for p in cb)/len(cb):.2f}）")
pcr = os.path.join(wk, "results", "preset-crate.md")
if os.path.exists(pcr): L += ["", "## プリセットの近さ（本命: 段 2 の crate niho-develop・LR 書き出し（round6 優先・無ければ round5）との差。gate はこれで判定）", "", open(pcr).read()]
vc = os.path.join(wk, "results", "variants-crate.md")
if os.path.exists(vc): L += ["", "## 操作別の応答（crate で round5 の機械生成 XMP を当て、同じ XMP の LR 書き出しと比べる。S3 の追い込み用・gate には使わない）", "", open(vc).read()]
wbv = os.path.join(wk, "wb-exp", "validate", "wb-validate.json")
if os.path.exists(wbv):
    d = json.load(open(wbv)); cases = d["cases"]
    # wb_validate.py の列は "asshot" と "<H>/<色順応>"（既定 bradford）。H だけで引けるようにそろえる
    for c in cases:
        r = c["results"]
        for h in ("H1", "H2", "H3"):
            if h not in r:
                k = next((k for k in r if k.startswith(h + "/")), None)
                if k: r[h] = r[k]
    L += ["", "## Lightroom の絶対 WB の再現（色順応の出発点の比較。ΔE00 mean）", "",
          "as-shot = WB を動かさない（crate の bluesky2 の今）／H1 = Apple の as-shot xy を出発点（crate の絶対 WB の今の式）／H2 = Lightroom が as-shot と見た白（書き出し XMP の値。本番では得られない上限）／H3 = Apple xy を校正 JSON の whiteBalanceMap（uv オフセット）で写した白（本番で使える）", "",
          "| ケース | K / tint | as-shot | H1 Apple xy | H2 Adobe 実値 | H3 写像 |", "|---|---|---:|---:|---:|---:|"]
    for c in cases:
        r = c["results"]; L.append(f"| {c['case']} | {c['K']}/{c['tint']:+d} | {r['asshot']['deltaE00Mean']:.2f} | {r['H1']['deltaE00Mean']:.2f} | {r['H2']['deltaE00Mean']:.2f} | {r['H3']['deltaE00Mean']:.2f} |")
    import statistics as st
    for name, sel in ((f"全 {len(cases)}", cases), ("絶対 WB の変種", [c for c in cases if not c["case"].startswith("bluesky2")]), ("bluesky2", [c for c in cases if c["case"].startswith("bluesky2")])):
        if not sel: continue
        L.append(f"| **平均 {name}** | | {st.mean(c['results']['asshot']['deltaE00Mean'] for c in sel):.2f} | {st.mean(c['results']['H1']['deltaE00Mean'] for c in sel):.2f} | {st.mean(c['results']['H2']['deltaE00Mean'] for c in sel):.2f} | {st.mean(c['results']['H3']['deltaE00Mean'] for c in sel):.2f} |")
# 代役（Photo Bench）の表は、この版の校正より古ければ載せない（別の版の数値が混ざるため）
fresh = lambda p: os.path.exists(p) and os.path.getmtime(p) >= os.path.getmtime(cal)
pm = os.path.join(wk, "results", "preset.md")
if fresh(pm): L += ["", "## 参考: プリセットの近さ（段 2 の代役 = photobench-render coreimage）", "", open(pm).read()]
pc = os.path.join(wk, "results", "preset-control.md")
if fresh(pc): L += ["", "## 対照: 土台 = Lightroom 中立 JPEG（完全な土台）で同じ代役の段 2 を通した差（＝代役の段 2 だけの差）", "", open(pc).read()]
open(os.path.join(wk, "results", "summary.md"), "w").write("\n".join(L) + "\n"); print("\n".join(L))
PY
}

step_report() {
  mkdir -p "$FIX_DIR/samples"
  # Photo Bench の代役によるプリセットの結果は判定に使わないので report / fixture には入れない（summary.md と Issue に残す）。
  # crate（本命）のプリセット結果と crate の土台は入れる。
  local results=("$WK"/results/base/*.json "$WK"/results/camjpeg/*.json "$WK"/results/decoder/*.json)
  compgen -G "$WK/results/crate-base/*.json" > /dev/null && results+=("$WK"/results/crate-base/*.json)
  [[ -f "$WK/results/preset-crate.json" ]] && results+=("$WK/results/preset-crate.json")
  # 見本（長辺 480px）をリポジトリへ写すのは SAMPLE_SCENES（人物の顔が無い場面）だけ。プリセットの見本は
  # 全場面ぶん pairs/<preset>/ にできるが、ほかの場面は作業ディレクトリのまま report から参照する（owner の私物）
  if [[ -d "$WK/results/pairs" ]]; then
    local f rel s
    while IFS= read -r -d '' f; do
      rel="${f#"$WK/results/pairs/"}"
      for s in ${SAMPLE_SCENES[@]+"${SAMPLE_SCENES[@]}"}; do
        if [[ "$(basename "$f")" == *"_${s}_"* ]]; then
          mkdir -p "$FIX_DIR/samples/$(dirname "$rel")"
          cp "$f" "$FIX_DIR/samples/$rel"
        fi
      done
    done < <(find "$WK/results/pairs" -type f -name '*.jpg' -print0)
  fi
  "${CC[@]}" report --results "${results[@]}" --out "$FIX_DIR/report.html" --title "${MODEL} × Apple 現像 ${VERSION}（土台 A）"
  "${CC[@]}" fixture write --results "${results[@]}" --out "$FIX_DIR/$VERSION.json"
  "${CC[@]}" gates --results "${results[@]}" | tail -40
}

case "$step" in
  render) step_render ;;
  manifest) step_manifest ;;
  fit) step_fit ;;
  base) step_base ;;
  camjpeg) step_camjpeg ;;
  decoder) step_decoder ;;
  preset) step_preset ;;
  preset-control) step_preset_control ;;
  wc) step_wc ;;
  crate-build) step_crate_build ;;
  crate-base) step_crate_base ;;
  preset-crate) step_preset_crate ;;
  variants-crate) step_variants_crate ;;
  wb-map) step_wb_map ;;
  wb-validate) step_wb_validate ;;
  summary) step_summary ;;
  report) step_report ;;
  # wb-map は wc より前（作業コピーのメタの asShotWhiteAdobe が校正 JSON の whiteBalanceMap を使う）
  all) step_manifest; step_fit; step_wb_map; step_base; step_camjpeg; step_decoder; step_wc; step_crate_build; step_crate_base; step_preset_crate; step_variants_crate; step_wb_validate; step_preset; step_preset_control; step_summary; step_report ;;
  *) echo "unknown step: $step" >&2; sed -n '2,10p' "$0"; exit 1 ;;
esac
