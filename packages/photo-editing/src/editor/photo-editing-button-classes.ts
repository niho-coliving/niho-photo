/**
 * 下段の右端の主ボタン（「書き出す」と、差し込む「記事に入れる」）。右パネルと同じ幅の帯に収めるため 32px
 * （共通 Button の sm と同じ高さ）で左右 16px（移行元設計・owner 2026-09-25）
 */
export const PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME =
  "niho-primary-surface inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-4 text-sub font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
/** 「止める」など（主ボタンと同じ場所に入れ替わるので同じ高さ） */
export const PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME =
  "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-full border border-[#DDD8CC] bg-white px-3 text-sub font-bold text-niho-text transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-50";
/** 中央の空状態の主ボタン（「フォルダ・画像を追加」）。作業面の真ん中に 1 つだけ置くので下段より大きい */
export const PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME =
  "niho-primary-surface inline-flex min-h-10 items-center gap-2 rounded-full px-5 text-sub font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
/**
 * クラウドのグリッドの右上の「クラウドから消す」（取り消せない操作。主ボタンから離れた一覧の行に置くので、囲みを付けず
 * 字とアイコンだけ danger の色にする。高さは下段と同じ 32px。移行元設計）
 */
export const PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sub font-bold text-[#8C3425] transition hover:bg-[#FFF5F2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-50";
/**
 * 字だけの副ボタン（「絞り込みを解除」・絞り込みのパネルの「解除」。囲みを付けない。見た目は 32px のまま、押せる範囲だけ 44px。
 * F5b 移行元設計）
 */
export const PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME =
  "relative inline-flex h-8 shrink-0 items-center justify-center rounded-full px-3 text-sub font-bold text-niho-accent-ink transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']";
/**
 * 状態欄・右パネルの「再試行」（作業コピーを作れなかったとき。字だけで囲みを付けない。押せる範囲は 44px。ブラウザ版と
 * NIHO Desktop で同じ。移行元設計 / 移行元設計）
 */
export const PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME =
  "h-11 shrink-0 rounded-full px-3 text-xs font-bold text-niho-accent-ink transition hover:bg-niho-pale/60 disabled:cursor-not-allowed disabled:opacity-40";
