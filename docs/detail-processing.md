# Detail processing v5

`developSettings.detail` が存在する設定は `v: 5` とする。形は次の exact object で、未知キー、欠落、非有限値、範囲外を Rust と TypeScript の両方で拒否する。

```json
{
  "sharpening": { "amount": 0, "radius": 1, "detail": 25, "masking": 0 },
  "luminanceNoiseReduction": 0
}
```

`colorNoiseReduction`（0..100）は任意。省略は signed RAW の旧 top-level `colorNoiseReduction`（R209、上限50）を保ち、明示値は0を含めてそれを上書きする。JPEG/PNGは旧top-level値を引き続き無視し、v5内で明示された値だけを使う。従ってRAWでもrasterでもカラーNRは一回だけで、旧 `Sharpness` 等のextraは有効化しない。

処理順は、immutable float source → カラーNR → edge-preserving輝度NR → canonical RAW H/S解析またはNIHO raster解析 → WB/露光 → 局所階調 → look/tone/color/color points/grading → output-resolution linear-sRGB luma sharpening → output transform → vignetteのoutput段・grain → RGBA8。NR済みsourceをcanonical解析、local statistics、通常render、`sampleColor`で共有する。シャープはRGBA8をdecodeせずfloat出力境界で行い、grain等のoutput effectを再適用しない。

NRはlinear ProPhotoでカラーを処理する（JPEG/PNGは往復行列変換）。輝度guided filterとUSMのradiusは1500pxのwhole-image long edge基準で拡縮する。cropは同じwhole-image scaleとgeometry windowのhaloを使うため境界でradiusや見た目を変えない。amount 0は演算を通らず既存pixel経路を保持する。Interactiveはsharpenを省略できるが、Finalはfloat planeから必ず確定する。

Sessionの再利用単位はimmutable source、NR量、working size、geometry window、quality。量・サイズ・geometry・Interactive/Finalの変更で一致しないcacheを再利用しない。RAWのcanonical response/statistics cacheもeffective CNRと輝度NR量をkeyに含める。

Studio計測は `scripts/bench-session.mjs` の `detail` scenarioを使い、2048px Finalと1280px Interactiveを別stepで記録する。未実測値は合格扱いにしない。
