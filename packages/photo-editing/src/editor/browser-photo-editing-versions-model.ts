import {
  developSettingsVersion,
  isNeutralDevelopSettings,
  readDevelopSettings,
  sameDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import type {
  PhotoLibraryDevelopVersion,
  PhotoLibraryDevelopVersionKind,
  PhotoLibraryDevelopVersions,
  PhotoLibraryDevelopVersionsSaveResult,
} from "../library/photo-library";
import { photoEditingAutoVersionName, photoEditingVersionDefaultName } from "../photo-editing-copy";

import { rebindDevelopSettings } from "./browser-photo-editing-model";

/**
 * 右パネルの「版」（niho-photo#42。Lightroom の「バージョン」）の決まりごと。画面（`useBrowserPhotoVersions`）はここを通して版を
 * 作る・切り替える・選んでいる版を決める・保存する。
 *
 * - 版は写真の補正（`developSettings`）を名前と日時つきでまるごと残したもの。名前つき（`named`）は「今の補正を版にする」で作り、
 *   自動（`auto`）は版を切り替える直前の補正がどの版とも違うときだけ残す（{@link PHOTO_EDITING_AUTO_VERSIONS_MAX} 件まで。あふれたら
 *   古い順に消す）
 * - 版を当てる・比べるときは、版の補正を「その写真の今の土台」に載せる（{@link developVersionOnCurrent}）。土台（数式 `engine`・
 *   ルック `look`・作業コピーの版 `base`）は今の補正のものにし、値・幾何・知らない項目は版のまま。段階 open の canonical 差し替え
 *   （`rebindDevelopSettings`）と同じ決まりなので、仮入力の上で作った版も canonical の上で壊れず描ける
 * - 選んでいる版は、今の補正と同じ版（新しい名前つきの版を先に、無ければ新しい自動の版）。どれとも違えば無い（一覧の先頭に
 *   「いまの補正」を出す）
 * - 保存は配列まるごと（{@link createDevelopVersionsWriter}）。書き込みは 1 つずつ順に送り、競合（`stale`）のときは読み直した配列に
 *   まだ確かめていない操作を当て直して送り直す
 */

/** 版の名前の上限（前後の空白を除いた文字数。この Mac の置き場と同じ）。 */
export const PHOTO_EDITING_VERSION_NAME_MAX_CHARS = 40;
/** 名前つきの版の上限。 */
export const PHOTO_EDITING_NAMED_VERSIONS_MAX = 30;
/** 自動の版の上限（あふれたら古い順に消す）。 */
export const PHOTO_EDITING_AUTO_VERSIONS_MAX = 10;
/** 競合で読み直して送り直す回数の上限（超えたら保存の失敗にする）。 */
export const DEVELOP_VERSIONS_STALE_RETRY_LIMIT = 3;

const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const VERSION_CREATED_AT_MAX_CHARS = 64;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 版の名前の失敗（空・長すぎる）。 */
export type DevelopVersionNameError = "empty" | "tooLong";

/** 入力した名前を版の名前に整える（前後の空白を除く）。空・制御文字だけ・長すぎる名前は失敗。 */
export function normalizeDevelopVersionName(
  input: string,
): { ok: true; name: string } | { ok: false; error: DevelopVersionNameError } {
  const name = input.trim();
  if (name.length === 0 || CONTROL_CHARACTER_PATTERN.test(name)) return { ok: false, error: "empty" };
  if (Array.from(name).length > PHOTO_EDITING_VERSION_NAME_MAX_CHARS) return { ok: false, error: "tooLong" };
  return { ok: true, name };
}

function isVersionName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = normalizeDevelopVersionName(value);
  return normalized.ok && normalized.name === value;
}

function readDevelopVersion(value: unknown): PhotoLibraryDevelopVersion | null {
  if (!isRecord(value)) return null;
  const { id, name, createdAt, kind } = value;
  if (typeof id !== "string" || !VERSION_ID_PATTERN.test(id) || !isVersionName(name)) return null;
  if (typeof createdAt !== "string" || createdAt.length === 0 || createdAt.length > VERSION_CREATED_AT_MAX_CHARS) return null;
  if (kind !== "named" && kind !== "auto") return null;
  const developSettings = readDevelopSettings(value.developSettings);
  return developSettings ? { id, name, createdAt, kind, developSettings } : null;
}

/**
 * 置き場が返した版を読む（形の違う版・重なった ID の版は除く。版の無い・読めない値は空の配列と 0）。この Mac の置き場が native の
 * 答えを読むのにも使う。
 */
