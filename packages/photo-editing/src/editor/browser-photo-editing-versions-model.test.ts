import { describe, expect, it, vi } from "vitest";

import {
  DEVELOP_SETTINGS_ENGINE,
  NIHO2_DEVELOP_SETTINGS_ENGINE,
  neutralDevelopSettings,
  sameDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import type {
  PhotoLibraryDevelopVersion,
  PhotoLibraryDevelopVersions,
  PhotoLibraryDevelopVersionsSaveResult,
} from "../library/photo-library";

import { rebindDevelopSettings } from "./browser-photo-editing-model";
import {
  addDevelopVersion,
  autoDevelopVersionName,
  createDevelopVersionId,
  createDevelopVersionsWriter,
  defaultDevelopVersionName,
  developVersionOnCurrent,
  developVersionsFull,
  developVersionsNewestFirst,
  developVersionThumbnailFoundation,
  developVersionThumbnailSettings,
  formatDevelopVersionDate,
  newDevelopVersion,
  normalizeDevelopVersionName,
  planDevelopVersionSwitch,
  PHOTO_EDITING_AUTO_VERSIONS_MAX,
  PHOTO_EDITING_NAMED_VERSIONS_MAX,
  readPhotoLibraryDevelopVersions,
  removeDevelopVersion,
  renameDevelopVersion,
  selectedDevelopVersionId,
  DEVELOP_VERSIONS_STALE_RETRY_LIMIT,
} from "./browser-photo-editing-versions-model";

/**
 * 右パネルの「版」（niho-photo#42）の決まりごと: 名前・既定の名前・日時、版を今の土台に載せる、選んでいる版、切り替えと自動の版、
 * 配列の操作、保存係（直列・競合の当て直し・失敗）。
 */

const NOW = new Date("2026-10-21T01:32:00.000Z"); // 日本時間 10:32
const BASE = "raster.v2.abc";

function settings(exposure: number, extra: Record<string, unknown> = {}): DevelopSettings {
  return { ...neutralDevelopSettings(BASE), exposure, ...extra };
}

function version(
  id: string,
  developSettings: DevelopSettings,
  kind: PhotoLibraryDevelopVersion["kind"] = "named",
  name = `名前 ${id}`,
): PhotoLibraryDevelopVersion {
  return { id, name, createdAt: "2026-10-20T00:00:00.000Z", kind, developSettings };
}

function counter(prefix = "id") {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

describe("名前・既定の名前・日時", () => {
  it("名前は前後の空白を除いた 1〜40 文字（空・空白だけ・制御文字・41 文字は失敗）", () => {
    expect(normalizeDevelopVersionName("  明るめ  ")).toEqual({ ok: true, name: "明るめ" });
    expect(normalizeDevelopVersionName("あ".repeat(40))).toEqual({ ok: true, name: "あ".repeat(40) });
    // 絵文字も 1 文字（UTF-16 の長さで数えない）
    expect(normalizeDevelopVersionName("📷".repeat(40))).toMatchObject({ ok: true });
    expect(normalizeDevelopVersionName("")).toEqual({ ok: false, error: "empty" });
    expect(normalizeDevelopVersionName("   ")).toEqual({ ok: false, error: "empty" });
    expect(normalizeDevelopVersionName("版\n1")).toEqual({ ok: false, error: "empty" });
    expect(normalizeDevelopVersionName("あ".repeat(41))).toEqual({ ok: false, error: "tooLong" });
  });

  it("既定の名前は「版 N」（N は名前つきの版の数 + 1 から、重ならない数）", () => {
    expect(defaultDevelopVersionName([])).toBe("版 1");
    const named = [version("a", settings(0.1), "named", "版 1"), version("b", settings(0.2), "named", "明るめ")];
    expect(defaultDevelopVersionName(named)).toBe("版 3");
    // 自動の版は数えない。数が名前と重なれば次の数
    expect(defaultDevelopVersionName([...named, version("c", settings(0.3), "auto", "自動の版 10:32")])).toBe("版 3");
    expect(defaultDevelopVersionName([...named, version("d", settings(0.3), "named", "版 4")])).toBe("版 5");
  });

  it("日時は日本時間の「10月21日 10:32」、自動の版の名前は「自動の版 10:32」", () => {
    expect(formatDevelopVersionDate("2026-10-21T01:32:00.000Z")).toBe("10月21日 10:32");
    expect(formatDevelopVersionDate("2026-01-05T15:05:00.000Z")).toBe("1月6日 0:05");
    expect(formatDevelopVersionDate("not a date")).toBe("");
    expect(autoDevelopVersionName(NOW)).toBe("自動の版 10:32");
  });

  it("版の ID は写真の中で重ならない英数字・- の文字列", () => {
    const ids = new Set(Array.from({ length: 20 }, () => createDevelopVersionId()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
  });
});

describe("置き場の値を読む", () => {
  it("形の違う版・重なった ID は除き、版の無い値は空の配列と 0", () => {
    const good = version("v1", settings(0.5));
    const read = readPhotoLibraryDevelopVersions({
      revision: 4,
      versions: [
        good,
        { ...good, name: "重なった ID" },
        { ...good, id: "v/2" },
        { ...good, id: "v3", name: " 空白つき" },
        { ...good, id: "v4", kind: "snapshot" },
        { ...good, id: "v5", developSettings: { exposure: 1 } },
        { ...good, id: "v6", createdAt: "" },
        "x",
      ],
    });
    expect(read).toEqual({ versions: [good], revision: 4 });
    expect(readPhotoLibraryDevelopVersions(null)).toEqual({ versions: [], revision: 0 });
    expect(readPhotoLibraryDevelopVersions({ versions: {}, revision: -1 })).toEqual({ versions: [], revision: 0 });
  });
});

describe("版を今の土台に載せる・選んでいる版", () => {
  it("土台（数式・ルック・作業コピーの版）は今の補正のもの、値・幾何は版のまま（段階 open の結び直しと同じ）", () => {
    // 仮入力（provisional）の上で作った版を、canonical の土台の上で当てる
    const provisional: DevelopSettings = {
      v: 2,
      engine: DEVELOP_SETTINGS_ENGINE,
      look: "niho-standard-1",
      base: null,
      exposure: 0.7,
      geometry: { rotate: 90 },
      hsl: { red: { hue: 5 } },
    };
    const canonical: DevelopSettings = { ...neutralDevelopSettings("raw-apple.d1.p2.e1"), engine: NIHO2_DEVELOP_SETTINGS_ENGINE };
    const placed = developVersionOnCurrent(provisional, canonical);
    expect(placed).toMatchObject({
      engine: NIHO2_DEVELOP_SETTINGS_ENGINE,
      look: "niho-standard-1",
      base: "raw-apple.d1.p2.e1",
      exposure: 0.7,
      geometry: { rotate: 90 },
      hsl: { red: { hue: 5 } },
    });
    expect(placed).toEqual({ ...rebindDevelopSettings(provisional, canonical), v: placed.v });
    // look の無い今の補正なら、版の look も落とす
    const noLook = { ...canonical };
    delete noLook.look;
    expect(Object.hasOwn(developVersionOnCurrent(provisional, noLook), "look")).toBe(false);
  });

  it("今の補正と同じ版を選ぶ（新しい名前つきの版を先に、無ければ新しい自動の版。どれとも違えば null）", () => {
    const current = settings(0.5);
    const versions = [
      version("old-named", settings(0.5)),
      version("other", settings(0.1)),
      version("auto", settings(0.5), "auto"),
      version("new-named", settings(0.5)),
    ];
    expect(selectedDevelopVersionId(versions, current)).toBe("new-named");
    expect(selectedDevelopVersionId(versions.slice(0, 3).filter((item) => item.kind === "auto"), current)).toBe("auto");
    expect(selectedDevelopVersionId(versions, settings(0.9))).toBeNull();
    // 別の土台で作った版も、今の土台に載せて比べる。0 の項目の有無・キーの順は問わない
    const otherBase = version("other-base", { ...settings(0.3), base: "raster.v1.old", engine: NIHO2_DEVELOP_SETTINGS_ENGINE });
    expect(selectedDevelopVersionId([otherBase], { contrast: 0, ...settings(0.3) })).toBe("other-base");
  });
});

describe("切り替え", () => {
  it("版の補正を今の土台に載せて当て、どの版とも違う今の補正を自動の版として残す", () => {
    const bright = version("bright", settings(0.8));
    const film = version("film", settings(-0.2, { grain: { amount: 20, size: 25, roughness: 50 } }));
    const current = settings(0.33);
    const plan = planDevelopVersionSwitch({
      versions: [bright, film],
      targetId: "film",
      current,
      now: NOW,
      createId: counter("auto"),
    });
    expect(plan?.settings).toEqual(developVersionOnCurrent(film.developSettings, current));
    expect(plan?.keep).toEqual({
      id: "auto-1",
      name: "自動の版 10:32",
      createdAt: NOW.toISOString(),
      kind: "auto",
      developSettings: current,
    });
  });

  it("今の補正がどれかの版と同じ・neutral なら自動の版を残さない。押した版が今の補正と同じ・無い版なら何もしない", () => {
    const bright = version("bright", settings(0.8));
    const film = version("film", settings(-0.2));
    const versions = [bright, film];
    const args = { versions, now: NOW, createId: counter() };
    expect(planDevelopVersionSwitch({ ...args, targetId: "film", current: settings(0.8) })?.keep).toBeNull();
    expect(planDevelopVersionSwitch({ ...args, targetId: "film", current: neutralDevelopSettings(BASE) })?.keep).toBeNull();
    // 切り抜きだけの補正は neutral でない（残す）
    expect(
      planDevelopVersionSwitch({ ...args, targetId: "film", current: settings(0, { geometry: { rotate: 90 } }) })?.keep,
    ).not.toBeNull();
    expect(planDevelopVersionSwitch({ ...args, targetId: "film", current: settings(-0.2) })).toBeNull();
    expect(planDevelopVersionSwitch({ ...args, targetId: "missing", current: settings(0.4) })).toBeNull();
  });
});

describe("配列の操作", () => {
  it("足す・名前を変える・消す（同じ ID は足さない。名前つきは上限まで）", () => {
    const a = version("a", settings(0.1));
    const b = version("b", settings(0.2));
    let versions = addDevelopVersion(a)([]);
    versions = addDevelopVersion(b)(versions);
    versions = addDevelopVersion(a)(versions);
    expect(versions.map((item) => item.id)).toEqual(["a", "b"]);
    versions = renameDevelopVersion("a", "明るめ")(versions);
    expect(versions[0]?.name).toBe("明るめ");
    versions = removeDevelopVersion("b")(versions);
    expect(versions.map((item) => item.id)).toEqual(["a"]);
    expect(developVersionsNewestFirst([a, b]).map((item) => item.id)).toEqual(["b", "a"]);

    const full = Array.from({ length: PHOTO_EDITING_NAMED_VERSIONS_MAX }, (_, index) => version(`n${index}`, settings(index)));
    expect(developVersionsFull(full)).toBe(true);
    expect(addDevelopVersion(version("over", settings(99)))(full)).toHaveLength(PHOTO_EDITING_NAMED_VERSIONS_MAX);
    // 自動の版は名前つきの上限に関わらず足せる
    expect(addDevelopVersion(version("auto", settings(99), "auto"))(full)).toHaveLength(PHOTO_EDITING_NAMED_VERSIONS_MAX + 1);
  });

  it("自動の版は 10 件まで（あふれたら古い順に消す。名前つきは消さない）", () => {
    const named = version("named", settings(0.5));
    const autos = Array.from({ length: PHOTO_EDITING_AUTO_VERSIONS_MAX }, (_, index) =>
      version(`auto-${index}`, settings(index), "auto"),
    );
    const next = addDevelopVersion(version("auto-new", settings(42), "auto"))([autos[0]!, named, ...autos.slice(1)]);
    expect(next.filter((item) => item.kind === "auto")).toHaveLength(PHOTO_EDITING_AUTO_VERSIONS_MAX);
    expect(next.map((item) => item.id)).toEqual(["named", ...autos.slice(1).map((item) => item.id), "auto-new"]);
  });

  it("新しい版は作った日時（ISO 8601）と補正をそのまま持つ", () => {
    const current = settings(0.4);
    expect(newDevelopVersion({ id: "v1", name: "版 1", kind: "named", settings: current, now: NOW })).toEqual({
      id: "v1",
      name: "版 1",
      createdAt: "2026-10-21T01:32:00.000Z",
      kind: "named",
      developSettings: current,
    });
  });
});

describe("版の小さな見た目", () => {
  it("土台は今の補正の数式・ルック・作業コピーの版だけ（スライダーで変わらない）。行の値の補正をその土台に載せる", () => {
    const foundation = developVersionThumbnailFoundation(settings(0.9));
    expect(foundation).toEqual({ v: 1, engine: DEVELOP_SETTINGS_ENGINE, look: "niho-standard-1", base: BASE });
    expect(sameDevelopSettings(foundation, developVersionThumbnailFoundation(settings(-0.4)))).toBe(true);
    const stored = { ...settings(0.6), base: "raster.v1.old" };
    expect(developVersionThumbnailSettings({ key: "v1", xmp: JSON.stringify(stored) }, foundation)).toEqual(
      developVersionOnCurrent(stored, foundation),
    );
    expect(developVersionThumbnailSettings({ key: "v1", xmp: "{" }, foundation)).toBeNull();
    expect(developVersionThumbnailSettings({ key: "v1", xmp: JSON.stringify({ exposure: 1 }) }, foundation)).toBeNull();
    expect(developVersionThumbnailSettings({ key: "v1", xmp: null }, foundation)).toBeNull();
  });
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("保存係（配列まるごとの保存を直列にする）", () => {
  const initial: PhotoLibraryDevelopVersions = { versions: [], revision: 0 };

  it("操作はすぐ画面の版に当て、保存は 1 回ずつ（待つ間の操作は次の 1 回にまとめ、確かめた revision で送る）", async () => {
    const pending: Array<Deferred<PhotoLibraryDevelopVersionsSaveResult>> = [];
    const save = vi.fn((_versions: PhotoLibraryDevelopVersion[], _expected: number) => {
      const next = deferred<PhotoLibraryDevelopVersionsSaveResult>();
      pending.push(next);
      return next.promise;
    });
    const writer = createDevelopVersionsWriter({ initial, save });
    const a = version("a", settings(0.1));
    const b = version("b", settings(0.2));
    writer.apply(addDevelopVersion(a));
    expect(writer.getState()).toMatchObject({ versions: [a], saving: true, failed: false });
    writer.apply(addDevelopVersion(b));
    writer.apply(renameDevelopVersion("a", "明るめ"));
    expect(writer.getState().versions.map((item) => item.name)).toEqual(["明るめ", "名前 b"]);
    // 前の応答を待つ間は送らない
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual([[a], 0]);

    pending[0]!.resolve({ kind: "saved", versions: [a], revision: 1 });
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual([[{ ...a, name: "明るめ" }, b], 1]);
    pending[1]!.resolve({ kind: "saved", versions: [{ ...a, name: "明るめ" }, b], revision: 2 });
    await expect(writer.settled()).resolves.toBe(true);
    expect(writer.getState()).toMatchObject({ saving: false, failed: false });
    expect(writer.hasPendingWork()).toBe(false);
  });

  it("競合（stale）は読み直した配列に、まだ確かめていない操作を当て直して送り直す", async () => {
    const other = version("other-device", settings(0.9));
    const mine = version("mine", settings(0.1));
    const save = vi
      .fn<(versions: PhotoLibraryDevelopVersion[], expected: number) => Promise<PhotoLibraryDevelopVersionsSaveResult>>()
      .mockResolvedValueOnce({ kind: "stale", versions: [other], revision: 5 })
      .mockImplementation(async (versions) => ({ kind: "saved", versions, revision: 6 }));
    const writer = createDevelopVersionsWriter({ initial, save });
    writer.apply(addDevelopVersion(mine));
    await expect(writer.settled()).resolves.toBe(true);
    expect(save.mock.calls[1]).toEqual([[other, mine], 5]);
    expect(writer.getState().versions).toEqual([other, mine]);
  });

  it("失敗は操作と画面の版を残して止まり、「再試行」か次の操作で送り直す。競合が続けば失敗にする", async () => {
    const a = version("a", settings(0.1));
    const save = vi
      .fn<(versions: PhotoLibraryDevelopVersion[], expected: number) => Promise<PhotoLibraryDevelopVersionsSaveResult>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (versions) => ({ kind: "saved", versions, revision: 1 }));
    const writer = createDevelopVersionsWriter({ initial, save });
    const listener = vi.fn();
    writer.subscribe(listener);
    writer.apply(addDevelopVersion(a));
    await expect(writer.settled()).resolves.toBe(false);
    expect(writer.getState()).toEqual({ versions: [a], saving: false, failed: true });
    expect(writer.hasPendingWork()).toBe(true);
    expect(listener).toHaveBeenCalled();
    writer.retry();
    await expect(writer.settled()).resolves.toBe(true);
    expect(save).toHaveBeenLastCalledWith([a], 0);
    expect(writer.getState().failed).toBe(false);

    const staleForever = vi.fn(async () => ({ kind: "stale" as const, versions: [], revision: 9 }));
    const stuck = createDevelopVersionsWriter({ initial, save: staleForever });
    stuck.apply(addDevelopVersion(a));
    await expect(stuck.settled()).resolves.toBe(false);
    expect(staleForever).toHaveBeenCalledTimes(DEVELOP_VERSIONS_STALE_RETRY_LIMIT + 1);
    // 失敗の後の新しい操作も（残っていた操作とまとめて）送り直す
    stuck.apply(removeDevelopVersion("nothing"));
    await expect(stuck.settled()).resolves.toBe(false);
    expect(staleForever).toHaveBeenCalledTimes(2 * (DEVELOP_VERSIONS_STALE_RETRY_LIMIT + 1));
  });
});
