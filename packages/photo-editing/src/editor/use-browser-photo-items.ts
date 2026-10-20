"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BROWSER_CLOUD_NO_LIST_FILTER,
  appliedBrowserCloudListFilter,
  browserCloudPlaceAlbumId,
  browserPlaceFolderId,
  countBrowserCloudListFilter,
  isBrowserCloudPhotoInFilter,
  type BrowserCloudListFilter,
  type BrowserCloudPlace,
} from "../browser-photo-cloud-source";
import { usePhotoEditingListSort, type PhotoEditingListSort } from "../photo-editing-local-settings";
import type { PhotoLibraryItem, PhotoLibraryPhoto } from "../library/photo-library";

import {
  buildBrowserItems,
  isBrowserItemInPlace,
  toListedPhoto,
  type AddedPhoto,
  type BrowserItem,
} from "./browser-photo-editing-model";

/**
 * 一覧の見方（木の場所と並びと絞り込み）。サーバーの一覧を絞る条件なので、一覧を読む前（`usePhotoCloudPhotos` の引数）に決める。
 * 並びはこの端末に覚える（`usePhotoEditingListSort`）。絞り込みの条件（種類・補正済み。F5b 移行元設計）は覚えない（ページを閉じたら
 * 消える）。条件は「写真」「お気に入り」だけに掛け、「記事の画像」を見ている間は掛けない（選んだ条件は残り、戻るとまた掛かる）。
 *
 * - `filter` は今の場所で掛けている条件、`filterCount` はその数（0〜2。state にしない）
 * - `listKey` は一覧の中身（場所・並び・掛けている条件）。替わったらグリッドを先頭へ戻す
 */
export function useBrowserPhotoListView() {
  const [place, setPlace] = useState<BrowserCloudPlace>("photos");
  const [sort, setSort] = usePhotoEditingListSort();
  const [chosenFilter, setChosenFilter] = useState<BrowserCloudListFilter>(BROWSER_CLOUD_NO_LIST_FILTER);
  const changeFilter = useCallback((patch: Partial<BrowserCloudListFilter>) => {
    setChosenFilter((current) => {
      const next = { ...current, ...patch };
      return next.kind === current.kind && next.edited === current.edited ? current : next;
    });
  }, []);
  const clearFilter = useCallback(() => setChosenFilter(BROWSER_CLOUD_NO_LIST_FILTER), []);
  const filter = appliedBrowserCloudListFilter(place, chosenFilter);
  const filterCount = countBrowserCloudListFilter(filter);
  const listKey = `${place}:${sort}:${filter.kind ?? ""}:${filter.edited ?? ""}`;
  return { place, setPlace, sort, setSort, filter, filterCount, changeFilter, clearFilter, listKey };
}

export type BrowserPhotoListView = ReturnType<typeof useBrowserPhotoListView>;

/**
 * 一覧の写真（クラウドの一覧の前に、このタブで追加した写真と URL で開いた写真を並べる）と、木の場所・並び・選んでいる 1 枚。
 * 追加した写真の手元のプレビュー（object URL）は、一覧を読み直して同じ行が載ったら・画面を閉じたら手放す。
 * `photos` は今の場所・並び・絞り込みでサーバーが絞った一覧（移行元設計 / 移行元設計）。追加した写真・URL で開いた写真は場所に関わらず並べ、
 * 場所と絞り込みの条件で選り分ける（{@link isBrowserItemInPlace}・{@link isBrowserCloudPhotoInFilter}。サーバーと同じ条件）。
 * `preserveSelectedItem` はルーペ表示中に補正状態が変わっても選択写真を保ち、一覧へ戻った時点で絞り込みを再適用する。
 */