export function readPhotoLibraryDevelopVersions(value: unknown): PhotoLibraryDevelopVersions {
  const record = isRecord(value) ? value : {};
  const revision =
    typeof record.revision === "number" && Number.isSafeInteger(record.revision) && record.revision >= 0 ? record.revision : 0;
  const versions: PhotoLibraryDevelopVersion[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(record.versions) ? record.versions : []) {
    const version = readDevelopVersion(item);
    if (!version || ids.has(version.id)) continue;
    ids.add(version.id);
    versions.push(version);
  }
  return { versions, revision };
}

/** 写真の中で重ならない版の ID（不透明なランダムの文字列）。 */
export function createDevelopVersionId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function countDevelopVersions(
  versions: readonly PhotoLibraryDevelopVersion[],
  kind: PhotoLibraryDevelopVersionKind,
): number {
  return versions.filter((version) => version.kind === kind).length;
}

/** 名前つきの版をもう作れないか（{@link PHOTO_EDITING_NAMED_VERSIONS_MAX}）。 */
export function developVersionsFull(versions: readonly PhotoLibraryDevelopVersion[]): boolean {
  return countDevelopVersions(versions, "named") >= PHOTO_EDITING_NAMED_VERSIONS_MAX;
}

/** 「今の補正を版にする」の既定の名前（「版 N」。N は名前つきの版の数 + 1 から、ほかの版と重ならない数）。 */
export function defaultDevelopVersionName(versions: readonly PhotoLibraryDevelopVersion[]): string {
  const taken = new Set(versions.map((version) => version.name));
  let order = countDevelopVersions(versions, "named") + 1;
  while (taken.has(photoEditingVersionDefaultName(order))) order += 1;
  return photoEditingVersionDefaultName(order);
}

/** 日本時間の月・日・時・分（情報の面の撮影日時と同じく、日本時間で出す）。 */
const TOKYO_PARTS_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

function tokyoParts(date: Date): { month: string; day: string; time: string } {
  const parts = TOKYO_PARTS_FORMAT.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return { month: part("month"), day: part("day"), time: `${Number(part("hour"))}:${part("minute").padStart(2, "0")}` };
}

/** 一覧の版の日時（「10月21日 10:32」。読めない日時は空）。 */
export function formatDevelopVersionDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const { month, day, time } = tokyoParts(date);
  return `${month}月${day}日 ${time}`;
}

/** 自動の版の名前（「自動の版 10:32」）。 */
export function autoDevelopVersionName(now: Date): string {
  return photoEditingAutoVersionName(tokyoParts(now).time);
}

/** 版を 1 つ作る（補正はそのまま残す。当てるときに今の土台に載せる）。 */
export function newDevelopVersion(input: {
  id: string;
  name: string;
  kind: PhotoLibraryDevelopVersionKind;
  settings: DevelopSettings;
  now: Date;
}): PhotoLibraryDevelopVersion {
  return {
    id: input.id,
    name: input.name,
    createdAt: input.now.toISOString(),
    kind: input.kind,
    developSettings: input.settings,
  };
}

/** 形の版 `v` を中身から決め直した補正（比べる・当てる前にそろえる）。 */
function versioned(settings: DevelopSettings): DevelopSettings {
  return { ...settings, v: developSettingsVersion(settings) };
}

/**
 * 版の補正を、その写真の今の土台に載せる（数式・ルック・作業コピーの版は今の補正のもの、値・幾何・知らない項目は版のまま。
 * `rebindDevelopSettings` と同じ決まり。形の版 `v` は中身から決め直す）。
 */
export function developVersionOnCurrent(settings: DevelopSettings, current: DevelopSettings): DevelopSettings {
  return versioned(rebindDevelopSettings(settings, current));
}

function sameAsCurrent(version: PhotoLibraryDevelopVersion, current: DevelopSettings): boolean {
  return sameDevelopSettings(developVersionOnCurrent(version.developSettings, current), versioned(current));
}

/**
 * 今の補正と同じ版（選んでいる版）の ID。同じ版がいくつもあれば新しい名前つきの版、名前つきが無ければ新しい自動の版。どれとも
 * 違えば null。
 */
export function selectedDevelopVersionId(
  versions: readonly PhotoLibraryDevelopVersion[],
  current: DevelopSettings,
): string | null {
  let auto: string | null = null;
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const version = versions[index]!;
    if (!sameAsCurrent(version, current)) continue;
    if (version.kind === "named") return version.id;
    auto ??= version.id;
  }
  return auto;
}

