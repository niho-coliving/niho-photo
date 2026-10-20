"use client";

import { NihoHeart } from "niho-ui/components/niho-heart";
import { cn } from "niho-ui/cn";

/** ♥ の操作の名前（読み上げ・title。付いているかは aria-pressed で伝える） */
export const BROWSER_PHOTO_FAVORITE_LABEL = "お気に入り";

/** ♥ の操作に渡すもの（面が選んでいる 1 枚・開いている 1 枚から決め、下段とスマホの 1 枚の層に同じものを渡す）。 */
export type BrowserPhotoFavoriteControl = {
  /** 対象の写真（「写真」でなければ null。記事の画像・追加中・何も選んでいないときは押せない） */
  photoId: string | null;
  favorite: boolean;
  /** 送っている間（2 回目を受けない） */
  busy: boolean;
  /** 閲覧のみ・書き出し・消している途中 */
  disabled: boolean;
  onToggle: () => void;
};

/**
 * お気に入り（♥）の付け外し（F5b 移行元設計）。ブランドのハートを 44px の丸いボタンに入れる。名前は常に「お気に入り」で、状態は
 * aria-pressed。ハートは付いた瞬間に花びらを散らすので、写真ごとに作り直す（選ぶ写真を替えただけでは散らさない）。
 */
export function BrowserPhotoFavoriteButton(props: BrowserPhotoFavoriteControl & { className?: string }) {
  const unavailable = props.photoId === null || props.disabled;
  const pressed = props.photoId !== null && props.favorite;
  return (
    <button
      type="button"
      aria-label={BROWSER_PHOTO_FAVORITE_LABEL}
      title={BROWSER_PHOTO_FAVORITE_LABEL}
      aria-pressed={pressed}
      aria-busy={props.busy || undefined}
      disabled={unavailable || props.busy}
      onClick={props.onToggle}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink enabled:hover:bg-niho-pale/60 disabled:cursor-not-allowed",
        // 送っている間は押せないだけで薄くしない（押した直後のハートをそのまま見せる）
        unavailable && "opacity-40",
        props.className,
      )}
    >
      <NihoHeart key={props.photoId ?? ""} liked={pressed} size={22} />
    </button>
  );
}
