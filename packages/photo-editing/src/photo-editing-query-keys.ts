/**
 * 写真編集の react-query の鍵（NIHO camera C1 移行元設計）。編集面（packages/photo-editing）とアプリ（web の `queryKeys.admin.photoEditing`）が
 * 同じ鍵で読み書きする（読み直し・書き換えの接頭辞がそろう）。既存名の `spotId` は認可上の拠点 ID ではなく写真の出どころの
 * namespace（web は拠点、NIHO photo の個人クラウドは本人と local / cloud の組）として扱う。
 */
export const photoEditingQueryKeys = {
  /** 拠点で取り込んだプリセット（API） */
  spotPresets: (spotId: string | null | undefined) => ["admin", "photoEditing", "spotPresets", spotId] as const,
  /** 段 2 の wasm crate に同梱したプリセット（拠点によらない） */
  developBuiltinPresets: () => ["admin", "photoEditing", "builtinPresets", "develop"] as const,
  /** クラウドの写真置き場の一覧と使用量（API、ページ送り）。並び・絞り込みごとの一覧すべての接頭辞（読み直し・書き換えに使う） */
  cloudPhotos: (spotId: string | null | undefined) => ["admin", "photoEditing", "cloudPhotos", spotId] as const,
  /**
   * 並び（追加日 / 撮影日）と元の写真の有無・お気に入り・種類・補正済みで絞った一覧（移行元設計 / 移行元設計。`cloudPhotos` の下。
   * null は絞らない。種類・補正済みは省くと null にそろえる）。この Mac のフォルダの一覧（NIHO camera C3 移行元設計）は `folderId` も
   * 持つ（フォルダの無い一覧は鍵に入れない = クラウドの鍵は変わらない）
   */
  cloudPhotosList: (
    spotId: string | null | undefined,
    list: {
      sort: "added" | "captured";
      hasOriginal: boolean | null;
      favorite: boolean | null;
      albumId?: string | null;
      kind?: "raw" | "jpeg" | "heic" | null;
      edited?: boolean | null;
      folderId?: string | null;
      localSource?: "selected" | null;
    },
  ) =>
    [
      "admin",
      "photoEditing",
      "cloudPhotos",
      spotId,
      {
        sort: list.sort,
        hasOriginal: list.hasOriginal,
        favorite: list.favorite,
        albumId: list.albumId ?? null,
        kind: list.kind ?? null,
        edited: list.edited ?? null,
        ...(list.folderId ? { folderId: list.folderId } : {}),
        ...(list.localSource ? { localSource: list.localSource } : {}),
      },
    ] as const,
  /** クラウドのアルバム一覧（名前順、表紙と写真件数を含む） */
  cloudAlbums: (spotId: string | null | undefined) => ["admin", "photoEditing", "cloudAlbums", spotId] as const,
  /** クラウドの使用量と上限（設定サブタブの「クラウド」。一覧の 1 件だけを読んで `usage` を使う） */
  cloudUsage: (spotId: string | null | undefined) => ["admin", "photoEditing", "cloudUsage", spotId] as const,
  /** 写真のフォルダの木（`PhotoLibrary.folders.tree`。置き場ごと。NIHO camera C3 移行元設計） */
  folders: (place: "cloud" | "local", ownerScope?: string) =>
    ["admin", "photoEditing", "folders", place, ownerScope ?? null] as const,
  /** この Mac の「選んだ写真」の現在も読める件数。 */
  selectedPhotos: (place: "cloud" | "local", ownerScope?: string) =>
    ["admin", "photoEditing", "selectedPhotos", place, ownerScope ?? null] as const,
};