/** 版を切り替える内容（当てる補正と、切り替える前の補正を残す自動の版。残さなくてよければ null）。 */
export type DevelopVersionSwitch = { settings: DevelopSettings; keep: PhotoLibraryDevelopVersion | null };

/**
 * 版を押したときの切り替え。版の補正を今の土台に載せて当てる。今の補正がどの版とも違い、何か当てている（neutral でない）ときだけ、
 * 切り替える前の補正を自動の版として残す。押した版が今の補正と同じ（何も変わらない）・無い版なら null（何もしない）。
 */
export function planDevelopVersionSwitch(input: {
  versions: readonly PhotoLibraryDevelopVersion[];
  targetId: string;
  current: DevelopSettings;
  now: Date;
  createId: () => string;
}): DevelopVersionSwitch | null {
  const target = input.versions.find((version) => version.id === input.targetId);
  if (!target) return null;
  const settings = developVersionOnCurrent(target.developSettings, input.current);
  if (sameDevelopSettings(settings, versioned(input.current))) return null;
  const keep =
    isNeutralDevelopSettings(input.current) || input.versions.some((version) => sameAsCurrent(version, input.current))
      ? null
      : newDevelopVersion({
          id: input.createId(),
          name: autoDevelopVersionName(input.now),
          kind: "auto",
          settings: input.current,
          now: input.now,
        });
  return { settings, keep };
}

/** 版の行の小さな見た目の長辺（幅 56px の行の 2 倍）。 */
export const BROWSER_VERSION_THUMBNAIL_MAX_DIMENSION = 112;

/**
 * 版の見本の土台（今の補正の数式・ルック・作業コピーの版だけ）。スライダーを動かしても変わらないので、見本は土台が変わったとき
 * （段階 open の canonical 差し替えなど）だけ描き直す。
 */
export function developVersionThumbnailFoundation(current: DevelopSettings): DevelopSettings {
  const foundation: DevelopSettings = { v: 1, engine: current.engine };
  if (Object.hasOwn(current, "look")) foundation.look = current.look;
  if (Object.hasOwn(current, "base")) foundation.base = current.base;
  return foundation;
}

/** 見本の行の値（版の補正の JSON）を、土台に載せた補正にする（読めなければ null。見本は描けない印になる）。 */
export function developVersionThumbnailSettings(
  row: { key: string; xmp: string | null },
  foundation: DevelopSettings,
): DevelopSettings | null {
  if (row.xmp === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.xmp);
  } catch {
    return null;
  }
  const settings = readDevelopSettings(parsed);
  return settings ? developVersionOnCurrent(settings, foundation) : null;
}

/** 版の配列への 1 つの操作（保存の競合で読み直した配列にも当て直す）。 */
export type DevelopVersionsOperation = (versions: readonly PhotoLibraryDevelopVersion[]) => PhotoLibraryDevelopVersion[];

/** 自動の版があふれた分を古い順（配列の前）から消す。 */
function trimAutoVersions(versions: PhotoLibraryDevelopVersion[]): PhotoLibraryDevelopVersion[] {
  let over = countDevelopVersions(versions, "auto") - PHOTO_EDITING_AUTO_VERSIONS_MAX;
  if (over <= 0) return versions;
  return versions.filter((version) => {
    if (version.kind !== "auto" || over <= 0) return true;
    over -= 1;
    return false;
  });
}

/** 版を足す（同じ ID がもうある・名前つきの版が上限なら足さない。自動の版はあふれた古い分を消す）。 */
export function addDevelopVersion(version: PhotoLibraryDevelopVersion): DevelopVersionsOperation {
  return (versions) => {
    if (versions.some((item) => item.id === version.id)) return [...versions];
    if (version.kind === "named" && developVersionsFull(versions)) return [...versions];
    return trimAutoVersions([...versions, version]);
  };
}

export function renameDevelopVersion(id: string, name: string): DevelopVersionsOperation {
  return (versions) => versions.map((version) => (version.id === id ? { ...version, name } : version));
}

export function removeDevelopVersion(id: string): DevelopVersionsOperation {
  return (versions) => versions.filter((version) => version.id !== id);
}

/** 一覧の並び（新しい順。作った順の配列の後ろが新しい）。 */
export function developVersionsNewestFirst(
  versions: readonly PhotoLibraryDevelopVersion[],
): PhotoLibraryDevelopVersion[] {
  return [...versions].reverse();
}

