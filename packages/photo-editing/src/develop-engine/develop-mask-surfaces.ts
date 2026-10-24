import { DevelopMaskSurfaceError } from "./develop-engine-errors";
import { isActiveDevelopMask, readDevelopMasks, type DevelopMaskSurface } from "./develop-masks";

/**
 * 面（ブラシ・被写体・空のマスク。`docs/local-adjustments.md`「面の受け渡し」）を、開いている写真の wasm（`Developer`）へ渡す係
 * （`develop-engine-client.ts` が使う。React に依らない）。
 *
 * - 面は PNG の中身の sha256（`surface.id`）で呼ぶ不変のファイル。同じ id の中身はどの写真でも同じなので、読んだ PNG は id で覚える
 *   （{@link DEVELOP_MASK_SURFACE_BYTES_CACHE_MAX} 件・{@link DEVELOP_MASK_SURFACE_BYTES_CACHE_MAX_BYTES} まで。写真を開き直した
 *   `Developer` へ置き場を読み直さずに渡し直す）
 * - 描く前に、要る面（描かれる面のマスク。重ね表示はそのマスク）のうち wasm がまだ持っていない面を、覚えた PNG か読み口（写真の
 *   出どころの `loadMaskSurface`）から読んで 1 回だけ渡す。同じ面を同時に読まない
 * - wasm が持つ面は {@link DEVELOP_MASK_SURFACES_HELD_MAX} 枚まで。超えたら、使ったのが古い面のうち今の要求・待っている要求が
 *   要らないものを手放す
 * - 読めない面は {@link DevelopMaskSurfaceError}（`maskSurfaceMissing`。マスクの id 付き）で失敗する（黙って外して描かない）。
 *   読めなかった面は {@link DEVELOP_MASK_SURFACE_MISSING_RETRY_MS} の間は読み直さない（ドラッグのたびに置き場を読まない。
 *   `forgetMissing` で読み直す）
 * - 写真を開き直す・閉じる（新しい `Developer` は面を持たない）と `reset`。前の写真へ渡していた途中の面は持っている扱いにしない
 */

/** 面の PNG の読み口（無い・読めないときは null）。 */
export type DevelopMaskSurfaceSource = (surfaceId: string) => Promise<Uint8Array | null>;

/** 描画に要る 1 枚の面（どのマスクの、どの面か）。 */
export type DevelopMaskSurfaceNeed = { maskId: string; surface: DevelopMaskSurface };

/** wasm の `Developer` に持たせる面の枚数の上限（写真 1 枚のマスクは 8 枚まで。取り消しで行き来する分を少し持つ）。 */
export const DEVELOP_MASK_SURFACES_HELD_MAX = 16;
/** 覚える PNG の件数と大きさの上限（ふつうのブラシの面は数十 KB）。 */
export const DEVELOP_MASK_SURFACE_BYTES_CACHE_MAX = 24;
export const DEVELOP_MASK_SURFACE_BYTES_CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** 読めなかった面を読み直すまでの間（ms）。 */
export const DEVELOP_MASK_SURFACE_MISSING_RETRY_MS = 2_000;

/** 描画に要る面（描かれる＝有効で `adjust` が何か動かす面のマスク。crate の描画が描く前に確かめるもの）。 */
export function developMaskSurfaceNeeds(settings: unknown): DevelopMaskSurfaceNeed[] {
  const needs: DevelopMaskSurfaceNeed[] = [];
  for (const mask of readDevelopMasks(settings)) {
    if (mask.kind === "linear" || mask.kind === "radial" || !isActiveDevelopMask(mask)) continue;
    needs.push({ maskId: mask.id, surface: mask.surface });
  }
  return needs;
}

/** 1 枚のマスクの重ね表示（`maskPlane`）に要る面（面のマスクなら、有効かに依らずその面）。 */
export function developMaskPlaneSurfaceNeeds(settings: unknown, maskId: string): DevelopMaskSurfaceNeed[] {
  const mask = readDevelopMasks(settings).find((candidate) => candidate.id === maskId);
  if (!mask || mask.kind === "linear" || mask.kind === "radial") return [];
  return [{ maskId: mask.id, surface: mask.surface }];
}

