"use client";

import { useRef, useState } from "react";
import { ListFilter } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "niho-ui/components/popover";
import type { BrowserCloudListFilter, BrowserCloudPhotoKind } from "../browser-photo-cloud-source";
import type { PhotoLibraryFlagFilter } from "../library/photo-library";
import { PHOTO_EDITING_FLAG_FILTER_OPTIONS, PHOTO_EDITING_FLAG_GROUP_LABEL } from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

import { BrowserPhotoPillRadioGroup, type BrowserPhotoPillOption } from "./browser-photo-editing-grid";
import { PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME } from "./photo-editing-button-classes";

/** 種類（「すべて」は絞らない。RAW は JPEG / PNG / TIFF / HEIC / HEIF 以外） */
const KIND_OPTIONS: readonly BrowserPhotoPillOption<BrowserCloudPhotoKind | null>[] = [
  { value: null, label: "すべて" },
  { value: "raw", label: "RAW" },
  { value: "jpeg", label: "JPEG" },
  { value: "heic", label: "HEIC" },
];

/** 補正（「すべて」は絞らない） */
const EDITED_OPTIONS: readonly BrowserPhotoPillOption<boolean | null>[] = [
  { value: null, label: "すべて" },
  { value: true, label: "補正済み" },
  { value: false, label: "未補正" },
];

/** 選別（「すべて」は絞らない。採用だけ / 却下を隠す は互いに排他。niho-photo#47） */
const FLAG_OPTIONS: readonly BrowserPhotoPillOption<PhotoLibraryFlagFilter | null>[] = [
  { value: null, label: PHOTO_EDITING_FLAG_FILTER_OPTIONS.all },
  { value: "pick", label: PHOTO_EDITING_FLAG_FILTER_OPTIONS.pick },
  { value: "notRejected", label: PHOTO_EDITING_FLAG_FILTER_OPTIONS.notRejected },
];

/** 群の見出し（読み上げは群の名前で読むので、見た目だけ） */
const HEADING_CLASS_NAME = "px-1 pb-1.5 text-xs font-bold text-niho-text-muted";

/**
 * 一覧の絞り込み（種類・補正済み。F5b 移行元設計 の画面 2 本目・移行時の設計文書）。上に残る行の並びの
 * 切り替えのすぐ右のアイコンのボタンで、押すとボタンの下にパネルを出す（錨の左端から出し、右にはみ出すなら画面の右端に寄せる）。
 * 選んだらすぐ掛かり、パネルは開いたまま（「適用」は置かない）。条件のあるときだけボタンを薄い緑にして数を添え、パネルの下に
 * 「解除」を出す（条件が無いときは何も添えない）。Esc（ボタンへフォーカスを戻す）・パネルの外を押すと閉じる。場所を「記事の画像」に
 * 替えた・1 枚の表示へ移ったときは、ボタンごと外れて閉じる。選別のフラグを持つ写真の出どころ（`flags`）だけ、3 つ目の群「選別」
 * （すべて / 採用だけ / 却下を隠す。niho-photo#47）を出す。
 */
export function BrowserPhotoListFilterControl(props: {
  /** 今の場所で掛けている条件 */
  filter: BrowserCloudListFilter;
  /** 有効な条件の数（0〜3） */
  count: number;
  /** 選別の群を出す（`capabilities.flags`。省くと出さない） */
  flags?: boolean;
  onChange: (patch: Partial<BrowserCloudListFilter>) => void;
  /** 条件を全部外す */
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const active = props.count > 0;
  const firstRadio = () => panelRef.current?.querySelector<HTMLButtonElement>('[role="radio"]') ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="絞り込み"
          title="絞り込み"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "relative inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-full px-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink",
            // 見た目は 32px のまま、押せる範囲だけ広げる（縦 44px。横は左の並びの切り替え・右の「クラウドから消す」の押せる範囲に
            // 重ねない幅まで）
            "after:absolute after:-inset-y-1.5 after:-left-0.5 after:-right-1.5 after:content-['']",
            active ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text-muted hover:text-niho-text",
          )}
        >
          <ListFilter className="h-[18px] w-[18px]" aria-hidden />
          {active ? <span className="text-xs font-bold tabular-nums">{props.count}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={panelRef}
        aria-label="絞り込み"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        // 開いたら選んでいる選択肢へ（最初の群。条件が無ければ「すべて」）
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (panelRef.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]') ?? firstRadio())?.focus();
        }}
        className="w-max max-w-[calc(100vw-1rem)] border-niho-border bg-white p-2 shadow-lg backdrop-blur-none"
      >
        <p aria-hidden className={HEADING_CLASS_NAME}>
          種類
        </p>
        <BrowserPhotoPillRadioGroup
          label="種類"
          options={KIND_OPTIONS}
          value={props.filter.kind}
          onChange={(kind) => props.onChange({ kind })}
          className="flex-wrap gap-y-3"
        />
        <p aria-hidden className={cn(HEADING_CLASS_NAME, "mt-3")}>
          補正
        </p>
        <BrowserPhotoPillRadioGroup
          label="補正"
          options={EDITED_OPTIONS}
          value={props.filter.edited}
          onChange={(edited) => props.onChange({ edited })}
          className="flex-wrap gap-y-3"
        />
        {props.flags ? (
          <>
            <p aria-hidden className={cn(HEADING_CLASS_NAME, "mt-3")}>
              {PHOTO_EDITING_FLAG_GROUP_LABEL}
            </p>
            <BrowserPhotoPillRadioGroup
              label={PHOTO_EDITING_FLAG_GROUP_LABEL}
              options={FLAG_OPTIONS}
              value={props.filter.flag ?? null}
              onChange={(flag) => props.onChange({ flag })}
              className="flex-wrap gap-y-3"
            />
          </>
        ) : null}
        {active ? (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                // 押すと「解除」は消えるので、フォーカスは最初の群の「すべて」へ移す
                firstRadio()?.focus();
                props.onClear();
              }}
              className={PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME}
            >
              解除
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
