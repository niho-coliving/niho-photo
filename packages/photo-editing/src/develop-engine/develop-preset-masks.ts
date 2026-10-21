import {
  cropBoxFromGeometry,
  developFrameSize,
  geometryOutputToSource,
  parseDevelopGeometry,
  type DevelopGeometry,
  type DevelopSize,
} from "./develop-geometry";
import { canonicalDevelopMask, parseDevelopMasks, type DevelopMask, type DevelopMaskPoint } from "./develop-masks";

/**
 * プリセット（Lightroom の XMP）の部分補正を、当てる写真の作業画像の座標へ写す（契約は `docs/local-adjustments.md`「Lightroom の
 * XMP の読み」）。crate の `presetSettings` / `applyPreset` が返すマスク（`DevelopPresetResult.masks`）の座標は、当てる写真の
 * **見えている枠**（出力。切り抜き・回転・反転・角度補正の後）の上にある。`developSettings.masks` は作業画像（向き反映済み・幾何の前）
 * の上に置くので、出力の位置を {@link geometryOutputToSource}（crate の描き方と同じ写像）で作業画像へ戻す。
 *
 * - 線形: `zero` と `full` をそれぞれ写す
 * - 円形: 中心と 2 本の半軸の端を写し、作業画像の上で中心・半軸・角度を求め直す（写像は画素の上で相似なので楕円は楕円のまま）。
 *   角度は −45〜45 にそろえる（90° / 270° の回転では幅と高さの半軸が入れ替わり、角度補正はその角度が付く）
 * - 写した後で M1 の範囲（線形の点 −1〜2・2 点の距離 0.001 以上、円形の中心 0〜1・半軸 0.005〜1.5）に入らないマスクは置かない
 *   （小さな切り抜きでは、短い線形や小さな円形が縮んで範囲を外れる）。面のマスク（ブラシ・被写体・空）はプリセットから来ない
 */

/** プリセットのマスクを写真に置くのに要るもの（`presetDevelopSettings` の第 3 引数）。 */
export type PresetMasksPlacement = {
  /** プリセットの結果のマスク（`DevelopPresetResult.masks`。見えている枠の座標） */
  masks?: readonly DevelopMask[];
  /** 当てる写真の作業画像の大きさ（向き反映済み・幾何の前。縦横比だけを使う）。分からなければ null（プリセットのマスクを置かない） */
  source: DevelopSize | null;
};

type Placed = { masks: DevelopMask[]; dropped: number };

function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** 楕円の軸の向き（度）を (−90, 90] に収める（楕円は 180° 回しても同じ）。 */
function halfTurn(angle: number): number {
  let value = angle;
  while (value > 90) value -= 180;
  while (value <= -90) value += 180;
  return value;
}

/** M1 の読み方で読めるマスクか（正規形に丸めた後で範囲を確かめる）。読めれば正規化したものを返す。 */
function validMask(mask: DevelopMask, whiteBalanceMode: unknown): DevelopMask | null {
  let canonical: Record<string, unknown>;
  try {
    canonical = canonicalDevelopMask(mask);
  } catch {
    // 丸めると線形の 2 点の距離を保てない
    return null;
  }
  return parseDevelopMasks([canonical], { whiteBalanceMode })?.[0] ?? null;
}

/**
 * 見えている枠の座標のマスクを、作業画像の座標へ写す（{@link PresetMasksPlacement}）。幾何が描けない形（crate の `invalidCrop`）
 * なら 1 枚も置かない。`dropped` は置けなかった枚数。
 */
export function presetMasksOnWorkingImage(
  masks: readonly DevelopMask[],
  geometry: DevelopGeometry,
  source: DevelopSize,
  options: { whiteBalanceMode?: unknown } = {},
): Placed {
  if (!(source.width > 0 && source.height > 0)) return { masks: [], dropped: masks.length };
  const box = cropBoxFromGeometry(geometry, developFrameSize(source, geometry.rotate));
  if (!box) return { masks: [], dropped: masks.length };
  // 角度補正で枠に収めるときは中心の回りに一様に縮めるので、出力の縦横比は箱のまま
  const outputAspect = box.width / box.height;
  const sourceAspect = source.width / source.height;
  const toSource = (point: DevelopMaskPoint): DevelopMaskPoint | null => {
    const mapped = geometryOutputToSource(geometry, source, point.x, point.y);
    return mapped ? { x: mapped[0], y: mapped[1] } : null;
  };
  const placed: DevelopMask[] = [];
  let dropped = 0;
  for (const mask of masks) {
    let next: DevelopMask | null = null;
    if (mask.kind === "linear") {
      const zero = toSource(mask.zero);
      const full = toSource(mask.full);
      if (zero && full) next = { ...mask, zero, full };
    } else if (mask.kind === "radial") {
      // 出力の上の半軸の端（高さをそろえた座標で、1 本目は angle の向き・2 本目はそれと直交）
      const theta = (mask.angle * Math.PI) / 180;
      const { center, radius } = mask;
      const center2 = toSource(center);
      const end1 = toSource({
        x: center.x + radius.x * Math.cos(theta),
        y: center.y + radius.x * outputAspect * Math.sin(theta),
      });
      const end2 = toSource({
        x: center.x - (radius.y * Math.sin(theta)) / outputAspect,
        y: center.y + radius.y * Math.cos(theta),
      });
      if (center2 && end1 && end2) {
        // 作業画像の上で、高さをそろえた座標（X = x·A、Y = y）の半軸
        const axis1 = { x: (end1.x - center2.x) * sourceAspect, y: end1.y - center2.y };
        const axis2 = { x: (end2.x - center2.x) * sourceAspect, y: end2.y - center2.y };
        const length1 = Math.hypot(axis1.x, axis1.y);
        const length2 = Math.hypot(axis2.x, axis2.y);
        let angle = halfTurn(degrees(Math.atan2(axis1.y, axis1.x)));
        let radiusX = length1 / sourceAspect;
        let radiusY = length2;
        if (Math.abs(angle) > 45) {
          // 2 本目の軸を 1 本目にする（90° 回した写真の横長の楕円は、作業画像では縦長）
          angle = angle > 0 ? angle - 90 : angle + 90;
          radiusX = length2 / sourceAspect;
          radiusY = length1;
        }
        next = { ...mask, center: center2, radius: { x: radiusX, y: radiusY }, angle: angle + 0 };
      }
    }
    const valid = next ? validMask(next, options.whiteBalanceMode) : null;
    if (valid) placed.push(valid);
    else dropped += 1;
  }
  return { masks: placed, dropped };
}

/**
 * `presetDevelopSettings` が写真に置くプリセットのマスク（正規形）。置かない（マスクが無い・作業画像の大きさが分からない・幾何が
 * 読めない・1 枚も置けない）ときは null で、写真のマスクは当てる前のまま。
 */
export function presetMasksForPhoto(
  geometry: unknown,
  placement: PresetMasksPlacement | undefined,
  whiteBalanceMode: unknown,
): Record<string, unknown>[] | null {
  const masks = placement?.masks;
  if (!masks || masks.length === 0 || !placement.source) return null;
  const parsed = parseDevelopGeometry(geometry);
  if (!parsed) return null;
  const placed = presetMasksOnWorkingImage(masks, parsed, placement.source, { whiteBalanceMode });
  return placed.masks.length > 0 ? placed.masks.map(canonicalDevelopMask) : null;
}
