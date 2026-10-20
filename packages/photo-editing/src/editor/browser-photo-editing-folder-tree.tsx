"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Folder, FolderOpen, Images, Laptop, MoreHorizontal, Plus } from "lucide-react";

import type { PhotoLibraryFolder } from "../library/photo-library";
import {
  PHOTO_EDITING_ADD_FOLDER_LABEL,
  PHOTO_EDITING_ADD_SELECTED_PHOTOS_LABEL,
  PHOTO_EDITING_FOLDERS_LOAD_FAILED_TEXT,
  PHOTO_EDITING_FORGET_FOLDER_LABEL,
  PHOTO_EDITING_LOCAL_PLACE_LABEL,
  PHOTO_EDITING_FORGET_SELECTED_PHOTOS_LABEL,
  PHOTO_EDITING_SELECTED_PHOTOS_LABEL,
  photoEditingFolderMenuLabel,
  photoEditingFolderToggleLabel,
} from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

import { PhotoEditingMenu } from "./photo-editing-menu";
import { photoLibraryFolderPath } from "./use-browser-photo-folders";

/**
 * この Mac のフォルダの左の木（写真の出どころに `folders` があるときだけ。NIHO camera C3 移行元設計。PC の幅だけ出し、狭い幅の上段の
 * 切り替えは出さない）。見出し「この Mac」（選べない。クラウドの「クラウド」と同じ見た目）の右に「＋」（フォルダを追加）、その下に
 * 覚えたフォルダの木（足した順・入れ子）。子のあるフォルダは開閉でき、行を押すとそのフォルダを選ぶ。選んでいるフォルダの上の段は
 * 開いておく。根のフォルダの「⋯」に「一覧から外す」（フォルダと写真は消さない。確かめは画面が出す）。
 */
