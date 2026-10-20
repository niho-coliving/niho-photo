/**
 * 写真編集タブの一覧（フィルムストリップ・グリッド）の選択（owner 決定 7、移行元設計 → 移行元設計）。
 *
 * - 表示中（`activeId`）: 1 枚（編集）のプレビューとスライダーの対象の 1 枚。グリッドではキーボードで移る起点
 * - 選択中（`selectedIds`）: プリセットと「書き出す」の対象。1 枚では表示中の 1 枚を必ず含む（グリッドでは Esc で
 *   選択だけを解ける）。選んだ順に並べる（⌘ で足した写真は後ろへ、Shift の範囲は起点から押した写真への向きで）
 * - 起点（`anchorId`）: Shift で範囲を選ぶときの起点。ふつうのクリックと ⌘ クリックで決まる
 *
 * 操作は macOS の一覧と同じ: クリック = その 1 枚だけ、⌘ クリック = 足す・外す（最後の 1 枚は外さない）、
 * Shift クリック = 起点からの範囲（⌘ も押していれば今の選択に足す）、⌘A = すべて。
 * どれも押した写真（⌘A は今の写真）を表示中にする。
 */

export type PhotoEditingSelection = {
  activeId: string | null;
  selectedIds: readonly string[];
  anchorId: string | null;
};

export type PhotoEditingSelectModifiers = {
  /** ⌘（Windows なら Ctrl）: 1 枚ずつ足す・外す */
  toggle: boolean;
  /** Shift: 起点からの範囲 */
  range: boolean;
};

export const EMPTY_PHOTO_EDITING_SELECTION: PhotoEditingSelection = Object.freeze({
  activeId: null,
  selectedIds: Object.freeze([]) as readonly string[],
  anchorId: null,
});

/** その 1 枚だけを選んで表示する（写真が無ければ空）。 */
export function singlePhotoEditingSelection(photoId: string | null): PhotoEditingSelection {
  if (!photoId) return EMPTY_PHOTO_EDITING_SELECTION;
  return { activeId: photoId, selectedIds: [photoId], anchorId: photoId };
}

function rangeBetween(orderedIds: readonly string[], fromId: string, toId: string): string[] {
  const from = orderedIds.indexOf(fromId);
  const to = orderedIds.indexOf(toId);
  if (from < 0 || to < 0) return [toId];
  const step = from <= to ? 1 : -1;
  const ids: string[] = [];
  for (let index = from; ; index += step) {
    ids.push(orderedIds[index]);
    if (index === to) break;
  }
  return ids;
}

