"use client";

import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import type { DevelopAutoSettingsWarm, DevelopEngine } from "../develop-engine/develop-engine-client";
import {
  autoDevelopSettings,
  developSettingsKey,
  sameDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import { PHOTO_EDITING_AUTO_FAILED_TEXT } from "../photo-editing-copy";

import type { FooterStatus } from "./browser-photo-editing-model";

/** 最後に当てた「自動」（保存しない画面の状態。写真ごとに 1 つ）。 */
type RememberedAuto = {
  photoKey: string;
  /** 押す直前の編集内容（押された表示のときにもう一度押すと、ここへ戻す） */
  base: DevelopSettings;
  /** 当てた結果（今の編集内容がこれと同じ間だけ、押された表示にする） */
  resultKey: string;
};

/** 押す前に決め始めた「自動」の結果（同じ写真・同じ編集内容の間だけ使う）。 */
type WarmedAuto = {
  photoKey: string;
  settingsKey: string;
  task: DevelopAutoSettingsWarm;
  promise: Promise<DevelopSettings>;
};

/** 状態欄に出している 1 行が「自動」の失敗か。 */
function isAutoFailedStatus(status: FooterStatus | null): boolean {
  return status?.kind === "error" && status.text === PHOTO_EDITING_AUTO_FAILED_TEXT;
}

/**
 * ブラウザ版の右パネルの「自動」（NIHO Photo 段 1 F4b 移行元設計）。wasm で開いた写真を 1 枚で見ている間、ライトの群の見出しの横の
 * ボタンで、今の編集内容（プリセットを当てた状態）から crate の `Developer.autoSettings` が決めたライト 6 本と自然な彩度を当てる。
 *
 * - 口は公開済みの wasm に無いことがある。wasm で開いた写真を 1 枚で見ているときに 1 回だけ確かめ（`engine.supportsAuto()`）、
 *   使えると分かってから出す（確かめている間・無い wasm・古い engine は false）。結果は画面を開いている間覚える
 * - 当てるのは取り消しの 1 単位（`commitEdit`。自動保存と丁寧な描画もそこに任せる）。結果は押す前の `engine`・`look`・`base`・
 *   幾何・効果を保つ（`autoDevelopSettings`）。何も変わらなければ何もしない（状態欄にも出さない）
 * - 「押された表示」は保存せず、導出する（プリセットと同じ流儀）: 押す直前の編集内容と当てた結果を覚え、今の編集内容がその結果と
 *   同じ間だけ押された表示にする（スライダーを動かす・プリセットを当てると消え、取り消し・やり直しで結果に戻ると表示も戻る）。
 *   押された表示のときにもう一度押すと、押す直前の編集内容に戻す（取り消しの 1 単位）
 * - 当てている途中の結果は、写真・編集内容が変わった・押せなくなったら捨てる（世代番号）。編集内容がまるごと入れ替わった（別の
 *   写真・別の端末の補正の読み直し）・写真を離れたら、覚えているものを捨てる（`editResetHandlerRef`）
 * - 失敗は状態欄に 1 行「自動補正ができませんでした」（エラー）。次に押す・写真を離れるまで出す（ほかの操作が状態欄を替えたら
 *   それに任せる）
 * - 押して 300ms 以内に画が変わるように（受入）、ボタンに触れた・フォーカスした時点で `warm` が結果の計算を先に始める。
 *   押したときに同じ写真・同じ編集内容の計算が走っていれば、それを待つだけで済む（描画の約 0.27 秒に、計算の約 0.13 秒を足さない）。
 *   編集内容が変わったら使わない（鍵が違う）。先読みの失敗は黙って捨て、押したときに計算し直す
 */
export function useBrowserPhotoAuto(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null。「自動」を使えない） */
  photoKey: string | null;
  /** 押せない（閲覧のみ・入力を開けていない・書き出し / 消している途中・離れる処理・読み直しの途中・切り抜きの道具の間） */
  disabled: boolean;
  settingsKey: string;
  settingsRef: MutableRefObject<DevelopSettings>;
  /** 取り消しの 1 単位として編集内容を確定する（直せなければ false） */
  commitEdit: (next: DevelopSettings) => boolean;
  setStatus: Dispatch<SetStateAction<FooterStatus | null>>;
  /** 編集内容がまるごと入れ替わった・写真を離れたときに呼ばれる係を入れる先（`useBrowserPhotoOpen` が分配する） */
  editResetHandlerRef: MutableRefObject<(() => void) | null>;
}) {
  const { mountedRef, engineRef, photoKey, disabled, settingsKey, settingsRef, commitEdit, setStatus } = params;
  /** 口のある wasm か（確かめるまで null） */
  const [supported, setSupported] = useState<boolean | null>(null);
  const [remembered, setRemembered] = useState<RememberedAuto | null>(null);
  const rememberedRef = useRef<RememberedAuto | null>(null);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  /** 当てる操作の世代（押した・戻した・写真が変わった・離れたら進め、古い結果を捨てる） */
  const generationRef = useRef(0);
  /** 押す前に決め始めた結果（1 つだけ。押すか、写真・編集内容が変わるまで） */
  const warmedRef = useRef<WarmedAuto | null>(null);

  const canToggle = photoKey !== null && supported === true && !disabled && !applying;
  const latestRef = useRef({ photoKey, disabled, canToggle, commitEdit });
  latestRef.current = { photoKey, disabled, canToggle, commitEdit };

  const wanted = photoKey !== null;
  useEffect(() => {
    if (!wanted || supported !== null) return;
    const engine = engineRef.current;
    if (!engine) return;
    let cancelled = false;
    // 古い engine（口の関数が無い）・失敗は false
    void Promise.resolve()
      .then(() => engine.supportsAuto())
      .then(
        (value) => value === true,
        () => false,
      )
      .then((value) => {
        if (!cancelled && mountedRef.current) setSupported(value);
      });
    return () => {
      cancelled = true;
    };
    // 写真が替わっても（`photoKey`）、まだ確かめていなければ確かめる
  }, [engineRef, mountedRef, photoKey, supported, wanted]);

  /** 状態欄の「自動」の失敗の 1 行を消す（ほかの 1 行に替わっていたら触らない）。 */
  const clearFailure = () => {
    setStatus((current) => (isAutoFailedStatus(current) ? null : current));
  };

  // スライダー・プリセット・写真・操作可否が変わったら先読みを取り消し、使えない結果で Worker を塞がない。
  useEffect(() => {
    const warmed = warmedRef.current;
    if (!warmed) return;
    if (warmed.photoKey === photoKey && warmed.settingsKey === settingsKey && !disabled) return;
    warmedRef.current = null;
    warmed.task.cancel();
  }, [disabled, photoKey, settingsKey]);

  const setApplyingState = (next: boolean) => {
    applyingRef.current = next;
    setApplying(next);
  };

  /** 覚えている「自動」・当てている途中の結果・失敗の 1 行を捨てる。 */
  const forget = () => {
    generationRef.current += 1;
    warmedRef.current?.task.cancel();
    warmedRef.current = null;
    rememberedRef.current = null;
    setRemembered(null);
    setApplyingState(false);
    clearFailure();
  };
  params.editResetHandlerRef.current = forget;

  /**
   * 今の編集内容の「自動」の結果を、押される前に決め始める（ボタンに触れた・フォーカスした・押し始めたとき）。同じ写真・同じ編集内容で
   * 決め始めていれば何もしない。押せないとき・押された表示（押すと戻すだけ）のときは決めない。
   */
  const warm = () => {
    const latest = latestRef.current;
    const key = latest.photoKey;
    const engine = engineRef.current;
    if (key === null || !latest.canToggle || applyingRef.current || !engine) return;
    const current = settingsRef.current;
    const currentKey = developSettingsKey(current);
    const entry = rememberedRef.current;
    if (entry && entry.photoKey === key && entry.resultKey === currentKey) return;
    const warmed = warmedRef.current;
    if (warmed && warmed.photoKey === key && warmed.settingsKey === currentKey) return;
    warmed?.task.cancel();
    const task =
      engine.warmAutoSettings?.(current) ??
      ({
        promise: Promise.resolve().then(() => engine.autoSettings(current)),
        promote: () => undefined,
        cancel: () => undefined,
      } satisfies DevelopAutoSettingsWarm);
    const next: WarmedAuto = { photoKey: key, settingsKey: currentKey, task, promise: task.promise };
    warmedRef.current = next;
    // 先読みの失敗は画面に出さない（押したときに計算し直す）
    task.promise.catch(() => {
      if (warmedRef.current === next) warmedRef.current = null;
    });
  };

  /** 今の編集内容に「自動」を当てる（取り消しの 1 単位）。 */
  const apply = async (key: string, current: DevelopSettings) => {
    const generation = ++generationRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      generation === generationRef.current &&
      latestRef.current.photoKey === key &&
      !latestRef.current.disabled &&
      // 当てている間に編集内容が変わっていたら（スライダー・取り消し・プリセット）、古い編集内容の結果を当てない
      sameDevelopSettings(settingsRef.current, current);
    setApplyingState(true);
    try {
      const engine = engineRef.current;
      if (!engine) throw new Error("develop engine is not available");
      // 押す前に同じ写真・同じ編集内容で決め始めていれば、それを待つ（失敗していたら計算し直す）
      const warmed = warmedRef.current;
      warmedRef.current = null;
      const fromWarm =
        warmed !== null && warmed.photoKey === key && warmed.settingsKey === developSettingsKey(current) ? warmed.promise : null;
      if (fromWarm) warmed?.task.promote();
      const result = await (fromWarm ? fromWarm.catch(() => engine.autoSettings(current)) : engine.autoSettings(current));
      if (!isCurrent()) return;
      const next = autoDevelopSettings(current, result);
      // 何も変わらない（もう一度押しても動かない写真）は何もしない
      if (sameDevelopSettings(next, current)) return;
      if (!latestRef.current.commitEdit(next)) return;
      const entry: RememberedAuto = { photoKey: key, base: current, resultKey: developSettingsKey(next) };
      rememberedRef.current = entry;
      setRemembered(entry);
    } catch {
      if (isCurrent()) setStatus({ kind: "error", text: PHOTO_EDITING_AUTO_FAILED_TEXT });
    } finally {
      if (mountedRef.current && generation === generationRef.current) setApplyingState(false);
    }
  };

  /** 「自動」を押す: 押された表示なら押す前の編集内容に戻し、でなければ今の編集内容に当てる。 */
  const toggle = () => {
    const latest = latestRef.current;
    const key = latest.photoKey;
    if (key === null || !latest.canToggle || applyingRef.current) return;
    clearFailure();
    const current = settingsRef.current;
    const entry = rememberedRef.current;
    if (entry && entry.photoKey === key && entry.resultKey === developSettingsKey(current)) {
      generationRef.current += 1;
      latest.commitEdit(entry.base);
      return;
    }
    void apply(key, current);
  };

  const pressed =
    remembered !== null && photoKey !== null && remembered.photoKey === photoKey && remembered.resultKey === settingsKey;

  return {
    /** 「自動」の口のある wasm と分かった（確かめている間・無い wasm は false。ボタンを出さない） */
    supported: supported === true,
    /** 押された表示（今の編集内容が、最後に当てた「自動」の結果と同じ間だけ） */
    pressed,
    /** 押せる（1 枚で見ている wasm の写真・押せる間・当てている途中でない） */
    canToggle,
    toggle,
    /** 押される前に結果の計算を始める（ボタンに触れた・フォーカスした・押し始めたとき） */
    warm,
  };
}

export type BrowserPhotoAuto = ReturnType<typeof useBrowserPhotoAuto>;
