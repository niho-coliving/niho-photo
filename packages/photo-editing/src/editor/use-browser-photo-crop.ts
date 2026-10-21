"use client";

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import {
  readDevelopGeometry,
  resetDevelopGeometry,
  writeDevelopGeometry,
  type DevelopGeometry,
  type DevelopSize,
} from "../develop-engine/develop-geometry";
import { sameDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import {
  PHOTO_EDITING_CROP_EXPORT_DECODE_CAP,
  PHOTO_EDITING_CROP_EXPORT_LONG_EDGE,
  cropExportLimitLongEdge,
  fitDevelopSize,
  readDevelopSize,
} from "../photo-editing-crop";

import type { DevelopSession } from "./browser-photo-editing-model";

/** 切り抜きの道具を開いている写真の、座標の基準と書き出しの入力の大きさ。 */
type CropSource = {
  key: string;
  /** 作業画像（向きは反映済み・幾何を当てる前）の大きさ。オリジナルは元の寸法、作業コピーは開いた大きさ */
  source: DevelopSize;
  /** 書き出しが読む大きさ（作業コピーはその大きさ、JPEG / PNG のオリジナルは長辺 4096px に収めた大きさ） */
  exportInput: DevelopSize;
};

/**
 * 開いている写真の、切り抜きの座標の基準にする大きさを読む。オリジナルは wasm の `imageSize`（読んだ寸法は session に覚え、作業
 * サイズを合わせるときに読み直さない）、作業コピーは開いたときの大きさ。読めなければ null。プリセットのマスクを作業画像の座標へ
 * 写すとき（`useBrowserPhotoPresets` の `readSourceSize`）も同じ大きさを使う。
 */
export async function readCropSource(
  engine: Pick<DevelopEngine, "imageSize">,
  session: Pick<DevelopSession, "input" | "working" | "workSize">,
): Promise<Omit<CropSource, "key"> | null> {
  const input = session.input;
  if (input.kind === "workingCopy") {
    const size = readDevelopSize(session.workSize);
    return size ? { source: size, exportInput: size } : null;
  }
  const working = session.working;
  let original = readDevelopSize(working?.originalSize);
  if (!original) {
    original = readDevelopSize(await engine.imageSize(await input.file.arrayBuffer()));
    if (original && working) working.originalSize = original;
  }
  return original ? { source: original, exportInput: fitDevelopSize(original, PHOTO_EDITING_CROP_EXPORT_DECODE_CAP) } : null;
}

/**
 * ブラウザ版の切り抜きの道具（切り抜き・回転・角度補正。NIHO Photo 段 1 F3b 移行元設計）の状態。右パネルの「補正 / 切り抜き」の
 * 切り替え・枠の部品と道具の部品に渡す値・確定を持つ。
 *
 * - 入口を出す条件（`available`）: 受入まで拠点を絞るフラグ・1024px 以上・wasm で開いた写真を 1 枚で見ている・wasm に幾何の口が
 *   ある（`supportsGeometry`。フラグが off の拠点では確かめない）
 * - 「切り抜き」に入るときに、座標の基準にする大きさ（{@link readCropSource}）を読む。読めてから切り替える（読めなければ「補正」の
 *   まま）。切り抜きの間は「補正前」を外し、面の描画は枠全体（切り抜きと角度を外した画）を描く
 * - 確定は `commitEdit(writeDevelopGeometry(今の編集内容, 新しい幾何))` だけ（取り消しの 1 単位。自動保存と履歴はそこに任せる。
 *   同じ幾何なら何もしない）。「初期化」は切り抜きだけを戻す（`resetDevelopGeometry`。色は触らない）
 * - 入ったときの幾何を覚える。［完了］（Enter）は「補正」に戻るだけ、［キャンセル］（Esc）は覚えた幾何に戻してから戻る（#52）
 * - 「補正」に戻るとき（と、切り抜きの間に写真を離れるとき）は、切り抜きに合わせて wasm の作業サイズを確かめ直す
 *   （`ensureDevelopWorkingSize`）。終わるまで `settling`（面はその間描かず、終わってから切り抜いた画を丁寧に描く）
 * - 編集内容がまるごと入れ替わった（別の写真・別の端末の補正の読み直し）・写真を離れた（一覧へ戻った）・出す条件を満たさなく
 *   なったら「補正」に戻す
 */
export function useBrowserPhotoCrop(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  developSessionRef: MutableRefObject<DevelopSession | null>;
  /** 受入まで拠点を絞るフラグ（`usePhotoEditingRollout(spotId).crop`） */
  rollout: boolean;
  /** このsurfaceで編集できる幅か（PCまたはF6cのmobileEditingAllowed）。互換のため名前はwideのまま。 */
  wide: boolean;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
  settings: DevelopSettings;
  settingsKey: string;
  settingsRef: MutableRefObject<DevelopSettings>;
  /** 取り消しの 1 単位として編集内容を確定する（直せなければ false） */
  commitEdit: (next: DevelopSettings, options?: { resetDone?: boolean }) => boolean;
  setCompareOriginal: (compare: boolean) => void;
  ensureDevelopWorkingSize: (settings: DevelopSettings) => Promise<boolean>;
  /** 編集内容がまるごと入れ替わった・写真を離れたときに呼ばれる係を入れる先 */
  editResetHandlerRef: MutableRefObject<(() => void) | null>;
}) {
  const { mountedRef, engineRef, developSessionRef, rollout, wide, photoKey, settings, settingsKey, settingsRef } = params;
  const { commitEdit, setCompareOriginal, ensureDevelopWorkingSize } = params;
  /** wasm に幾何の口があるか（確かめるまで null） */
  const [supported, setSupported] = useState<boolean | null>(null);
  /** 切り抜きの道具を開いている写真と、その座標の基準（開いていなければ null） */
  const [cropSource, setCropSource] = useState<CropSource | null>(null);
  const cropSourceRef = useRef<CropSource | null>(null);
  /** 角度補正のつまみを動かしている間の手元の角度 */
  const [liveAngle, setLiveAngle] = useState<number | null>(null);
  /** 「補正」に戻って、wasm の作業サイズを切り抜きに合わせている間 */
  const [settling, setSettling] = useState(false);
  const [exportLongEdge, setExportLongEdge] = useState<number | null>(null);
  /** 入る・戻るの世代（読んでいる途中・合わせている途中に切り替わったら、古い結果を捨てる） */
  const generationRef = useRef(0);
  /** 切り抜きの座標を読んでいる間に別の道具へ移ったとき、遅れて入らないようにする */
  const enteringRef = useRef(false);
  /** 切り抜きに入ったときの幾何（［キャンセル］・Esc で戻す先。開いていない間は null） */
  const entryGeometryRef = useRef<DevelopGeometry | null>(null);

  const wanted = rollout && wide && photoKey !== null;
  useEffect(() => {
    if (!wanted || supported !== null) return;
    const engine = engineRef.current;
    if (!engine) return;
    let cancelled = false;
    engine.supportsGeometry().then(
      (value) => {
        if (!cancelled && mountedRef.current) setSupported(value === true);
      },
      () => {
        if (!cancelled && mountedRef.current) setSupported(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // 写真が替わっても（`photoKey`）、まだ確かめていなければ確かめる
  }, [engineRef, mountedRef, photoKey, supported, wanted]);

  const available = wanted && supported === true;
  const active = available && cropSource !== null && cropSource.key === photoKey;
  const latestRef = useRef({ available, active, photoKey });
  latestRef.current = { available, active, photoKey };

  const replaceCropSource = (next: CropSource | null) => {
    cropSourceRef.current = next;
    setCropSource(next);
  };

  /** 「切り抜き」に入る（座標の基準を読めてから切り替える）。 */
  const enter = () => {
    const { available: canEnter, active: entered, photoKey: key } = latestRef.current;
    const session = developSessionRef.current;
    const engine = engineRef.current;
    if (!canEnter || entered || enteringRef.current || key === null || !session || session.key !== key || !engine) return;
    const generation = ++generationRef.current;
    enteringRef.current = true;
    const isCurrent = () => mountedRef.current && generation === generationRef.current;
    void readCropSource(engine, session).then(
      (source) => {
        if (!isCurrent()) return;
        enteringRef.current = false;
        // 「補正」に戻って作業サイズを合わせている途中に入り直したら、その待ちはここで終える
        setSettling(false);
        if (!source || latestRef.current.photoKey !== key || !latestRef.current.available) return;
        setLiveAngle(null);
        setCompareOriginal(false);
        entryGeometryRef.current = readDevelopGeometry(settingsRef.current);
        replaceCropSource({ key, ...source });
      },
      () => {
        if (isCurrent()) {
          enteringRef.current = false;
          setSettling(false);
        }
      },
    );
  };

  /**
   * 「補正」に戻る。切り抜きに合わせて wasm の作業サイズを確かめ直し、終わるまで描かせない（`settling`）。`draw` が false なら
   * 写真を離れるところなので、確かめ直すだけ（次に 1 枚で見るときのため）。
   */
  const close = (draw: boolean) => {
    const generation = ++generationRef.current;
    enteringRef.current = false;
    const wasOpen = cropSourceRef.current !== null;
    entryGeometryRef.current = null;
    replaceCropSource(null);
    setLiveAngle(null);
    setExportLongEdge(null);
    if (!wasOpen) {
      setSettling(false);
      return;
    }
    setSettling(draw);
    const done = () => {
      if (draw && mountedRef.current && generation === generationRef.current) setSettling(false);
    };
    void ensureDevelopWorkingSize(settingsRef.current).then(done, done);
  };

  const leave = () => {
    if (cropSourceRef.current !== null) close(true);
    else if (enteringRef.current) {
      // 寸法を読んでいる最中に補正へ戻った場合は、その結果で遅れて切り抜きへ入らない。
      generationRef.current += 1;
      enteringRef.current = false;
    }
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  // 編集内容がまるごと入れ替わった・写真を離れた
  params.editResetHandlerRef.current = () => close(false);

  // 出す条件を満たさなくなった（編集surfaceを離れた・受入のフラグが変わった）ら「補正」に戻す
  const stale = cropSource !== null && !active;
  useEffect(() => {
    if (stale) leaveRef.current();
  }, [stale]);

  /** 新しい幾何を確定する（取り消しの 1 単位。同じ幾何なら何もしない）。 */
  const commit = (next: DevelopGeometry) => {
    if (!latestRef.current.active) return;
    const current = settingsRef.current;
    const written = writeDevelopGeometry(current, next);
    if (sameDevelopSettings(written, current)) return;
    commitEdit(written);
  };

  /**
   * ［キャンセル］・Esc: 入ったときの幾何に戻し（今と違えば取り消しの 1 単位。↶ でキャンセルの前に戻せる）、「補正」に戻る。
   * ［完了］・Enter・ほかの道具へ移るのは {@link leave}（幾何は押すたびに確定済みなので、そのまま残す）。
   */
  const cancel = () => {
    const entry = entryGeometryRef.current;
    if (entry) commit(entry);
    leave();
  };

  /** 切り抜きの「初期化」: 切り抜き・回転・角度を消す（色の補正は残す）。 */
  const reset = () => {
    if (!latestRef.current.active) return;
    setLiveAngle(null);
    commitEdit(resetDevelopGeometry(settingsRef.current), { resetDone: true });
  };

  // 書き出しの大きさ（今の編集内容で書き出したときの長辺。切り抜きで 2048px に届かなくなるときだけ出す）
  const exportInput = active && cropSource ? cropSource.exportInput : null;
  useEffect(() => {
    const engine = engineRef.current;
    if (!exportInput || !engine) return;
    let cancelled = false;
    const show = (longEdge: number | null) => {
      if (!cancelled && mountedRef.current) setExportLongEdge(longEdge);
    };
    Promise.resolve()
      .then(() => engine.geometryOutputSize(settingsRef.current, exportInput, PHOTO_EDITING_CROP_EXPORT_LONG_EDGE))
      .then(
        (size) => {
          const output = readDevelopSize(size);
          show(output ? cropExportLimitLongEdge(output, exportInput) : null);
        },
        () => show(null),
      );
    return () => {
      cancelled = true;
    };
    // `settingsKey`: 編集内容が変わるたびに読み直す
  }, [engineRef, exportInput, mountedRef, settingsKey, settingsRef]);

  const geometry = useMemo(() => readDevelopGeometry(settings), [settings]);

  return {
    /** 「補正 / 切り抜き」の切り替えを出す */
    available,
    /** 切り抜きの道具を開いている */
    active,
    /** 「補正」に戻って作業サイズを合わせている間（面は描かない） */
    settling,
    /** 確定している幾何 */
    geometry,
    /** 座標の基準（切り抜きの道具を開いている間だけ） */
    source: active && cropSource ? cropSource.source : null,
    liveAngle: active ? liveAngle : null,
    setLiveAngle,
    exportLongEdge: active ? exportLongEdge : null,
    enter,
    /** 「補正」に戻る（［完了］・Enter・ほかの道具へ移る・R。幾何はそのまま） */
    leave,
    /** ［キャンセル］・Esc（入ったときの幾何に戻して「補正」に戻る） */
    cancel,
    toggle: () => (latestRef.current.active ? leave() : enter()),
    commit,
    reset,
  };
}

export type BrowserPhotoCrop = ReturnType<typeof useBrowserPhotoCrop>;
