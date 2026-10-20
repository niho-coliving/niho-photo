import type { ReactNode } from "react";
import { Cloud, Folder, FolderPlus } from "lucide-react";

import { cn } from "niho-ui/cn";

import { PHOTO_EDITING_ADD_FOLDER_EMPTY_TEXT, PHOTO_EDITING_ADD_FOLDER_LABEL } from "../photo-editing-copy";
import { PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME } from "./photo-editing-button-classes";

/**
 * 写真編集の中央（グリッド・1 枚）の空状態（移行元設計・モック photo-editing-cloud-grid-v1）。今の状態と次の一歩を
 * そろえて出す（design-guide §6）。常設の説明文は足さない。
 */

/**
 * はじめて（クラウドも空で、この Mac のフォルダ・写真も無い）・「追加した写真」が空のとき。追加の主ボタン（左の見出しの
 * 「＋」と同じ動き）を添える。
 */
export function PhotoEditingAddPhotosEmptyState(props: { action: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3.5 text-center">
      <Folder className="h-11 w-11 text-niho-text-muted" strokeWidth={1.5} aria-hidden />
      <p className="text-sub font-bold leading-relaxed text-niho-text-sub">
        フォルダや写真を追加すると、
        <br />
        ここで編集できます。
      </p>
      {props.action}
    </div>
  );
}

/**
 * クラウドの「写真」だけが空（この Mac のフォルダ・写真はある）: 追加の仕方の 1 行を添える。「記事の画像」が空のときは 1 行だけ
 * （ブラウザ版と同じ文。記事の画像はここから足すものではない）。
 */
export function PhotoEditingCloudEmptyState(props: { section: "photos" | "articleImages" }) {
  return (
    <div className="flex flex-col items-center gap-3.5 text-center">
      <Cloud className="h-11 w-11 text-niho-text-muted" strokeWidth={1.5} aria-hidden />
      {props.section === "photos" ? (
        <p className="text-sub font-bold leading-relaxed text-niho-text-muted">
          クラウドに写真はありません
          <span className="mt-0.5 block text-xs">写真を選んで「書き出す」から追加できます</span>
        </p>
      ) : (
        <p className="text-sub font-bold leading-relaxed text-niho-text-muted">記事の画像はありません</p>
      )}
    </div>
  );
}

/**
 * この Mac のフォルダが 1 つも無い（写真の出どころに `folders` があるときだけ。NIHO camera C3 移行元設計）: 見出しと、元のファイルを
 * 動かさない・書き換えないことの 1 文、左の見出しの「＋」と同じ動きの主ボタン。
 */
export function PhotoEditingAddFolderEmptyState(props: { disabled?: boolean; onAdd: () => void }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <FolderPlus className="h-11 w-11 text-niho-text-muted" strokeWidth={1.5} aria-hidden />
      <h3 className="text-sub font-bold text-niho-text">{PHOTO_EDITING_ADD_FOLDER_LABEL}</h3>
      <p className="text-sub leading-relaxed text-niho-text-sub">{PHOTO_EDITING_ADD_FOLDER_EMPTY_TEXT}</p>
      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onAdd}
        className={cn(PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME, "min-h-11")}
      >
        {PHOTO_EDITING_ADD_FOLDER_LABEL}
      </button>
    </div>
  );
}

/** 写真の無いフォルダ。 */
export function PhotoEditingFolderEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3.5 text-center">
      <Folder className="h-11 w-11 text-niho-text-muted" strokeWidth={1.5} aria-hidden />
      <p className="text-sub font-bold leading-relaxed text-niho-text-muted">このフォルダには写真がありません</p>
    </div>
  );
}

/** 一覧を読み込めなかった（クラウドの一覧）。理由と「再読み込み」。 */
export function PhotoEditingLoadError(props: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="max-w-sm text-center text-sub leading-relaxed text-[#8C3425]">
      {props.message}
      <button type="button" onClick={props.onRetry} className="ml-2 font-bold text-niho-text-sub underline">
        再読み込み
      </button>
    </div>
  );
}
