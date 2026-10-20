"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { photoEditingValueEditLabel, photoEditingValueInputLabel } from "../photo-editing-copy";

/**
 * 補正パネルの 1 本のスライダー（NIHO Photo 段 1 F0 移行元設計・F1 移行元設計。ブラウザ版と NIHO Desktop で共通）。
 *
 * - つまみ: ドラッグ・←→（↑↓）で 1 目盛り・⇧ を押しながらで 10 目盛り・ダブルクリックで既定値へ戻す（Lightroom と同じ）
 * - 右の値: 押すとその場で文字の入力欄に替わる（全選択で始まる）。Enter か欄を離れたら範囲と刻みに丸めて確定、Esc で取り消し、
 *   数値でなければ元の値のまま
 */

/**
 * スライダーの値の変わり方。
 * - `drag`: つまみをドラッグ中（プレビューは `drag: true` の近似）
 * - `input`: キーボードで動かした直後（続けて `commit` が来るので、ここでは描かない）
 * - `commit`: 離した・キーボードで確定した・⇧＋矢印・値を直接入力した・ダブルクリックで戻した（`drag: false` で 1 回描く）
 */
export type PhotoEditingSliderPhase = "drag" | "input" | "commit";

/** 値の直接入力で受ける範囲と刻み（表示と同じ単位）と、確定したときの通知。 */
export type PhotoEditingSliderEntry = {
  min: number;
  max: number;
  step: number;
  commit: (value: number) => void;
};

/** ⇧ を押しながらの矢印で動かす目盛りの数 */
const SHIFT_STEP_COUNT = 10;

function stepDecimals(step: number): number {
  if (step >= 1) return 0;
  return Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
}

/** 範囲に収めて刻みに丸める（-0 は 0）。 */
export function snapPhotoEditingSliderValue(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  if (!(step > 0)) return clamped === 0 ? 0 : clamped;
  const snapped = Number((Math.round((clamped - min) / step) * step + min).toFixed(stepDecimals(step)));
  const result = Math.min(max, Math.max(min, snapped));
  return result === 0 ? 0 : result;
}

const FULL_WIDTH_NUMBER_CHARS = /[０-９．＋－]/g;
const MINUS_SIGNS = /[−–—]/g;
const NUMBER_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * 直接入力の文字を数値として読む（全角の数字・記号と「−」、末尾の「°」〔角度補正〕・「%」〔プリセットの適用量〕も受ける）。
 * 数値でなければ null。
 */
