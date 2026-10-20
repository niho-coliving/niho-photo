import { type HTMLAttributes } from "react";

import { cn } from "../cn";

/**
 * 円形ローディング（ぐるぐる）の共通プリミティブ。
 *
 * 色は `--niho-loading-spinner-color`（明るい黄緑＝NIHO Green Vivid）の単一の正に統一する。
 * spinner の色・サイズを各所でインライン直書きせず、必ずこのコンポーネントを使う。
 *
 * - `size`: フルページ=`xl`(48px) / モーダル内=`md`(24px) / ボタン内=`sm`(16px) を基準に文脈で選ぶ。
 * - `tone="onColor"`: 緑ボタンなど色面の上に重ねるとき（白）。
 * - `motion-reduce` で `prefers-reduced-motion` 時はアニメーションを止める（design-guide §9 MUST）。
 * - レイアウト用の余白（`mx-auto` / `mb-4` 等）は `className` で渡す。
 * - 既定は**装飾**（`aria-hidden`）。隣に「読み込み中…」等の可視テキストやボタン文脈がある通常用途を
 *   想定し、live region を増やさない。spinner だけが唯一のローディング表示になる場合のみ `label` を渡し、
 *   `role="status"` で読み上げさせる（複数同時表示や可視テキストとの二重読み上げを避ける）。
 */
type SpinnerSize = "sm" | "md" | "lg" | "xl";
type SpinnerTone = "brand" | "onColor";

const SIZE_CLASS: Record<SpinnerSize, string> = {
  sm: "h-4 w-4 border-2",
  md: "h-6 w-6 border-2",
  lg: "h-10 w-10 border-4",
  xl: "h-12 w-12 border-4",
};

const TONE_CLASS: Record<SpinnerTone, string> = {
  brand: "border-[var(--niho-loading-spinner-color)]",
  onColor: "border-white",
};

export type SpinnerProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  size?: SpinnerSize;
  tone?: SpinnerTone;
  /**
   * 渡すと `role="status"` + `aria-label` で読み上げる（spinner が唯一のローディング表示のとき）。
   * 省略時は装飾扱い（`aria-hidden`）にし、live region を増やさない。
   */
  label?: string;
};

export function Spinner({ size = "xl", tone = "brand", label, className, ...props }: SpinnerProps) {
  const a11yProps = label ? { role: "status", "aria-label": label } : { "aria-hidden": true };
  return (
    <div
      {...a11yProps}
      className={cn(
        "animate-spin rounded-full motion-reduce:animate-none",
        SIZE_CLASS[size],
        TONE_CLASS[tone],
        className,
        // border-t-transparent は全辺の border-color（TONE_CLASS / 呼び出し側 className）より後に置く。
        // tailwind-merge が全辺 border-color を後勝ちにして上辺の透明指定を消すと、隙間の無い
        // 塗りつぶし円になってしまうため、最後に重ねて上辺だけ確実に透明を残す。
        "border-t-transparent",
      )}
      {...props}
    />
  );
}
