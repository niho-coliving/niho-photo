"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";

import type { DevelopSettings } from "../develop-engine/develop-settings";
import { usePhotoLibrary } from "../library/photo-library-context";
import {
  PHOTO_EDITING_VERSIONS_LIMIT_TEXT,
  PHOTO_EDITING_VERSIONS_NAME_REQUIRED_TEXT,
  PHOTO_EDITING_VERSIONS_NAME_TOO_LONG_TEXT,
} from "../photo-editing-copy";

import {
  addDevelopVersion,
  createDevelopVersionId,
  createDevelopVersionsWriter,
  defaultDevelopVersionName,
  developVersionsFull,
  newDevelopVersion,
  normalizeDevelopVersionName,
  planDevelopVersionSwitch,
  removeDevelopVersion,
  renameDevelopVersion,
  selectedDevelopVersionId,
  type DevelopVersionsWriter,
  type DevelopVersionsWriterState,
} from "./browser-photo-editing-versions-model";

/** 写真ごとの保存係を覚えておく数（版の面を開いた写真。送り終えていない係は消さない）。 */
const WRITERS_KEPT = 50;

const EMPTY_STATE: DevelopVersionsWriterState = { versions: [], saving: false, failed: false };

/** 版の面の読み込み（`ready` は保存係ができた）。 */
export type BrowserPhotoVersionsStatus = "loading" | "failed" | "ready";

/** 名前を付ける・変える操作の結果（失敗は入力の下に出す 1 行）。 */
export type BrowserPhotoVersionNameResult = { ok: true } | { ok: false; message: string };

function nameMessage(error: "empty" | "tooLong"): string {
  return error === "empty" ? PHOTO_EDITING_VERSIONS_NAME_REQUIRED_TEXT : PHOTO_EDITING_VERSIONS_NAME_TOO_LONG_TEXT;
}

/**
 * 右パネルの「版」（niho-photo#42）の中身。版の面を開いて、wasm で開いた写真を 1 枚で見ている間だけ写真の版を読み（`photo` が
 * null の間は読まない）、作る・名前を変える・消す・切り替えるを、写真ごとの保存係（{@link createDevelopVersionsWriter}）で
 * 置き場（`PhotoLibrary.saveDevelopVersions`）へ順に保存する。
 *
 * - 切り替えは、切り替える前の補正を自動の版として残す操作を先に保存係へ渡し（すぐ送り始める）、それから版の補正を
 *   `commitEdit` 1 回で当てる（取り消し・やり直しは切り替え 1 回ずつ。写真の補正の保存は今までどおり自動保存が 800ms まとめて送る）
 * - 保存係は写真ごとに覚え、面を閉じても・写真を替えても送り続ける（開き直したら覚えた版をそのまま出し、読み直さない）
 * - 保存の失敗は画面の版を変えず、`saveFailed` と `retrySave` で送り直す
 */