export function useBrowserPhotoItems(
  photos: PhotoLibraryItem[],
  view: BrowserPhotoListView,
  options: { preserveSelectedItem?: boolean } = {},
) {
  const { place, setPlace, sort, setSort, filter, clearFilter } = view;
  const { preserveSelectedItem = false } = options;
  const placeRef = useRef(place);
  placeRef.current = place;
  const [deepLinkedPhoto, setDeepLinkedPhoto] = useState<PhotoLibraryItem | null>(null);
  const [addedPhotos, setAddedPhotos] = useState<AddedPhoto[]>([]);
  const addedPhotosRef = useRef<AddedPhoto[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // 一覧（読み込んだ分）の前に、このタブで追加した写真と、URL で開いた写真（一覧の先頭のページに無いとき）を並べる
  const allItems = useMemo<BrowserItem[]>(
    () => buildBrowserItems(addedPhotos, photos, deepLinkedPhoto, sort),
    [addedPhotos, photos, deepLinkedPhoto, sort],
  );
  const allItemsRef = useRef(allItems);
  allItemsRef.current = allItems;
  const listedPhotoIds = useMemo(() => new Set(photos.map((photo) => photo.id)), [photos]);
  // アルバム・この Mac のフォルダは行だけでは入るか分からないので、その一覧に載った写真だけを出す
  const listedOnly = browserCloudPlaceAlbumId(place) !== null || browserPlaceFolderId(place) !== null;
  const items = useMemo(
    () =>
      allItems.filter(
        (item) =>
          (!listedOnly || listedPhotoIds.has(item.photo.id)) &&
          isBrowserItemInPlace(item, place) &&
          (isBrowserCloudPhotoInFilter(item.photo, filter) || (preserveSelectedItem && item.key === selectedKey)),
      ),
    [allItems, filter, listedOnly, listedPhotoIds, place, preserveSelectedItem, selectedKey],
  );
  const selectedItem = items.find((item) => item.key === selectedKey) ?? null;

  const commitAddedPhotos = useCallback((next: AddedPhoto[]) => {
    addedPhotosRef.current = next;
    setAddedPhotos(next);
  }, []);

  const upsertAddedPhoto = useCallback(
    (photo: PhotoLibraryPhoto, preview: Blob | null, isAdding: boolean) => {
      const current = addedPhotosRef.current;
      const existing = current.find((entry) => entry.photo.id === photo.id);
      const previewUrl = existing?.previewUrl ?? (preview ? URL.createObjectURL(preview) : null);
      commitAddedPhotos([
        { photo: toListedPhoto(photo), previewUrl, adding: isAdding },
        ...current.filter((entry) => entry.photo.id !== photo.id),
      ]);
    },
    [commitAddedPhotos],
  );

  const removeAddedPhoto = useCallback(
    (photoId: string) => {
      const current = addedPhotosRef.current;
      const removed = current.find((entry) => entry.photo.id === photoId);
      if (!removed) return;
      if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      commitAddedPhotos(current.filter((entry) => entry.photo.id !== photoId));
    },
    [commitAddedPhotos],
  );

  // 一覧の外の手元の写真（URL で開いた・このタブで追加した）の行も、一覧と同じく書き換える（お気に入りの付け外し。持ち方は変えない）
  const patchLocalPhoto = useCallback(
    (photoId: string, patch: Pick<PhotoLibraryItem, "favorite">) => {
      setDeepLinkedPhoto((current) => (current?.id === photoId ? { ...current, ...patch } : current));
      const current = addedPhotosRef.current;
      if (!current.some((entry) => entry.photo.id === photoId)) return;
      commitAddedPhotos(
        current.map((entry) => (entry.photo.id === photoId ? { ...entry, photo: { ...entry.photo, ...patch } } : entry)),
      );
    },
    [commitAddedPhotos],
  );

  // 一覧を読み直して同じ行（追加した後の状態）が載ったら、手元の写真とプレビューを手放す
  useEffect(() => {
    const listedById = new Map(photos.map((photo) => [photo.id, photo]));
    const current = addedPhotosRef.current;
    const caughtUp = current.filter((entry) => {
      const listed = listedById.get(entry.photo.id);
      return !entry.adding && listed !== undefined && listed.hasOriginal === entry.photo.hasOriginal;
    });
    if (caughtUp.length === 0) return;
    for (const entry of caughtUp) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    commitAddedPhotos(current.filter((entry) => !caughtUp.includes(entry)));
  }, [addedPhotos, photos, commitAddedPhotos]);

  useEffect(
    () => () => {
      for (const entry of addedPhotosRef.current) {
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      }
    },
    [],
  );

  return {
    place,
    setPlace,
    placeRef,
    sort,
    setSort,
    // 写真を追加する・URL で写真を開くときに絞り込みの条件を外す（その写真が見えるように）
    clearFilter,
    deepLinkedPhoto,
    setDeepLinkedPhoto,
    selectedKey,
    setSelectedKey,
    allItems,
    allItemsRef,
    items,
    selectedItem,
    upsertAddedPhoto,
    removeAddedPhoto,
    patchLocalPhoto,
  };
}

export type BrowserPhotoItems = ReturnType<typeof useBrowserPhotoItems>;
export type { PhotoEditingListSort };
