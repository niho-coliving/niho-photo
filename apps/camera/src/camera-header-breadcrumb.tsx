import { ChevronRight, Folder } from "lucide-react";

import { usePhotoEditingBreadcrumb } from "niho-photo-editing/photo-editing-breadcrumb-store";

/**
 * 窓の上の帯に出す、表示中の場所と写真の名前（編集面が `photo-editing-breadcrumb-store` に置く「この Mac › フォルダ › 写真」）。
 * 公開移植前の内部構成については docs/migration/mac-client.md を参照。
 * 見た目も同じにする。フォルダの段を押すと一覧へ戻る（編集面が `onSelect` を置く）。
 */
export function CameraHeaderBreadcrumb() {
  const items = usePhotoEditingBreadcrumb();
  if (!items || items.length === 0) return null;
  return (
    <nav aria-label="表示中の場所" className="flex h-[22px] min-w-0 items-center">
      <ol className="flex min-w-0 items-center whitespace-nowrap">
        {items[0].icon ? (
          <li aria-hidden className="flex shrink-0 items-center pl-1.5 pr-px text-niho-text-muted">
            <Folder className="h-3.5 w-3.5" />
          </li>
        ) : null}
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={item.key} className={last ? "flex min-w-0 items-center" : "flex shrink-0 items-center"}>
              {index > 0 ? <ChevronRight className="mx-0.5 h-3.5 w-3.5 shrink-0 text-niho-text-muted" aria-hidden /> : null}
              {last ? (
                <span
                  aria-current="page"
                  title={item.label}
                  className="max-w-[min(40vw,360px)] truncate text-sub font-bold text-niho-text"
                >
                  {item.label}
                </span>
              ) : item.onSelect ? (
                <button
                  type="button"
                  title={item.label}
                  aria-label={item.ariaLabel}
                  onClick={item.onSelect}
                  className="max-w-[170px] truncate rounded-lg px-1.5 py-0.5 text-sub font-bold text-niho-text-sub transition hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
                >
                  {item.label}
                </button>
              ) : (
                <span title={item.label} className="max-w-[170px] truncate px-1.5 text-sub font-bold text-niho-text-sub">
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