export function useBrowserPhotoVersions(params: {
  /** 版を読む写真（版の面を開いて 1 枚で見ている間だけ。ほかは null） */
  photo: { id: string; contentSha256: string | null } | null;
  /** 今の補正（選んでいる版を決める） */
  settings: DevelopSettings;
  settingsRef: MutableRefObject<DevelopSettings>;
  /** 取り消しの 1 単位として補正を確定する（直せなければ false） */
  commitEdit: (next: DevelopSettings) => boolean;
  /** 切り替え・作成を押せない（閲覧のみ・操作の途中など） */
  disabled: boolean;
  /** 今の時刻・版の ID（テスト用） */
  now?: () => Date;
  createId?: () => string;
}) {
  const library = usePhotoLibrary();
  const { photo, settings, settingsRef, commitEdit, disabled } = params;
  const now = params.now ?? (() => new Date());
  const createId = params.createId ?? createDevelopVersionId;
  const developVersions = library.developVersions?.bind(library);
  const saveDevelopVersions = library.saveDevelopVersions?.bind(library);
  const available = photo !== null && developVersions !== undefined && saveDevelopVersions !== undefined;
  const photoId = photo?.id ?? null;
  const writerKey = available && photo ? `${photo.id}\u0000${photo.contentSha256 ?? ""}` : null;
  const writersRef = useRef(new Map<string, DevelopVersionsWriter>());
  const [load, setLoad] = useState<{ key: string; status: "loading" | "failed" } | null>(null);
  const [reloads, setReloads] = useState(0);
  const writer = writerKey ? (writersRef.current.get(writerKey) ?? null) : null;

  const latestRef = useRef({ developVersions, saveDevelopVersions });
  latestRef.current = { developVersions, saveDevelopVersions };

  // 保存係の無い写真は版を読む（読めたら保存係を作る）。読めなければ失敗の 1 行（「再読み込み」で読み直す）
  useEffect(() => {
    if (writerKey === null || photoId === null || writersRef.current.has(writerKey)) return;
    const read = latestRef.current.developVersions;
    if (!read) return;
    const abort = new AbortController();
    setLoad({ key: writerKey, status: "loading" });
    read(photoId, { signal: abort.signal }).then(
      (loaded) => {
        if (abort.signal.aborted) return;
        const writers = writersRef.current;
        writers.set(
          writerKey,
          createDevelopVersionsWriter({
            initial: loaded,
            save: (versions, expectedRevision) => {
              const save = latestRef.current.saveDevelopVersions;
              if (!save) return Promise.reject(new Error("develop versions are not available"));
              return save(photoId, versions, { expectedRevision });
            },
          }),
        );
        // 覚えすぎた写真の保存係を古い順に手放す（送り終えていない係は残す）
        for (const [key, kept] of writers) {
          if (writers.size <= WRITERS_KEPT) break;
          if (key !== writerKey && !kept.hasPendingWork()) writers.delete(key);
        }
        setLoad(null);
      },
      () => {
        if (!abort.signal.aborted) setLoad({ key: writerKey, status: "failed" });
      },
    );
    return () => abort.abort();
  }, [photoId, reloads, writerKey]);

  const subscribe = useCallback(
    (listener: () => void) => (writer ? writer.subscribe(listener) : () => undefined),
    [writer],
  );
  const getSnapshot = useCallback(() => (writer ? writer.getState() : EMPTY_STATE), [writer]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const status: BrowserPhotoVersionsStatus = writer
    ? "ready"
    : load?.key === writerKey && load.status === "failed"
      ? "failed"
      : "loading";
  const versions = state.versions;
  const selectedId = useMemo(() => selectedDevelopVersionId(versions, settings), [settings, versions]);
  const defaultName = useMemo(() => defaultDevelopVersionName(versions), [versions]);
  const full = developVersionsFull(versions);

  /** 今の補正を名前つきの版にする（名前は前後の空白を除いて 1〜40 文字）。 */
  const create = (name: string): BrowserPhotoVersionNameResult => {
    if (!writer || disabled) return { ok: false, message: "" };
    const normalized = normalizeDevelopVersionName(name);
    if (!normalized.ok) return { ok: false, message: nameMessage(normalized.error) };
    if (developVersionsFull(writer.getState().versions)) return { ok: false, message: PHOTO_EDITING_VERSIONS_LIMIT_TEXT };
    writer.apply(
      addDevelopVersion(
        newDevelopVersion({ id: createId(), name: normalized.name, kind: "named", settings: settingsRef.current, now: now() }),
      ),
    );
    return { ok: true };
  };

  const rename = (id: string, name: string): BrowserPhotoVersionNameResult => {
    if (!writer) return { ok: false, message: "" };
    const normalized = normalizeDevelopVersionName(name);
    if (!normalized.ok) return { ok: false, message: nameMessage(normalized.error) };
    const current = writer.getState().versions.find((version) => version.id === id);
    if (current && current.name !== normalized.name) writer.apply(renameDevelopVersion(id, normalized.name));
    return { ok: true };
  };

  /** 版を消す（選んでいる版でも、写真の補正は変えない）。 */
  const remove = (id: string) => {
    writer?.apply(removeDevelopVersion(id));
  };

  /** 版に切り替える（何も変わらなければ何もしない）。 */
  const switchTo = (id: string) => {
    if (!writer || disabled) return;
    const plan = planDevelopVersionSwitch({
      versions: writer.getState().versions,
      targetId: id,
      current: settingsRef.current,
      now: now(),
      createId,
    });
    if (!plan) return;
    // 切り替える前の補正を先に残す（補正の自動保存より先に送り始める）
    if (plan.keep) writer.apply(addDevelopVersion(plan.keep));
    commitEdit(plan.settings);
  };

  return {
    status,
    /** 作った順（古いものが先） */
    versions,
    selectedId,
    defaultName,
    /** 名前つきの版が上限 */
    full,
    saveFailed: state.failed,
    create,
    rename,
    remove,
    switchTo,
    retrySave: () => writer?.retry(),
    reload: () => setReloads((count) => count + 1),
  };
}

export type BrowserPhotoVersions = ReturnType<typeof useBrowserPhotoVersions>;
