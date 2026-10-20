"use client";

import {
  Fragment,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Check } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "niho-ui/components/popover";
import { cn } from "niho-ui/cn";

export type PhotoEditingMenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /**
   * 押せない理由の短い言葉（「保存済み」）。項目の右にチェックの印と並べ、押せなくても薄くせずに読める濃さで出す
   * （読み上げは「クラウドに保存（保存済み）」。移行元設計）
   */
  hint?: string;
  /**
   * `hint` の種類。既定の `done` は済んだ印（チェックの印を添える）、`reason` は押せない理由（「オリジナルを置かない設定」。
   * 済んだと読めないよう印を付けない。移行元設計）
   */
  hintKind?: "done" | "reason";
  /** 取り消せない操作。文字を danger の色にする（確かめは選んだ後に出す） */
  danger?: boolean;
  /** キーの近道（項目の右に薄く出す。`aria` は `aria-keyshortcuts` の書き方。`hint` のある項目には出さない） */
  shortcut?: { text: string; aria: string };
  /**
   * 押せない理由の 1 行（項目のすぐ下に、薄くせずに読める濃さで出す。読み上げは `aria-describedby`）。`hint` より長い文
   * （「先に 1 枚の補正をコピーしてください」。F5a-2 移行元設計）
   */
  reason?: string;
  /**
   * 選んだ後にダイアログを開く項目。メニューを閉じたときにフォーカスを開くボタンへ戻さない
   * （開いたダイアログのフォーカスを奪わない）
   */
  opensDialog?: boolean;
  onSelect: () => void;
};

/** 項目の間の区切り（`role="separator"`）。 */
export type PhotoEditingMenuSeparator = { kind: "separator"; key: string };
/** 項目の群の小見出し（押せない。「プリセット」「拠点のプリセット」。F5a-2 移行元設計）。 */
export type PhotoEditingMenuHeading = { kind: "heading"; key: string; label: string };
/** 押せない 1 行の知らせ（「プリセットを読み込み中…」など）。 */
export type PhotoEditingMenuNote = { kind: "note"; key: string; text: string; tone?: "muted" | "danger" };
/** メニューの 1 行（項目・区切り・小見出し・知らせ）。 */
export type PhotoEditingMenuEntry = PhotoEditingMenuItem | PhotoEditingMenuSeparator | PhotoEditingMenuHeading | PhotoEditingMenuNote;

const MENU_NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** ↑↓（Home / End）で押せる項目の間を移る（開くと最初の項目にフォーカスが当たる）。 */
function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (!MENU_NAVIGATION_KEYS.has(event.key)) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
  );
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}

/**
 * 写真編集の今のボタンに足すメニュー（クラウドの写真置き場の案 B、移行元設計 → 移行元設計）。ボタンは増やさず、押すとメニューを
 * 出す（「フォルダ・画像を追加」（左の見出しの「＋」）→「この Mac のフォルダ」「この Mac の写真」、「書き出す」→ 送り先の
 * 「この Mac に保存」「クラウドに保存」。移行元設計 → 移行元設計）。`children` はメニューを開くボタン
 * （`aria-haspopup="menu"` を付けた button 要素）。
 */
