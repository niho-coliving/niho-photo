#!/usr/bin/env bash
# Render the DC-S5 reference set (16 scenes + 10 from round6) with apple-raw-linear.
#
#   scripts/render-reference-set.sh [--force]
#
# Outputs (all under $NIHO_COLOR_WORK_DIR, never inside the repository — the
# RAWs are the owner's own photos):
#   apple-linear/v8/<scene>.tiff + .json   --long-edge 2560 --space linear-prophoto --encoding tiff32f --decoder-version 8
#   apple-linear/v7/<scene>.tiff + .json   same with --decoder-version 7
#   apple-linear/v8-nolens/<scene>.tiff    same as v8 with --lens-correction off (color measurement against
#                                          Lightroom exports that have the lens profile off: geometry matches to 0.1px)
#   camera-jpeg/<scene>.jpg                exiftool -b -JpgFromRaw (in-camera JPEG, 1920x1280, not rotated)
#   timing/fullres-P1012822.txt            /usr/bin/time -l ... --long-edge full --encoding tiff32f
#   timing/workingcopy-P1012822.txt        /usr/bin/time -l ... --long-edge 2560 --encoding png16-g18
#   timing/summary.json                    total ms / peakRSS collected from the metadata JSON
#   cameras/supported-cameras-macos<version>-<build>.txt
#   apple-linear/failures.txt              reasons for failed tasks of the last run (removed when none)
#
# Existing outputs are skipped unless --force is given (then they are overwritten).
#
# Environment:
#   NIHO_COLOR_WORK_DIR      default OWNER_DATA_ROOT
#   NIHO_REFERENCE_RAW_ROOT  default OWNER_DATA_ROOT
#   NIHO_ROUND6_RAW_ROOT     default <NIHO_REFERENCE_RAW_ROOT>/../round6 (owner's RAWs placed directly in round6/)
#   APPLE_RAW_LINEAR_BIN     default <package>/.build/release/apple-raw-linear (built with `swift build -c release` if missing)
#
# macOS only. Not run in CI.
set -euo pipefail

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) force=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "$script_dir/.." && pwd)"
work="${NIHO_COLOR_WORK_DIR:-OWNER_DATA_ROOT}"
raw_root="${NIHO_REFERENCE_RAW_ROOT:-OWNER_DATA_ROOT}"
round6_root="${NIHO_ROUND6_RAW_ROOT:-$raw_root/../round6}"
bin="${APPLE_RAW_LINEAR_BIN:-$package_dir/.build/release/apple-raw-linear}"

scenes_main=(P1012822 P1013207 P1013558 P1522877 P1524180 P1524181)
scenes_extra=(P1581215 P1581237 P1581243 P1581255 P1581256 P1581332 P1581335 P1581346 P1581356 P1581368)
# round6（2026-09-29）: 昼光の屋外・窓際・肌。RAW は round6/ 直下の原本（round6-photos の複製と同じ中身）
scenes_round6=(P1570133 P1570135 P1570258 P1570266 P1570280 P1570302 P1570396 P1570586 P1570755 P1570923)
timing_scene=P1012822

command -v exiftool > /dev/null || {
  echo "exiftool not found (brew install exiftool)" >&2
  exit 1
}
command -v python3 > /dev/null || {
  echo "python3 not found (needed for timing/summary.json)" >&2
  exit 1
}
if [[ ! -x "$bin" ]]; then
  echo "building apple-raw-linear (swift build -c release)"
  swift build -c release --package-path "$package_dir" >&2
  bin="$package_dir/.build/release/apple-raw-linear"
fi
mkdir -p "$work/apple-linear/v8" "$work/apple-linear/v7" "$work/camera-jpeg" "$work/timing" "$work/cameras"

raw_path() {
  local scene="$1" candidate
  for candidate in "${scenes_round6[@]}"; do
    if [[ "$candidate" == "$scene" ]]; then
      echo "$round6_root/${scene}.RW2"
      return
    fi
  done
  for candidate in "${scenes_main[@]}"; do
    if [[ "$candidate" == "$scene" ]]; then
      echo "$raw_root/round2-photos/p2_${scene}_neutral.RW2"
      return
    fi
  done
  echo "$raw_root/round2-extra-photos/p2_${scene}_neutral.RW2"
}

