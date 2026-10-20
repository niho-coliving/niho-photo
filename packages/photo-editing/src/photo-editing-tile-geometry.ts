import type { CSSProperties } from "react";

import { hasDevelopGeometry } from "./develop-engine/develop-settings";

/**
 * 一覧のタイルで、補正前のプレビュー（長辺 1024px）に `developSettings.geometry`（回転・反転・角度補正・切り抜き。F3 移行元設計）を
 * CSS で当てて見せる（移行元設計。表示だけで、保存したことにはしない）。補正後のプレビュー（K3 移行元設計）のタイルを出す写真には
 * 当てない（切り抜き・回転は補正後のプレビューの画に入っている）。
 *
 * 座標は crate の `geometry.rs` と同じ: 枠は画像（向きは反映済み）を `rotate` だけ時計回りに回し、`flipH`・`flipV` で鏡映した
 * もの。`crop` の `(left, top)` / `(right, bottom)` は切り抜き枠の左上・右下の角が枠の上で実際にある位置（x は幅・y は高さで 0〜1）、
 * `angle` は切り抜き枠を中心の回りに時計回りに回す角度。角が枠から出るときは crate と同じく中心の回りに縮めて収める。
 *
 * CSS は測らずに当てる: 切り抜きの縦横比の箱をタイルに cover で置き（{@link PhotoEditingTileGeometryStyles.box}）、その中で
 * プレビューの `<img>` に「平行移動（img の箱に対する %）→ 回転・反転の行列」を掛ける（{@link PhotoEditingTileGeometryStyles.image}）。
 */

/** 箱と画像に当てる style（どちらも絶対配置。箱の親はタイルのセルで、`overflow: hidden` と `position: relative` を持つ）。 */
export type PhotoEditingTileGeometryStyles = {
  box: CSSProperties;
  image: CSSProperties;
};

type Vec = [number, number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits = 4): number {
  // 表示だけなので % は小数 4 桁、回転の行列は 6 桁で足りる（長辺 1024px で 0.01px 未満。文字列を短くし、テストで比べやすくする）
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale + 0;
}

/**
/**
 * 一覧のタイルに当てる幾何（補正後のプレビューのタイルを出さない写真のうち、保存してある `developSettings` が恒等でない幾何を
 * 持つもの。補正の置き場は `developSettings` の 1 つ: K1c 移行元設計）。無ければ null（そのまま出す）。補正後のプレビューがあっても
 * タイルの URL を出せなかった写真（一覧の外の応答・署名に失敗した行）は補正前のプレビューを出すので、そのときは当てる（タイルの
 * 選び方は `browserPhotoTileUrl` と揃える）。
 */
export function photoEditingTileGeometry(photo: {
  developSettings?: unknown;
  editedPreview?: { thumbUrl: string | null } | null;
}): Record<string, unknown> | null {
  if (photo.editedPreview?.thumbUrl != null) return null;
  if (!hasDevelopGeometry(photo.developSettings)) return null;
  const settings = photo.developSettings;
  return isRecord(settings) && isRecord(settings.geometry) ? settings.geometry : null;
}

/**
 * `geometry` を `naturalWidth x naturalHeight`（向きを反映したプレビューの実寸）の画像に当て、縦横比 `cellAspect`（幅 / 高さ）の
 * セルいっぱいに（cover）見せる style。形の壊れた幾何・寸法が分からない・長方形にならない切り抜きは null（そのまま出す）。
 */