export type DevelopVersionsWriterState = {
  /** 画面に出す版（確かめた配列に、まだ確かめていない操作を当てたもの） */
  versions: readonly PhotoLibraryDevelopVersion[];
  /** 送っている・送る操作が残っている */
  saving: boolean;
  /** 保存できなかった（{@link DevelopVersionsWriter.retry}・次の操作で送り直す。画面の版はそのまま） */
  failed: boolean;
};

export type DevelopVersionsWriter = {
  /** 操作を足す（すぐ画面の版に当て、順に保存する） */
  apply: (operation: DevelopVersionsOperation) => void;
  /** 保存できなかった操作を送り直す */
  retry: () => void;
  getState: () => DevelopVersionsWriterState;
  subscribe: (listener: () => void) => () => void;
  /** 送る操作が無くなる（true）か、失敗で止まる（false）まで待つ */
  settled: () => Promise<boolean>;
  /** 送っていない・送っている途中の操作がある */
  hasPendingWork: () => boolean;
};

/**
 * 写真 1 枚の版の保存係（配列まるごとの保存を直列にする）。
 *
 * - 操作は来た順に画面の版へすぐ当て、保存は 1 回ずつ（前の応答を待ってから次）。待つ間に来た操作はまとめて次の 1 回で送る
 * - 送るのは「確かめた配列（読んだ・保存できた配列）にまだ確かめていない操作を全部当てたもの」と、確かめた配列の `revision`
 * - `stale`（別の操作・端末が先に保存した）は、返った今の配列を確かめた配列にして、まだ確かめていない操作を当て直して送り直す
 *   （{@link DEVELOP_VERSIONS_STALE_RETRY_LIMIT} 回まで。超えたら失敗）
 * - 失敗（投げた）は操作を残して止まり、`retry`・次の操作で送り直す（画面の版は壊さない）
 */
export function createDevelopVersionsWriter(options: {
  initial: PhotoLibraryDevelopVersions;
  save: (
    versions: PhotoLibraryDevelopVersion[],
    expectedRevision: number,
  ) => Promise<PhotoLibraryDevelopVersionsSaveResult>;
}): DevelopVersionsWriter {
  let confirmed: PhotoLibraryDevelopVersions = {
    versions: [...options.initial.versions],
    revision: options.initial.revision,
  };
  let operations: DevelopVersionsOperation[] = [];
  /** 送っている操作の数（送っていなければ null） */
  let sending: number | null = null;
  let failed = false;
  let staleRetries = 0;
  const listeners = new Set<() => void>();
  let waiters: Array<(ok: boolean) => void> = [];

  const project = () =>
    operations.reduce<PhotoLibraryDevelopVersion[]>((versions, operation) => operation(versions), [...confirmed.versions]);
  let state: DevelopVersionsWriterState = { versions: project(), saving: false, failed: false };
  const idle = () => sending === null && (operations.length === 0 || failed);

  const publish = () => {
    state = { versions: project(), saving: sending !== null || (operations.length > 0 && !failed), failed };
    for (const listener of listeners) listener();
    if (!idle() || waiters.length === 0) return;
    const ok = !failed && operations.length === 0;
    const settledWaiters = waiters;
    waiters = [];
    for (const resolve of settledWaiters) resolve(ok);
  };

  const pump = (): void => {
    if (sending !== null || failed || operations.length === 0) {
      publish();
      return;
    }
    const count = operations.length;
    const body = project();
    const expectedRevision = confirmed.revision;
    sending = count;
    publish();
    void (async () => {
      let result: PhotoLibraryDevelopVersionsSaveResult;
      try {
        result = await options.save(body, expectedRevision);
      } catch {
        sending = null;
        failed = true;
        publish();
        return;
      }
      sending = null;
      confirmed = { versions: [...result.versions], revision: result.revision };
      if (result.kind === "saved") {
        operations = operations.slice(count);
        staleRetries = 0;
      } else {
        staleRetries += 1;
        if (staleRetries > DEVELOP_VERSIONS_STALE_RETRY_LIMIT) failed = true;
      }
      pump();
    })();
  };

  return {
    apply(operation) {
      operations.push(operation);
      failed = false;
      staleRetries = 0;
      pump();
    },
    retry() {
      if (!failed) return;
      failed = false;
      staleRetries = 0;
      pump();
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settled() {
      if (idle()) return Promise.resolve(!failed && operations.length === 0);
      return new Promise((resolve) => waiters.push(resolve));
    },
    hasPendingWork: () => sending !== null || operations.length > 0,
  };
}
