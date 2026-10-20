// design-guide-host-admin §6-13a の Host Settings フィールド様式（共有定数）。
// 通常は枠なしのニュートラル面、focus で緑枠 + 白面に持ち上げる。
// admin/host 面のフォーム入力はこのモジュールを正とし、ページ側で独自の入力配色を作らない。

// hover / focus の振る舞い（緑リテラルはこの1箇所だけに置く）。面の色は下の2つが足す。
const ADMIN_FIELD_INTERACTION_CLASS =
  "border border-transparent text-niho-text outline-none transition hover:bg-[#F7FAF1] focus:border-[#9AB56B] focus:bg-white";

// 面（bg/border/hover/focus）だけの部分。サイズ違いのフィールドはこれに独自のサイズ classes を足す。
export const ADMIN_FIELD_SURFACE_CLASS = `bg-[#FAFAF7] ${ADMIN_FIELD_INTERACTION_CLASS}`;

// 移行元設計: 行リスト（§6-13a「セクション内のリストは divide-y のヘアラインで区切り、行内の入力は
// 通常時 border-transparent + bg-transparent」）の行内入力。hover / focus は上と同じ振る舞いで、
// 通常時だけ面を出さない。テーブル風に見えるが入力できる、という余白感を作るための変種。
export const ADMIN_ROW_FIELD_SURFACE_CLASS = `bg-transparent ${ADMIN_FIELD_INTERACTION_CLASS}`;

// 標準サイズのフィールド（input / select / textarea）。
export const ADMIN_FIELD_CLASS = `w-full rounded-xl px-3 py-2 text-body ${ADMIN_FIELD_SURFACE_CLASS}`;

// 金額入力用。左に ¥ prefix を敷くための左パディング + 桁揃え。
export const ADMIN_FIELD_MONEY_CLASS = `${ADMIN_FIELD_CLASS} pl-8 tabular-nums`;
