/**
 * 段 2 の wasm（`develop-engine-client.ts`）の失敗。`develop-engine-client.ts` が再 export する（ほかのファイルとの循環 import を
 * 避けるため、ここに置く）。
 */

export class DevelopEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopEngineError";
  }
}

/** 面（ブラシ・被写体・空のマスク）の失敗の code（crate の `Error` のメッセージの先頭。`docs/local-adjustments.md`「面の受け渡し」）。 */
export type DevelopMaskSurfaceErrorCode = "maskSurfaceMissing" | "maskSurfaceInvalid" | "maskSurfaceMismatch";

const MASK_SURFACE_ERROR_CODES: readonly DevelopMaskSurfaceErrorCode[] = [
  "maskSurfaceMissing",
  "maskSurfaceInvalid",
  "maskSurfaceMismatch",
];

/**
 * 描かれる面のマスクの面を wasm に渡せない（置き場から読めない・形が違う・寸法が違う）。描画は面を外して描かずにこれで失敗する
 * （黙って外さない）。`maskId` は面を要したマスク（分かるとき）、`surfaceId` は面の id（分かるとき）。
 */
export class DevelopMaskSurfaceError extends DevelopEngineError {
  readonly code: DevelopMaskSurfaceErrorCode;
  readonly maskId: string | null;
  readonly surfaceId: string | null;

  constructor(code: DevelopMaskSurfaceErrorCode, ids: { maskId?: string | null; surfaceId?: string | null }, message?: string) {
    super(message ?? `${code}: ${ids.maskId ? `mask ${ids.maskId}` : "mask"}${ids.surfaceId ? ` surface ${ids.surfaceId}` : ""}`);
    this.name = "DevelopMaskSurfaceError";
    this.code = code;
    this.maskId = ids.maskId ?? null;
    this.surfaceId = ids.surfaceId ?? null;
  }

  /** 同じ失敗を、面を要したマスクの id を添えて作り直す（面を渡す段では、どのマスクの面かが分からない）。 */
  withMask(maskId: string): DevelopMaskSurfaceError {
    return this.maskId === maskId ? this : new DevelopMaskSurfaceError(this.code, { maskId, surfaceId: this.surfaceId }, this.message);
  }
}

/**
 * Worker が返した失敗のメッセージ（crate の `Error` の表示）が面の失敗なら、その失敗にする（ほかは null）。
 * `maskSurfaceMissing: mask <id> needs …`・`maskSurfaceMismatch: mask <id> says its surface <surface> …`・
 * `maskSurfaceInvalid: surface <id>: …` から id を読む。
 */
export function readDevelopMaskSurfaceError(message: string): DevelopMaskSurfaceError | null {
  const code = MASK_SURFACE_ERROR_CODES.find((candidate) => message.startsWith(candidate));
  if (!code) return null;
  const maskId = /\bmask ([A-Za-z0-9_-]{1,64})\b/.exec(message)?.[1] ?? null;
  const surfaceId = /\bsurface ([0-9a-f]{64})\b/.exec(message)?.[1] ?? null;
  return new DevelopMaskSurfaceError(code, { maskId, surfaceId }, message);
}

/** 描画・面の要求の失敗のメッセージを、面の失敗なら {@link DevelopMaskSurfaceError}、ほかは {@link DevelopEngineError} にする。 */
export function developEngineErrorOf(message: string): DevelopEngineError {
  return readDevelopMaskSurfaceError(message) ?? new DevelopEngineError(message);
}