export type DevelopMaskSurfaceSync = ReturnType<typeof createDevelopMaskSurfaceSync>;

export function createDevelopMaskSurfaceSync(deps: {
  /** wasm へ面を渡す（Worker が受け取ったら resolve。形の違う面は `maskSurfaceInvalid` で reject） */
  set: (surfaceId: string, png: Uint8Array) => Promise<void>;
  /** wasm から面を手放す（待たない） */
  drop: (surfaceId: string) => void;
  /** 開いている写真の面の読み口（無ければ null） */
  source: () => DevelopMaskSurfaceSource | null;
  now?: () => number;
  heldMax?: number;
}) {
  const now = deps.now ?? (() => Date.now());
  const heldMax = deps.heldMax ?? DEVELOP_MASK_SURFACES_HELD_MAX;
  /** wasm が持っている面（id → 最後に使った順） */
  const held = new Map<string, number>();
  /** 覚えた PNG（使った順。後ろほど新しい） */
  const bytes = new Map<string, Uint8Array>();
  let cachedBytes = 0;
  /** 読めなかった面（id → 読めなかった時刻） */
  const missing = new Map<string, number>();
  /** 読んでいる・渡している途中の面 */
  const loading = new Map<string, Promise<void>>();
  let tick = 0;
  /** `Developer` の世代（開き直しで変わる） */
  let generation = 0;

  const remember = (surfaceId: string, png: Uint8Array) => {
    const previous = bytes.get(surfaceId);
    if (previous) {
      bytes.delete(surfaceId);
      cachedBytes -= previous.byteLength;
    }
    if (png.byteLength > DEVELOP_MASK_SURFACE_BYTES_CACHE_MAX_BYTES) return;
    bytes.set(surfaceId, png);
    cachedBytes += png.byteLength;
    missing.delete(surfaceId);
    while (bytes.size > DEVELOP_MASK_SURFACE_BYTES_CACHE_MAX || cachedBytes > DEVELOP_MASK_SURFACE_BYTES_CACHE_MAX_BYTES) {
      const oldest = bytes.keys().next().value;
      if (oldest === undefined) break;
      cachedBytes -= bytes.get(oldest)?.byteLength ?? 0;
      bytes.delete(oldest);
    }
  };

  const recall = (surfaceId: string): Uint8Array | null => {
    const png = bytes.get(surfaceId);
    if (!png) return null;
    // 使った順に並べ直す
    bytes.delete(surfaceId);
    bytes.set(surfaceId, png);
    return png;
  };

  /** 覚えた PNG か読み口から面の PNG を読む（読めなければ null）。 */
  const readPng = async (surfaceId: string, source: DevelopMaskSurfaceSource | null): Promise<Uint8Array | null> => {
    const known = recall(surfaceId);
    if (known) return known;
    const failedAt = missing.get(surfaceId);
    if (failedAt !== undefined && now() - failedAt < DEVELOP_MASK_SURFACE_MISSING_RETRY_MS) return null;
    let png: Uint8Array | null = null;
    try {
      png = source ? await source(surfaceId) : null;
    } catch {
      png = null;
    }
    if (!png || png.byteLength === 0) {
      missing.set(surfaceId, now());
      return null;
    }
    remember(surfaceId, png);
    return png;
  };

  const touch = (surfaceIds: Iterable<string>) => {
    for (const surfaceId of surfaceIds) if (held.has(surfaceId)) held.set(surfaceId, ++tick);
  };

  /** 持つ枚数を上限に収める（`pinned` は手放さない）。 */
  const trim = (pinned: ReadonlySet<string>) => {
    if (held.size <= heldMax) return;
    const candidates = [...held.entries()].filter(([surfaceId]) => !pinned.has(surfaceId)).sort((a, b) => a[1] - b[1]);
    for (const [surfaceId] of candidates) {
      if (held.size <= heldMax) break;
      held.delete(surfaceId);
      deps.drop(surfaceId);
    }
  };

  const loadOne = (need: DevelopMaskSurfaceNeed): Promise<void> => {
    const surfaceId = need.surface.id;
    const running = loading.get(surfaceId);
    if (running) return running;
    const started = generation;
    const task = (async () => {
      const png = await readPng(surfaceId, deps.source());
      if (!png) throw new DevelopMaskSurfaceError("maskSurfaceMissing", { maskId: need.maskId, surfaceId });
      // 開き直した後の面は、新しい Developer へ渡し直す（前の写真の要求はもう捨てられている）
      if (started !== generation) return;
      await deps.set(surfaceId, png);
      if (started === generation) held.set(surfaceId, ++tick);
    })().finally(() => {
      if (loading.get(surfaceId) === task) loading.delete(surfaceId);
    });
    loading.set(surfaceId, task);
    return task;
  };

  return {
    /** wasm がまだ持っていない面。 */
    unheld(needs: readonly DevelopMaskSurfaceNeed[]): DevelopMaskSurfaceNeed[] {
      return needs.filter((need) => !held.has(need.surface.id));
    },
    /** 持っている面を使った順の後ろへ回す。 */
    touch(needs: readonly DevelopMaskSurfaceNeed[]) {
      touch(needs.map((need) => need.surface.id));
    },
    /**
     * 要る面をすべて wasm に持たせる（持っていない面だけ読んで渡す）。読めない・形の違う面は {@link DevelopMaskSurfaceError}
     * （マスクの id 付き）で reject。渡し終えたら、`pinned()`（待っている要求が要る面）と今の面を残して上限に収める。
     */
    async ensure(needs: readonly DevelopMaskSurfaceNeed[], pinned: () => ReadonlySet<string>): Promise<void> {
      const pending = needs.filter((need) => !held.has(need.surface.id));
      const results = await Promise.allSettled(pending.map((need) => loadOne(need)));
      const index = results.findIndex((result) => result.status === "rejected");
      if (index >= 0) {
        const reason: unknown = (results[index] as PromiseRejectedResult).reason;
        const need = pending[index]!;
        throw reason instanceof DevelopMaskSurfaceError ? reason.withMask(need.maskId) : reason;
      }
      touch(needs.map((need) => need.surface.id));
      const keep = new Set(pinned());
      for (const need of needs) keep.add(need.surface.id);
      trim(keep);
    },
    /** 呼び出し側が直接 wasm へ渡した面（`setMaskSurface`）を覚える。 */
    markHeld(surfaceId: string, png: Uint8Array, setGeneration: number) {
      remember(surfaceId, png);
      if (setGeneration === generation) held.set(surfaceId, ++tick);
    },
    /** 直接手放した面。 */
    markDropped(surfaceId: string) {
      held.delete(surfaceId);
    },
    /** 作った面の PNG（`encodeMaskSurface`）を覚える（後で読み口を読まずに渡せる）。 */
    remember,
    /** 面の PNG（覚えた PNG か、`source` か開いている写真の読み口から。読めなければ null）。 */
    png(surfaceId: string, source?: DevelopMaskSurfaceSource | null): Promise<Uint8Array | null> {
      return readPng(surfaceId, source === undefined ? deps.source() : source);
    },
    /** 読めなかった面を忘れる（次の描画で読み直す）。 */
    forgetMissing() {
      missing.clear();
    },
    /** 今の `Developer` の世代（直接渡すときに控える）。 */
    generation(): number {
      return generation;
    },
    /** 新しい `Developer`（面を持たない）になった。写真が替わったので、読めなかった面も読み直す。 */
    reset() {
      generation += 1;
      held.clear();
      loading.clear();
      missing.clear();
    },
    /** wasm が持っている面の id（テスト用）。 */
    heldIds(): string[] {
      return [...held.keys()];
    },
  };
}