export function PhotoEditingMenu(props: {
  items: PhotoEditingMenuEntry[];
  align?: "start" | "end";
  /**
   * 見た目（省くと NIHO Desktop の面）。`browser` はブラウザ版の右パネル（項目の高さ 44px・色は semantic token。NIHO Photo 段 1
   * F2b 移行元設計）
   */
  variant?: "desktop" | "browser";
  /** 開いた・閉じたとき（開いてから中身を読み始める。一覧の一括の「補正」メニュー。F5a-2 移行元設計） */
  onOpenChange?: (open: boolean) => void;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const browser = props.variant === "browser";
  const skipFocusReturnRef = useRef(false);
  const reasonIdPrefix = useId();
  const onOpenChange = props.onOpenChange;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const renderItem = (item: PhotoEditingMenuItem) => {
    // 押せない理由を添えた項目（「保存済み」）は薄くせず、字をおさえた色にして理由を読めるようにする
    const settled = item.disabled === true && item.hint !== undefined;
    const reasonId = item.reason ? `${reasonIdPrefix}-${item.key}-reason` : undefined;
    return (
      <Fragment key={item.key}>
        <button
          type="button"
          role="menuitem"
          disabled={item.disabled}
          aria-label={item.hint ? `${item.label}（${item.hint}）` : undefined}
          aria-describedby={reasonId}
          aria-keyshortcuts={item.shortcut && !item.hint ? item.shortcut.aria : undefined}
          onClick={() => {
            skipFocusReturnRef.current = item.opensDialog === true;
            changeOpen(false);
            item.onSelect();
          }}
          className={cn(
            browser
              ? "flex min-h-11 w-full items-center gap-2 rounded-[10px] px-3 text-left text-sub font-bold transition-colors hover:bg-niho-pale/60 focus-visible:bg-niho-pale/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent"
              : "flex min-h-10 w-full items-center gap-2 rounded-[10px] px-3 text-left text-sub font-bold transition-colors hover:bg-[#F5F6F1] focus-visible:bg-[#F5F6F1] focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent",
            settled ? "text-niho-text-muted" : "disabled:opacity-50",
            !settled && (item.danger ? (browser ? "text-niho-danger" : "text-[#8C3425]") : "text-niho-text"),
          )}
        >
          {item.icon ? (
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center",
                settled
                  ? "text-niho-text-muted"
                  : item.danger
                    ? browser
                      ? "text-niho-danger"
                      : "text-[#8C3425]"
                    : "text-niho-text-sub",
              )}
            >
              {item.icon}
            </span>
          ) : null}
          {item.label}
          {item.hint ? (
            <span
              className={cn(
                "ml-auto flex shrink-0 items-center gap-1 pl-5 text-xs font-bold",
                item.hintKind === "reason" ? "text-niho-text-sub" : "text-niho-accent-ink",
              )}
            >
              {item.hintKind === "reason" ? null : <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
              {item.hint}
            </span>
          ) : item.shortcut ? (
            <span aria-hidden className="ml-auto shrink-0 pl-5 text-xs font-bold tracking-[0.05em] text-niho-text-muted">
              {item.shortcut.text}
            </span>
          ) : null}
        </button>
        {item.reason ? (
          // 押せない項目の下に、薄くしない濃さで理由を 1 行（項目の button の opacity の外に置く）
          <p id={reasonId} className="-mt-1 px-3 pb-1.5 text-xs leading-relaxed text-niho-text-sub">
            {item.reason}
          </p>
        ) : null}
      </Fragment>
    );
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>{props.children}</PopoverTrigger>
      <PopoverContent
        role="menu"
        align={props.align ?? "start"}
        sideOffset={6}
        onKeyDown={moveMenuFocus}
        onCloseAutoFocus={(event) => {
          if (!skipFocusReturnRef.current) return;
          skipFocusReturnRef.current = false;
          event.preventDefault();
        }}
        className={
          browser
            ? // 項目が多いとき（拠点のプリセット）は画面に収めて中で送る
              "w-auto min-w-[11rem] max-w-[calc(100vw-2rem)] max-h-[min(32rem,var(--radix-popover-content-available-height,32rem))] overflow-y-auto overscroll-contain rounded-[14px] border border-niho-border bg-white p-1 shadow-lg"
            : "w-auto min-w-[11rem] overflow-hidden rounded-[14px] border-white/80 bg-[rgba(255,255,255,0.96)] p-1 shadow-[0_12px_30px_rgba(98,78,46,0.14)] backdrop-blur-[16px]"
        }
      >
        {props.items.map((entry) => {
          if (!("kind" in entry)) return renderItem(entry);
          if (entry.kind === "separator") {
            return <div key={entry.key} role="separator" className="mx-2 my-1 h-px bg-niho-border" />;
          }
          if (entry.kind === "heading") {
            return (
              <p key={entry.key} className="px-3 pb-1 pt-2 text-xs font-bold text-niho-text-muted">
                {entry.label}
              </p>
            );
          }
          return (
            <p
              key={entry.key}
              role={entry.tone === "danger" ? "alert" : undefined}
              className={cn(
                "px-3 py-2 text-xs leading-relaxed",
                entry.tone === "danger" ? "text-niho-danger" : "text-niho-text-sub",
              )}
            >
              {entry.text}
            </p>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