export function photoEditingTileGeometryStyles(
  geometry: unknown,
  naturalWidth: number,
  naturalHeight: number,
  cellAspect = 4 / 3,
): PhotoEditingTileGeometryStyles | null {
  if (!isRecord(geometry) || !(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  const rotate = finite(geometry.rotate, 0);
  const angle = finite(geometry.angle, 0);
  const flipH = geometry.flipH === undefined ? false : geometry.flipH;
  const flipV = geometry.flipV === undefined ? false : geometry.flipV;
  const crop = geometry.crop === undefined ? {} : geometry.crop;
  if (rotate === null || angle === null || typeof flipH !== "boolean" || typeof flipV !== "boolean" || !isRecord(crop)) {
    return null;
  }
  const left = finite(crop.left, 0);
  const top = finite(crop.top, 0);
  const right = finite(crop.right, 1);
  const bottom = finite(crop.bottom, 1);
  if (left === null || top === null || right === null || bottom === null) return null;
  const turn = ((rotate % 360) + 360) % 360;
  if (turn % 90 !== 0) return null;

  const [ws, hs] = [naturalWidth, naturalHeight];
  const quarter = turn === 90 || turn === 270;
  const [wf, hf] = quarter ? [hs, ws] : [ws, hs];

  // 画像の点 s から枠の点 f へ: f = D s + d0（時計回りの回転の後に鏡映）
  let dx: Vec;
  let dy: Vec;
  let d0: Vec;
  switch (turn) {
    case 90:
      [dx, dy, d0] = [[0, 1], [-1, 0], [hs, 0]];
      break;
    case 180:
      [dx, dy, d0] = [[-1, 0], [0, -1], [ws, hs]];
      break;
    case 270:
      [dx, dy, d0] = [[0, -1], [1, 0], [0, ws]];
      break;
    default:
      [dx, dy, d0] = [[1, 0], [0, 1], [0, 0]];
  }
  if (flipH) [dx, dy, d0] = [[-dx[0], dx[1]], [-dy[0], dy[1]], [wf - d0[0], d0[1]]];
  if (flipV) [dx, dy, d0] = [[dx[0], -dx[1]], [dy[0], -dy[1]], [d0[0], hf - d0[1]]];

  // 切り抜き枠（crate の CropRect::corners と収め方）
  const theta = (angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(theta), Math.sin(theta)];
  const u: Vec = [cos, sin];
  const v: Vec = [-sin, cos];
  let ul: Vec = [left * wf, top * hf];
  const diag: Vec = [right * wf - ul[0], bottom * hf - ul[1]];
  let cropW = diag[0] * cos + diag[1] * sin;
  let cropH = -diag[0] * sin + diag[1] * cos;
  if (!(cropW > 0 && cropH > 0)) return null;
  if (angle !== 0) {
    const center: Vec = [ul[0] + (cropW * u[0] + cropH * v[0]) / 2, ul[1] + (cropW * u[1] + cropH * v[1]) / 2];
    if (!(center[0] > 0 && center[0] < wf && center[1] > 0 && center[1] < hf)) return null;
    let scale = 1;
    for (const [a, b] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const corner: Vec = [ul[0] + a * cropW * u[0] + b * cropH * v[0], ul[1] + a * cropW * u[1] + b * cropH * v[1]];
      for (const [axis, limit] of [
        [0, wf],
        [1, hf],
      ] as const) {
        const d = corner[axis] - center[axis];
        if (d > 0 && corner[axis] > limit) scale = Math.min(scale, (limit - center[axis]) / d);
        else if (d < 0 && corner[axis] < 0) scale = Math.min(scale, center[axis] / -d);
      }
    }
    if (scale < 1) {
      cropW *= scale;
      cropH *= scale;
      ul = [center[0] - (cropW * u[0] + cropH * v[0]) / 2, center[1] - (cropW * u[1] + cropH * v[1]) / 2];
    }
  }

  // 切り抜きの箱の点 o（枠の画素の単位）: o = [u; v](f - UL) = M s + t
  const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
  const m = { a: dot(u, dx), b: dot(v, dx), c: dot(u, dy), d: dot(v, dy) };
  const offset: Vec = [d0[0] - ul[0], d0[1] - ul[1]];
  const t: Vec = [dot(u, offset), dot(v, offset)];
  // CSS は「平行移動 → 行列」の順（点には右から当たる）。平行移動は M^-1 t = M^T t（回転と鏡映の積なので直交）を img の箱に対する % で
  const pre: Vec = [m.a * t[0] + m.b * t[1], m.c * t[0] + m.d * t[1]];
  const cropAspect = cropW / cropH;
  return {
    box: {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: `${round(100 * Math.max(1, cropAspect / cellAspect))}%`,
      aspectRatio: `${round(cropW)} / ${round(cropH)}`,
      transform: "translate(-50%, -50%)",
      overflow: "hidden",
    },
    image: {
      position: "absolute",
      left: 0,
      top: 0,
      width: `${round((100 * ws) / cropW)}%`,
      height: `${round((100 * hs) / cropH)}%`,
      maxWidth: "none",
      transformOrigin: "0 0",
      transform: `matrix(${round(m.a, 6)}, ${round(m.b, 6)}, ${round(m.c, 6)}, ${round(m.d, 6)}, 0, 0) translate(${round(
        (100 * pre[0]) / ws,
        6,
      )}%, ${round((100 * pre[1]) / hs, 6)}%)`,
    },
  };
}