function union(base: readonly string[], additions: readonly string[]): string[] {
  const ids = [...base];
  for (const id of additions) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 一覧の写真を押したとき（クリック・キーボードの Enter / Space）。 */
export function selectPhotoEditingPhoto(
  selection: PhotoEditingSelection,
  orderedIds: readonly string[],
  targetId: string,
  modifiers: PhotoEditingSelectModifiers,
): PhotoEditingSelection {
  if (!orderedIds.includes(targetId)) return selection;

  if (modifiers.range) {
    const anchorId = [selection.anchorId, selection.activeId].find(
      (id): id is string => id !== null && orderedIds.includes(id),
    ) ?? targetId;
    const range = rangeBetween(orderedIds, anchorId, targetId);
    return {
      activeId: targetId,
      selectedIds: modifiers.toggle ? union(selection.selectedIds, range) : range,
      anchorId,
    };
  }

  if (modifiers.toggle) {
    if (!selection.selectedIds.includes(targetId)) {
      return { activeId: targetId, selectedIds: [...selection.selectedIds, targetId], anchorId: targetId };
    }
    // 最後の 1 枚は外さない（表示中の写真は必ず選択に入っている）
    if (selection.selectedIds.length <= 1) return selection;
    const selectedIds = selection.selectedIds.filter((id) => id !== targetId);
    const activeId =
      selection.activeId === targetId || selection.activeId === null
        ? selectedIds[selectedIds.length - 1]
        : selection.activeId;
    const anchorId = selection.anchorId === targetId ? activeId : selection.anchorId;
    return { activeId, selectedIds, anchorId };
  }

  return singlePhotoEditingSelection(targetId);
}

/**
 * 開いた写真を今の選択に足し、`activeId` を表示する（記事制作の「画像を追加」移行元設計。開いた写真はどれも
 * 記事に入れる対象にする）。何も選んでいなければ開いた写真だけを選ぶ。
 */
export function addPhotoEditingPhotosToSelection(
  selection: PhotoEditingSelection,
  photoIds: readonly string[],
  activeId: string,
): PhotoEditingSelection {
  return { activeId, selectedIds: union(union(selection.selectedIds, photoIds), [activeId]), anchorId: activeId };
}

/**
 * 選択をこの写真だけにする（選んだ順はこの並び）。表示中の写真が残るなら表示は変えず、残らなければ最初の
 * 1 枚を表示する。記事に入れられなかった写真だけを選び直すときに使う。
 */
export function restrictPhotoEditingSelection(
  selection: PhotoEditingSelection,
  photoIds: readonly string[],
): PhotoEditingSelection {
  if (photoIds.length === 0) return selection;
  const activeId =
    selection.activeId !== null && photoIds.includes(selection.activeId) ? selection.activeId : photoIds[0];
  const anchorId =
    selection.anchorId !== null && photoIds.includes(selection.anchorId) ? selection.anchorId : activeId;
  return { activeId, selectedIds: [...photoIds], anchorId };
}

/** ⌘A。すべての写真を選ぶ（表示中の写真は変えない）。 */
export function selectAllPhotoEditingPhotos(
  selection: PhotoEditingSelection,
  orderedIds: readonly string[],
): PhotoEditingSelection {
  if (orderedIds.length === 0) return selection;
  const activeId = selection.activeId !== null && orderedIds.includes(selection.activeId)
    ? selection.activeId
    : orderedIds[0];
  const anchorId = selection.anchorId !== null && orderedIds.includes(selection.anchorId)
    ? selection.anchorId
    : activeId;
  return { activeId, selectedIds: [...orderedIds], anchorId };
}

/**
 * 選択を `max` 枚までに切り詰める（フォルダの写真は選んだ写真をエンジンで開くので、一度に選べる枚数を抑える）。
 * 選んだ順の先頭から残す（Shift の範囲なら起点側、⌘A なら一覧の先頭）。`keepActive`（⌘A）なら表示中の写真は必ず残し、
 * そうでなければ表示中の写真が外れたら残した最後の写真を表示する。`max` 枚以内なら同じ選択を返す。
 */
export function limitPhotoEditingSelection(
  selection: PhotoEditingSelection,
  max: number,
  options: { keepActive: boolean } = { keepActive: false },
): PhotoEditingSelection {
  if (max < 1 || selection.selectedIds.length <= max) return selection;
  let selectedIds = selection.selectedIds.slice(0, max);
  let activeId = selection.activeId;
  if (activeId !== null && !selectedIds.includes(activeId)) {
    if (options.keepActive) selectedIds = [...selectedIds.slice(0, max - 1), activeId];
    else activeId = selectedIds[selectedIds.length - 1];
  }
  const anchorId =
    selection.anchorId !== null && selectedIds.includes(selection.anchorId) ? selection.anchorId : activeId;
  return { activeId, selectedIds, anchorId };
}

/** 一覧で `fromId` の `offset` 個先の写真（端を越えたら null）。キーボードの ←→（↑↓）に使う。 */
export function adjacentPhotoEditingPhotoId(
  orderedIds: readonly string[],
  fromId: string,
  offset: number,
): string | null {
  const index = orderedIds.indexOf(fromId);
  if (index < 0) return null;
  return orderedIds[index + offset] ?? null;
}

/**
 * 矢印キーで移る数（移行元設計）。フィルムストリップ（`columns` が 1）は ←→ も ↑↓ も隣、グリッドは ↑↓ で列の数だけ前後
 * （上下の行の同じ列）。矢印キーでなければ null。
 */
export function photoEditingArrowOffset(key: string, columns: number): number | null {
  const rowStep = Math.max(1, Math.floor(columns));
  switch (key) {
    case "ArrowRight":
      return 1;
    case "ArrowLeft":
      return -1;
    case "ArrowDown":
      return rowStep;
    case "ArrowUp":
      return -rowStep;
    default:
      return null;
  }
}

/**
 * 矢印キーで移る先。表示中の写真が無ければ（グリッドで何も選んでいない）一覧の先頭、端を越えたら null。
 */
export function movePhotoEditingPhotoId(
  orderedIds: readonly string[],
  fromId: string | null,
  offset: number,
): string | null {
  if (fromId === null || !orderedIds.includes(fromId)) return orderedIds[0] ?? null;
  return adjacentPhotoEditingPhotoId(orderedIds, fromId, offset);
}

/**
 * グリッドの Esc（移行元設計）: 選択だけを解く。表示中の写真（`activeId`）は残し、1 枚（編集）に戻したときはそれを出す。
 */
export function clearPhotoEditingSelection(selection: PhotoEditingSelection): PhotoEditingSelection {
  if (selection.selectedIds.length === 0) return selection;
  return { activeId: selection.activeId, selectedIds: [], anchorId: selection.activeId ?? selection.anchorId };
}

/**
 * 1 枚（編集）で使う選択。グリッドで選択を解いていたら（表示中の写真が選択に入っていない）、表示中の写真を選択に入れる。
 */
export function ensurePhotoEditingActiveSelected(selection: PhotoEditingSelection): PhotoEditingSelection {
  const { activeId } = selection;
  if (activeId === null || selection.selectedIds.includes(activeId)) return selection;
  if (selection.selectedIds.length === 0) return singlePhotoEditingSelection(activeId);
  return { ...selection, selectedIds: [...selection.selectedIds, activeId] };
}

/**
 * 写真を並びから外したあとの選択（クラウドから消した写真、移行元設計）。選択から外し、表示中の写真を外したら並びでいちばん
 * 近い残りの写真（後ろを優先）を表示中にする（選択には足さない。1 枚では {@link ensurePhotoEditingActiveSelected} で足す）。
 */
export function removePhotoEditingPhotosFromSelection(
  selection: PhotoEditingSelection,
  orderedIdsBefore: readonly string[],
  removedIds: readonly string[],
): PhotoEditingSelection {
  const removed = new Set(removedIds);
  const selectedIds = selection.selectedIds.filter((id) => !removed.has(id));
  let { activeId } = selection;
  if (activeId !== null && removed.has(activeId)) {
    const index = orderedIdsBefore.indexOf(activeId);
    const after = index < 0 ? undefined : orderedIdsBefore.slice(index + 1).find((id) => !removed.has(id));
    const before = orderedIdsBefore
      .slice(0, Math.max(index, 0))
      .reverse()
      .find((id) => !removed.has(id));
    activeId = after ?? before ?? null;
  }
  const anchorId = selection.anchorId !== null && !removed.has(selection.anchorId) ? selection.anchorId : activeId;
  if (
    activeId === selection.activeId &&
    anchorId === selection.anchorId &&
    selectedIds.length === selection.selectedIds.length
  ) {
    return selection;
  }
  return { activeId, selectedIds, anchorId };
}

/**
 * 写真を閉じたあとの選択。表示中の写真を閉じたら、選択に残っている写真のうち一覧でいちばん近いもの
 * （後ろを優先）を表示する。選択に何も残らなければ一覧の隣の写真だけを選ぶ（1 段目と同じ）。
 */
export function removePhotoEditingPhoto(
  selection: PhotoEditingSelection,
  orderedIdsBefore: readonly string[],
  removedId: string,
): PhotoEditingSelection {
  const removedIndex = orderedIdsBefore.indexOf(removedId);
  if (removedIndex < 0) return selection;
  const remaining = orderedIdsBefore.filter((id) => id !== removedId);
  if (remaining.length === 0) return EMPTY_PHOTO_EDITING_SELECTION;

  const selectedIds = selection.selectedIds.filter((id) => id !== removedId && remaining.includes(id));
  let activeId = selection.activeId;
  if (activeId === null || activeId === removedId || !remaining.includes(activeId)) {
    activeId = nearestSelected(orderedIdsBefore, removedIndex, selectedIds) ??
      remaining[Math.min(removedIndex, remaining.length - 1)];
  }
  const nextSelectedIds = selectedIds.includes(activeId) ? selectedIds : [...selectedIds, activeId];
  const anchorId = selection.anchorId !== null && remaining.includes(selection.anchorId)
    ? selection.anchorId
    : activeId;
  return { activeId, selectedIds: nextSelectedIds, anchorId };
}

function nearestSelected(
  orderedIds: readonly string[],
  fromIndex: number,
  selectedIds: readonly string[],
): string | null {
  for (let distance = 1; distance < orderedIds.length; distance += 1) {
    const after = orderedIds[fromIndex + distance];
    if (after !== undefined && selectedIds.includes(after)) return after;
    const before = orderedIds[fromIndex - distance];
    if (before !== undefined && selectedIds.includes(before)) return before;
  }
  return null;
}