export function BrowserPhotoEditingFolderTree(props: {
  /** 覚えたフォルダの木（読むまでは null） */
  folders: readonly PhotoLibraryFolder[] | null;
  /** 木を読めなかった */
  error: boolean;
  selectedFolderId: string | null;
  selectedPhotos?: boolean;
  /** `null` は読み込み中。0 のとき行を出さない。 */
  selectedPhotoCount?: number | null;
  /** 「＋」と「⋯」を押せない（書き出し・一括の補正の途中など） */
  disabled?: boolean;
  onAddFolder: () => void;
  onAddPhotos?: () => void;
  onSelectFolder: (folderId: string) => void;
  onSelectSelectedPhotos?: () => void;
  onForgetFolder: (folder: PhotoLibraryFolder) => void;
  onForgetSelectedPhotos?: () => void;
  onRetry: () => void;
  /** 木の底に出す 1 行（NIHO photo の「版」） */
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { folders, selectedFolderId } = props;
  const addItems = [
    {
      key: "folder",
      label: PHOTO_EDITING_ADD_FOLDER_LABEL,
      icon: <FolderOpen className="h-4 w-4" aria-hidden />,
      disabled: props.disabled,
      onSelect: props.onAddFolder,
    },
    ...(props.onAddPhotos
      ? [
          {
            key: "photos",
            label: PHOTO_EDITING_ADD_SELECTED_PHOTOS_LABEL,
            icon: <Images className="h-4 w-4" aria-hidden />,
            disabled: props.disabled,
            onSelect: props.onAddPhotos,
          },
        ]
      : []),
  ];
  // 選んだフォルダが閉じた段の下に隠れないよう、上の段を開く（自分で閉じた段は、選び直すまで閉じたまま）
  useEffect(() => {
    if (!folders || !selectedFolderId) return;
    const ancestors = photoLibraryFolderPath(folders, selectedFolderId).slice(0, -1);
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      if (ancestors.every((folder) => current.has(folder.folderId))) return current;
      const next = new Set(current);
      for (const folder of ancestors) next.add(folder.folderId);
      return next;
    });
  }, [folders, selectedFolderId]);
  const toggle = (folderId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });

  const renderNodes = (nodes: readonly PhotoLibraryFolder[], depth: number) => (
    <ul className={cn("space-y-1", depth > 0 && "mt-1 pl-3.5")}>
      {nodes.map((folder) => {
        const hasChildren = folder.children.length > 0;
        const open = hasChildren && expanded.has(folder.folderId);
        const selected = folder.folderId === selectedFolderId;
        return (
          <li key={folder.folderId}>
            <div className="flex min-w-0 items-center gap-1">
              {hasChildren ? (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={photoEditingFolderToggleLabel(folder.name, open)}
                  title={photoEditingFolderToggleLabel(folder.name, open)}
                  onClick={() => toggle(folder.folderId)}
                  className="flex h-11 w-6 shrink-0 items-center justify-center rounded-lg text-niho-text-muted hover:text-niho-text"
                >
                  <ChevronRight className={cn("h-4 w-4 transition", open && "rotate-90")} aria-hidden />
                </button>
              ) : (
                <span aria-hidden className="w-6 shrink-0" />
              )}
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                title={folder.name}
                onClick={() => props.onSelectFolder(folder.folderId)}
                className={cn(
                  "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 text-left text-sub font-bold",
                  selected ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text hover:bg-niho-pale/60",
                )}
              >
                <Folder className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              </button>
              {depth === 0 ? (
                <PhotoEditingMenu
                  variant="browser"
                  align="end"
                  items={[
                    {
                      key: "forget",
                      label: PHOTO_EDITING_FORGET_FOLDER_LABEL,
                      disabled: props.disabled,
                      opensDialog: true,
                      onSelect: () => props.onForgetFolder(folder),
                    },
                  ]}
                >
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-label={photoEditingFolderMenuLabel(folder.name)}
                    title={photoEditingFolderMenuLabel(folder.name)}
                    className="flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-muted hover:text-niho-text"
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </button>
                </PhotoEditingMenu>
              ) : null}
            </div>
            {open ? renderNodes(folder.children, depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <aside aria-label="写真の場所" className="hidden min-h-0 flex-col overflow-y-auto border-r border-niho-border bg-[var(--photo-editing-surface,white)] p-3 lg:flex">
      <div className="mb-1 flex min-h-11 items-center justify-between gap-2 pr-1">
        <h3 className="flex min-h-9 min-w-0 items-center gap-2 px-3 text-sub font-bold text-niho-text-sub">
          <Laptop className="h-4 w-4 shrink-0 text-niho-text-muted" aria-hidden />
          {PHOTO_EDITING_LOCAL_PLACE_LABEL}
        </h3>
        {props.onAddPhotos ? <PhotoEditingMenu variant="browser" align="end" items={addItems}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-label="フォルダや写真を追加"
            title="フォルダや写真を追加"
            disabled={props.disabled}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-accent-ink transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-5 w-5" aria-hidden />
          </button>
        </PhotoEditingMenu> : (
          <button
            type="button"
            aria-label={PHOTO_EDITING_ADD_FOLDER_LABEL}
            title={PHOTO_EDITING_ADD_FOLDER_LABEL}
            disabled={props.disabled}
            onClick={props.onAddFolder}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-accent-ink transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>
      {props.selectedPhotoCount != null && props.selectedPhotoCount > 0 ? (
        <div className="mb-1 flex min-w-0 items-center gap-1">
          <button
            type="button"
            aria-current={props.selectedPhotos ? "true" : undefined}
            onClick={props.onSelectSelectedPhotos}
            className={cn(
              "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 text-left text-sub font-bold",
              props.selectedPhotos ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text hover:bg-niho-pale/60",
            )}
          >
            <Images className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{PHOTO_EDITING_SELECTED_PHOTOS_LABEL}</span>
            <span className="tabular-nums text-xs">{props.selectedPhotoCount}</span>
          </button>
          <PhotoEditingMenu
            variant="browser"
            align="end"
            items={[
              {
                key: "forget-selected",
                label: PHOTO_EDITING_FORGET_SELECTED_PHOTOS_LABEL,
                disabled: props.disabled,
                opensDialog: true,
                onSelect: props.onForgetSelectedPhotos ?? (() => undefined),
              },
            ]}
          >
            <button
              type="button"
              aria-haspopup="menu"
              aria-label={`${PHOTO_EDITING_SELECTED_PHOTOS_LABEL}のメニュー`}
              title={`${PHOTO_EDITING_SELECTED_PHOTOS_LABEL}のメニュー`}
              className="flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-muted hover:text-niho-text"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </button>
          </PhotoEditingMenu>
        </div>
      ) : null}
      {props.error ? (
        <div className="space-y-1 px-3 py-2 text-xs text-niho-danger">
          <p>{PHOTO_EDITING_FOLDERS_LOAD_FAILED_TEXT}</p>
          <button type="button" onClick={props.onRetry} className="min-h-11 font-bold underline">
            もう一度読み込む
          </button>
        </div>
      ) : folders === null ? (
        <p className="px-3 py-2 text-xs text-niho-text-muted">読み込み中…</p>
      ) : (
        renderNodes(folders, 0)
      )}
      {props.footer ? (
        <div className="sticky bottom-0 -mx-3 -mb-3 mt-auto border-t border-niho-border bg-[var(--photo-editing-surface,white)] px-3 py-2 text-xs text-niho-text-muted">
          {props.footer}
        </div>
      ) : null}
    </aside>
  );
}