export function parsePhotoEditingValueText(text: string): number | null {
  const normalized = text
    .replace(FULL_WIDTH_NUMBER_CHARS, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(MINUS_SIGNS, "-")
    .trim()
    .replace(/\s*[°%％]$/, "");
  if (!NUMBER_TEXT.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function arrowDirection(key: string): -1 | 0 | 1 {
  if (key === "ArrowRight" || key === "ArrowUp") return 1;
  if (key === "ArrowLeft" || key === "ArrowDown") return -1;
  return 0;
}

export function PhotoEditingSlider(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueText: string;
  disabled: boolean;
  onChange: (value: number, phase: PhotoEditingSliderPhase) => void;
  /** ダブルクリックで既定値へ戻す（Lightroom と同じ） */
  onReset: () => void;
  /**
   * 値の直接入力（表示と同じ単位。色温度の絶対値は K で受ける）。省略時はスライダーの範囲・刻みで受け、
   * `onChange(value, "commit")` で通知する
   */
  entry?: PhotoEditingSliderEntry;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const valueButtonRef = useRef<HTMLButtonElement | null>(null);
  const entryInputRef = useRef<HTMLInputElement | null>(null);
  const pointerActiveRef = useRef(false);
  const dirtyRef = useRef(false);
  const releasePointerListenersRef = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(props.onChange);
  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  // 値の直接入力の途中の文字（入力していなければ null）。押せなくなったら入力をやめる
  const [draft, setDraft] = useState<string | null>(null);
  if (props.disabled && draft !== null) setDraft(null);
  const entryActiveRef = useRef(false);
  const refocusValueRef = useRef(false);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) {
      const input = entryInputRef.current;
      input?.focus();
      input?.select();
      return;
    }
    entryActiveRef.current = false;
    if (!refocusValueRef.current) return;
    refocusValueRef.current = false;
    valueButtonRef.current?.focus();
  }, [editing]);

  const finish = useCallback(() => {
    pointerActiveRef.current = false;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const input = inputRef.current;
    if (!input) return;
    onChangeRef.current(Number(input.value), "commit");
  }, []);

  // React の onChange は input イベント。離したとき・キーボードで確定したときの change イベントを別に聞く。
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.addEventListener("change", finish);
    return () => input.removeEventListener("change", finish);
  }, [finish]);

  useEffect(() => () => releasePointerListenersRef.current?.(), []);

  const handlePointerDown = () => {
    if (props.disabled) return;
    releasePointerListenersRef.current?.();
    pointerActiveRef.current = true;
    // つまみの外で離しても終わりを取りこぼさないよう window で聞く
    const handlePointerEnd = () => {
      releasePointerListenersRef.current?.();
      finish();
    };
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    releasePointerListenersRef.current = () => {
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      releasePointerListenersRef.current = null;
    };
  };

  const startEntry = () => {
    if (props.disabled) return;
    entryActiveRef.current = true;
    setDraft(props.valueText);
  };

  /** 直接入力を終える（`text` が null なら取り消し。数値でなければ元の値のまま）。 */
  const endEntry = (text: string | null, refocus: boolean) => {
    if (!entryActiveRef.current) return;
    entryActiveRef.current = false;
    refocusValueRef.current = refocus;
    setDraft(null);
    if (text === null) return;
    const parsed = parsePhotoEditingValueText(text);
    if (parsed === null) return;
    const entry: PhotoEditingSliderEntry = props.entry ?? {
      min: props.min,
      max: props.max,
      step: props.step,
      commit: (value) => onChangeRef.current(value, "commit"),
    };
    entry.commit(snapPhotoEditingSliderValue(parsed, entry.min, entry.max, entry.step));
  };

  return (
    <div>
      <div className="flex h-5 items-center justify-between gap-2">
        <label htmlFor={props.id} className="text-xs font-bold text-niho-text-sub">
          {props.label}
        </label>
        {draft !== null ? (
          <input
            ref={entryInputRef}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-label={photoEditingValueInputLabel(props.label)}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              // IME の変換を確定する Enter では終えない
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                endEntry(event.currentTarget.value, true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                endEntry(null, true);
              }
            }}
            onBlur={(event) => endEntry(event.currentTarget.value, false)}
            className="h-5 w-12 rounded border border-niho-border bg-white px-1 text-right text-xs tabular-nums text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
          />
        ) : (
          <button
            ref={valueButtonRef}
            type="button"
            disabled={props.disabled}
            aria-label={photoEditingValueEditLabel(props.label, props.valueText)}
            onClick={startEntry}
            // 見た目は今の値の文字のまま、押せる高さだけ 44px にする
            className="relative min-w-[3rem] rounded text-right text-xs tabular-nums text-niho-text after:absolute after:inset-x-0 after:-inset-y-3.5 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink enabled:cursor-text disabled:cursor-not-allowed"
          >
            {props.valueText}
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        id={props.id}
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={props.valueText}
        onPointerDown={handlePointerDown}
        onChange={(event) => {
          dirtyRef.current = true;
          onChangeRef.current(Number(event.currentTarget.value), pointerActiveRef.current ? "drag" : "input");
        }}
        onKeyDown={(event) => {
          // ⇧ を押しながらの矢印は 10 目盛り（既定の 1 目盛りは止め、範囲で止めて確定する）
          if (!event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || props.disabled) return;
          const direction = arrowDirection(event.key);
          if (direction === 0) return;
          event.preventDefault();
          dirtyRef.current = false;
          const next = snapPhotoEditingSliderValue(
            props.value + direction * props.step * SHIFT_STEP_COUNT,
            props.min,
            props.max,
            props.step,
          );
          if (next !== props.value) onChangeRef.current(next, "commit");
        }}
        onDoubleClick={() => {
          if (props.disabled) return;
          dirtyRef.current = false;
          props.onReset();
        }}
        // 押せる高さは 44px、上下の余白は詰めて行の見た目は変えない
        className="-my-1.5 block h-11 w-full cursor-pointer accent-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
      />
    </div>
  );
}
