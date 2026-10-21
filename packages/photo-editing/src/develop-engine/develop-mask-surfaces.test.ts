import { describe, expect, it, vi } from "vitest";

import { DevelopMaskSurfaceError } from "./develop-engine-errors";
import {
  DEVELOP_MASK_SURFACE_MISSING_RETRY_MS,
  createDevelopMaskSurfaceSync,
  developMaskPlaneSurfaceNeeds,
  developMaskSurfaceNeeds,
  type DevelopMaskSurfaceNeed,
} from "./develop-mask-surfaces";
import { neutralDevelopSettings } from "./develop-settings";

/**
 * 面を wasm へ渡す係（M4 #68）: 要る面（描かれる面のマスク・重ね表示のマスク）、1 回だけ読んで渡す、上限で古い面を手放す（待っている
 * 要求の面は残す）、読めない面はマスクの id 付きの失敗、開き直したら覚えた PNG から渡し直す、読めなかった面はしばらく読み直さない。
 */

function id(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function need(maskId: string, n: number): DevelopMaskSurfaceNeed {
  return { maskId, surface: { id: id(n), width: 4, height: 3 } };
}

function harness(options: { heldMax?: number; missing?: number[] } = {}) {
  const sets: string[] = [];
  const drops: string[] = [];
  let clock = 0;
  const missing = new Set((options.missing ?? []).map(id));
  const source = vi.fn(async (surfaceId: string) => (missing.has(surfaceId) ? null : new Uint8Array([1, 2, surfaceId.length])));
  const sync = createDevelopMaskSurfaceSync({
    set: async (surfaceId) => {
      sets.push(surfaceId);
    },
    drop: (surfaceId) => drops.push(surfaceId),
    source: () => source,
    now: () => clock,
    heldMax: options.heldMax,
  });
  return {
    sync,
    sets,
    drops,
    source,
    missing,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const SURFACE = { id: id(7), width: 4, height: 3 };

describe("developMaskSurfaceNeeds", () => {
  it("描かれる面のマスクだけ（無効・補正なし・線形は要らない）。重ね表示はそのマスクの面（有効かに依らず）", () => {
    const settings = {
      ...neutralDevelopSettings(),
      v: 5,
      masks: [
        { id: "a", kind: "brush", surface: SURFACE, adjust: { exposure: 1 } },
        { id: "b", kind: "subject", enabled: false, surface: { ...SURFACE, id: id(8) }, adjust: { exposure: 1 } },
        { id: "c", kind: "sky", surface: { ...SURFACE, id: id(9) }, adjust: {} },
        { id: "d", kind: "linear", zero: { x: 0.5, y: 0.5 }, full: { x: 0.5, y: 0.2 }, adjust: { exposure: 1 } },
      ],
    };
    expect(developMaskSurfaceNeeds(settings)).toEqual([{ maskId: "a", surface: SURFACE }]);
    expect(developMaskPlaneSurfaceNeeds(settings, "b")).toEqual([{ maskId: "b", surface: { ...SURFACE, id: id(8) } }]);
    expect(developMaskPlaneSurfaceNeeds(settings, "c")).toHaveLength(1);
    expect(developMaskPlaneSurfaceNeeds(settings, "d")).toEqual([]);
    expect(developMaskPlaneSurfaceNeeds(settings, "zzz")).toEqual([]);
  });
});

describe("createDevelopMaskSurfaceSync", () => {
  it("持っていない面だけ 1 回読んで渡す（同じ面を同時に読まない）", async () => {
    const { sync, sets, source } = harness();
    await Promise.all([sync.ensure([need("a", 1)], () => new Set()), sync.ensure([need("b", 1)], () => new Set())]);
    expect(sets).toEqual([id(1)]);
    expect(source).toHaveBeenCalledOnce();
    expect(sync.unheld([need("a", 1)])).toEqual([]);
    await sync.ensure([need("a", 1), need("c", 2)], () => new Set());
    expect(sets).toEqual([id(1), id(2)]);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("上限を超えたら、使ったのが古い面から手放す（今の要求・待っている要求の面は残す）", async () => {
    const { sync, drops } = harness({ heldMax: 2 });
    await sync.ensure([need("a", 1)], () => new Set());
    await sync.ensure([need("a", 2)], () => new Set());
    // 1 を使い直す → 2 が一番古い。ただし 2 は待っている要求が要る
    sync.touch([need("a", 1)]);
    await sync.ensure([need("a", 3)], () => new Set([id(2)]));
    expect(drops).toEqual([id(1)]);
    expect(sync.heldIds().sort()).toEqual([id(2), id(3)].sort());
  });

  it("読めない面は maskSurfaceMissing（マスクの id と面の id 付き）。しばらくは読み直さず、forgetMissing で読み直す", async () => {
    const { sync, source, missing, advance } = harness({ missing: [5] });
    const failure = await sync.ensure([need("ok", 1), need("brush-1", 5)], () => new Set()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DevelopMaskSurfaceError);
    expect(failure).toMatchObject({ code: "maskSurfaceMissing", maskId: "brush-1", surfaceId: id(5) });
    const calls = source.mock.calls.length;
    await expect(sync.ensure([need("brush-1", 5)], () => new Set())).rejects.toBeInstanceOf(DevelopMaskSurfaceError);
    expect(source.mock.calls.length).toBe(calls);
    advance(DEVELOP_MASK_SURFACE_MISSING_RETRY_MS);
    missing.clear();
    await sync.ensure([need("brush-1", 5)], () => new Set());
    expect(sync.heldIds()).toContain(id(5));

    const again = harness({ missing: [6] });
    await expect(again.sync.ensure([need("m", 6)], () => new Set())).rejects.toBeInstanceOf(DevelopMaskSurfaceError);
    again.missing.clear();
    again.sync.forgetMissing();
    await again.sync.ensure([need("m", 6)], () => new Set());
    expect(again.sync.heldIds()).toEqual([id(6)]);

    // 写真を開き直したら（別の写真の置き場かもしれない）読めなかった面も読み直す
    const reopened = harness({ missing: [7] });
    await expect(reopened.sync.ensure([need("m", 7)], () => new Set())).rejects.toBeInstanceOf(DevelopMaskSurfaceError);
    reopened.missing.clear();
    reopened.sync.reset();
    await reopened.sync.ensure([need("m", 7)], () => new Set());
    expect(reopened.sync.heldIds()).toEqual([id(7)]);
  });

  it("形の違う面（wasm が断った）はマスクの id を添えた失敗", async () => {
    const sync = createDevelopMaskSurfaceSync({
      set: async (surfaceId) => {
        throw new DevelopMaskSurfaceError("maskSurfaceInvalid", { surfaceId });
      },
      drop: () => undefined,
      source: () => async () => new Uint8Array([1]),
    });
    await expect(sync.ensure([need("brush-2", 3)], () => new Set())).rejects.toMatchObject({
      code: "maskSurfaceInvalid",
      maskId: "brush-2",
      surfaceId: id(3),
    });
    expect(sync.heldIds()).toEqual([]);
  });

  it("開き直したら持っていない扱い。覚えた PNG から渡し直し、読み口は読まない。前の Developer へ渡し終えた面は持っている扱いにしない", async () => {
    const { sync, sets, source } = harness();
    await sync.ensure([need("a", 1)], () => new Set());
    sync.reset();
    expect(sync.unheld([need("a", 1)])).toHaveLength(1);
    await sync.ensure([need("a", 1)], () => new Set());
    expect(sets).toEqual([id(1), id(1)]);
    expect(source).toHaveBeenCalledOnce();

    // 渡している途中に開き直した: 渡し終えても持っている扱いにしない
    let release: () => void = () => undefined;
    const pending = createDevelopMaskSurfaceSync({
      set: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      drop: () => undefined,
      source: () => async () => new Uint8Array([1]),
    });
    const running = pending.ensure([need("a", 9)], () => new Set());
    await Promise.resolve();
    await Promise.resolve();
    pending.reset();
    release();
    await running;
    expect(pending.heldIds()).toEqual([]);
  });

  it("呼び出し側が直接渡した面・作った面の PNG を覚える（読み口を読まずに渡せる）", async () => {
    const { sync, source } = harness();
    sync.remember(id(4), new Uint8Array([9, 9]));
    await expect(sync.png(id(4))).resolves.toEqual(new Uint8Array([9, 9]));
    sync.markHeld(id(4), new Uint8Array([9, 9]), sync.generation());
    expect(sync.unheld([need("a", 4)])).toEqual([]);
    sync.markDropped(id(4));
    expect(sync.unheld([need("a", 4)])).toHaveLength(1);
    expect(source).not.toHaveBeenCalled();
    // 書き出し用に別の写真の読み口を渡せる
    const other = vi.fn(async () => new Uint8Array([5]));
    await expect(sync.png(id(8), other)).resolves.toEqual(new Uint8Array([5]));
    expect(other).toHaveBeenCalledWith(id(8));
  });
});