rendered=0
skipped=0
failed=0
failures=()
task=0
total_tasks=$(((${#scenes_main[@]} + ${#scenes_extra[@]} + ${#scenes_round6[@]}) * 4 + 3))

progress() {
  task=$((task + 1))
  printf '[%3d/%d] %s\n' "$task" "$total_tasks" "$*"
}

record_failure() {
  failed=$((failed + 1))
  failures+=("$*")
  progress "FAIL  $*"
}

# The render summary is one JSON line; pull a few fields without jq.
summary_fields() {
  local line="$1" width="?" height="?" ms="?"
  [[ "$line" =~ \"width\":([0-9]+) ]] && width="${BASH_REMATCH[1]}"
  [[ "$line" =~ \"height\":([0-9]+) ]] && height="${BASH_REMATCH[1]}"
  [[ "$line" =~ \"totalMs\":([0-9]+) ]] && ms="${BASH_REMATCH[1]}"
  echo "${width}x${height} ${ms}ms"
}

render_scene() {
  local version="$1" scene="$2" lens="${3:-on}" raw out meta result code dir
  raw="$(raw_path "$scene")"
  dir="v$version"
  [[ "$lens" == off ]] && dir="v$version-nolens"
  mkdir -p "$work/apple-linear/$dir"
  out="$work/apple-linear/$dir/$scene.tiff"
  meta="$work/apple-linear/$dir/$scene.json"
  if [[ $force -eq 0 && -s "$out" && -s "$meta" ]]; then
    skipped=$((skipped + 1))
    progress "skip  $dir $scene (exists)"
    return
  fi
  if [[ ! -f "$raw" ]]; then
    record_failure "$dir $scene: RAW not found: $raw"
    return
  fi
  if result="$("$bin" render "$raw" --out "$out" --meta "$meta" \
    --long-edge 2560 --space linear-prophoto --encoding tiff32f --decoder-version "$version" --lens-correction "$lens")"; then
    rendered=$((rendered + 1))
    progress "ok    $dir $scene $(summary_fields "$result")"
  else
    code=$?
    record_failure "$dir $scene: exit $code $result"
  fi
}

extract_jpeg() {
  local scene="$1" raw jpg partial
  raw="$(raw_path "$scene")"
  jpg="$work/camera-jpeg/$scene.jpg"
  if [[ $force -eq 0 && -s "$jpg" ]]; then
    skipped=$((skipped + 1))
    progress "skip  jpeg $scene (exists)"
    return
  fi
  partial="$work/camera-jpeg/.$scene.jpg.partial-$$"
  if exiftool -b -JpgFromRaw "$raw" > "$partial" 2> /dev/null && [[ -s "$partial" ]]; then
    mv -f "$partial" "$jpg"
    rendered=$((rendered + 1))
    progress "ok    jpeg $scene ($(wc -c < "$jpg" | tr -d ' ') bytes)"
  else
    rm -f "$partial"
    record_failure "jpeg $scene: exiftool -b -JpgFromRaw produced no data for $raw"
  fi
}

timing_run() {
  local name="$1" out="$2"
  shift 2
  local txt="$work/timing/$name.txt" meta="$work/timing/$name.json" partial code
  if [[ $force -eq 0 && -s "$txt" && -s "$meta" && -s "$out" ]]; then
    skipped=$((skipped + 1))
    progress "skip  timing $name (exists)"
    return
  fi
  partial="$work/timing/.$name.txt.partial-$$"
  if { /usr/bin/time -l "$bin" render "$(raw_path "$timing_scene")" --out "$out" --meta "$meta" "$@"; } > "$partial" 2>&1; then
    mv -f "$partial" "$txt"
    rendered=$((rendered + 1))
    progress "ok    timing $name $(summary_fields "$(grep -m 1 '"ok":true' "$txt" || true)")"
  else
    code=$?
    mv -f "$partial" "$txt"
    record_failure "timing $name: exit $code (see $txt)"
  fi
}

write_cameras() {
  local version build cameras
  version="$(sw_vers -productVersion)"
  build="$(sw_vers -buildVersion)"
  cameras="$work/cameras/supported-cameras-macos${version}-${build}.txt"
  if [[ $force -eq 0 && -s "$cameras" ]]; then
    skipped=$((skipped + 1))
    progress "skip  cameras (exists)"
    return
  fi
  if "$bin" cameras --out "$cameras" 2> /dev/null; then
    rendered=$((rendered + 1))
    progress "ok    cameras $(head -n 1 "$cameras") models -> $(basename "$cameras")"
  else
    record_failure "cameras: apple-raw-linear cameras failed"
  fi
}

write_summary() {
  WORK="$work" python3 - << 'PY'
import datetime, glob, json, os, re, statistics

work = os.environ["WORK"]

def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

def time_l(path):
    """Parse `/usr/bin/time -l` output (macOS)."""
    result = {}
    if not os.path.exists(path):
        return result
    text = open(path, encoding="utf-8", errors="replace").read()
    match = re.search(r"([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys", text)
    if match:
        result["realSeconds"], result["userSeconds"], result["sysSeconds"] = map(float, match.groups())
    for key, label in (("maxResidentSetBytes", "maximum resident set size"), ("peakMemoryFootprintBytes", "peak memory footprint")):
        found = re.search(r"(\d+)\s+" + re.escape(label), text)
        if found:
            result[key] = int(found.group(1))
    return result

def stats(values):
    values = [v for v in values if isinstance(v, (int, float))]
    if not values:
        return None
    return {"mean": statistics.fmean(values), "median": statistics.median(values), "min": min(values), "max": max(values)}

summary = {"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "timing": {}, "batch": {}}
for name in ("fullres-P1012822", "workingcopy-P1012822"):
    meta_path = os.path.join(work, "timing", name + ".json")
    if not os.path.exists(meta_path):
        continue
    meta = load(meta_path)
    summary.setdefault("tool", meta.get("tool"))
    summary.setdefault("environment", meta.get("environment"))
    summary["timing"][name] = {
        "encoding": meta["encoding"]["name"],
        "outputSize": meta["outputSize"],
        "outputBytes": meta["output"]["bytes"],
        "decoderVersion": meta["decoderVersion"],
        "timingMs": meta["timingMs"],
        "totalMs": meta["timingMs"]["total"],
        "peakRSSBytes": meta["peakRSSBytes"],
        "usrBinTimeL": time_l(os.path.join(work, "timing", name + ".txt")),
    }
for version in ("v8", "v7"):
    metas = [load(p) for p in sorted(glob.glob(os.path.join(work, "apple-linear", version, "*.json")))]
    if not metas:
        continue
    summary["batch"][version] = {
        "count": len(metas),
        "outputSizes": sorted({"%dx%d" % (m["outputSize"]["width"], m["outputSize"]["height"]) for m in metas}),
        "totalMs": stats([m["timingMs"]["total"] for m in metas]),
        "decodeRenderMs": stats([m["timingMs"]["decodeRender"] for m in metas]),
        "encodeMs": stats([m["timingMs"]["encode"] for m in metas]),
        "peakRSSBytes": stats([m["peakRSSBytes"] for m in metas]),
        "warnings": sum(len(m.get("warnings", [])) for m in metas),
    }
out = os.path.join(work, "timing", "summary.json")
with open(out + ".partial", "w", encoding="utf-8") as handle:
    json.dump(summary, handle, indent=2, sort_keys=True)
    handle.write("\n")
os.replace(out + ".partial", out)
for name, item in summary["timing"].items():
    print("summary %-22s total %8.0f ms  peakRSS %6.0f MiB  %s" % (name, item["totalMs"], item["peakRSSBytes"] / 2**20, "%dx%d" % (item["outputSize"]["width"], item["outputSize"]["height"])))
for version, item in summary["batch"].items():
    print("summary batch %-3s %2d files  total mean %6.0f ms (max %6.0f)  peakRSS max %6.0f MiB" % (version, item["count"], item["totalMs"]["mean"], item["totalMs"]["max"], item["peakRSSBytes"]["max"] / 2**20))
PY
}

echo "apple-raw-linear reference set: $($bin version)"
echo "work: $work"
echo "raw:  $raw_root"
for scene in "${scenes_main[@]}" "${scenes_extra[@]}" "${scenes_round6[@]}"; do
  render_scene 8 "$scene"
  render_scene 7 "$scene"
  render_scene 8 "$scene" off
  extract_jpeg "$scene"
done
timing_run fullres-P1012822 "$work/timing/fullres-P1012822.tiff" --long-edge full --encoding tiff32f
timing_run workingcopy-P1012822 "$work/timing/workingcopy-P1012822.png" --long-edge 2560 --encoding png16-g18
write_cameras
write_summary || record_failure "summary: timing/summary.json could not be written"

failure_log="$work/apple-linear/failures.txt"
if [[ $failed -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" > "$failure_log"
  echo "failures ($failed) written to $failure_log:"
  printf '  %s\n' "${failures[@]}"
else
  rm -f "$failure_log"
fi
echo "done: $rendered written, $skipped skipped, $failed failed ($task tasks) in ${SECONDS}s"
[[ $failed -eq 0 ]]
