import { describe, expect, it } from "vitest";

import {
  EMPTY_PHOTO_EDITING_SELECTION,
  addPhotoEditingPhotosToSelection,
  adjacentPhotoEditingPhotoId,
  clearPhotoEditingSelection,
  ensurePhotoEditingActiveSelected,
  limitPhotoEditingSelection,
  movePhotoEditingPhotoId,
  photoEditingArrowOffset,
  removePhotoEditingPhoto,
  removePhotoEditingPhotosFromSelection,
  restrictPhotoEditingSelection,
  selectAllPhotoEditingPhotos,
  selectPhotoEditingPhoto,
  singlePhotoEditingSelection,
  type PhotoEditingSelection,
} from "./photo-editing-selection";

const IDS = ["p1", "p2", "p3", "p4", "p5"];
const PLAIN = { toggle: false, range: false };
const TOGGLE = { toggle: true, range: false };
const RANGE = { toggle: false, range: true };
const TOGGLE_RANGE = { toggle: true, range: true };

function select(selection: PhotoEditingSelection, targetId: string, modifiers = PLAIN) {
  return selectPhotoEditingPhoto(selection, IDS, targetId, modifiers);
}

describe("selectPhotoEditingPhoto", () => {
  it("ふつうのクリックはその 1 枚だけを選んで表示する", () => {
    const selection = select({ activeId: "p1", selectedIds: ["p1", "p2", "p3"], anchorId: "p1" }, "p4");
    expect(selection).toEqual({ activeId: "p4", selectedIds: ["p4"], anchorId: "p4" });
  });

  it("⌘ クリックは足した写真を後ろに付けて表示し、起点にする", () => {
    let selection = singlePhotoEditingSelection("p2");
    selection = select(selection, "p5", TOGGLE);
    selection = select(selection, "p1", TOGGLE);
    expect(selection).toEqual({ activeId: "p1", selectedIds: ["p2", "p5", "p1"], anchorId: "p1" });
  });

  it("⌘ クリックで表示中の写真を外すと、最後に選んだ写真を表示する", () => {
    const selection = select({ activeId: "p5", selectedIds: ["p2", "p3", "p5"], anchorId: "p5" }, "p5", TOGGLE);
    expect(selection).toEqual({ activeId: "p3", selectedIds: ["p2", "p3"], anchorId: "p3" });
  });

  it("⌘ クリックで表示中でない写真を外しても、表示と起点は変えない", () => {
    const selection = select({ activeId: "p5", selectedIds: ["p2", "p3", "p5"], anchorId: "p2" }, "p3", TOGGLE);
    expect(selection).toEqual({ activeId: "p5", selectedIds: ["p2", "p5"], anchorId: "p2" });
  });

  it("最後の 1 枚は ⌘ クリックでも外さない", () => {
    const selection = singlePhotoEditingSelection("p2");
    expect(select(selection, "p2", TOGGLE)).toBe(selection);
  });

  it("Shift クリックは起点から押した写真までを選び直し、起点は動かさない", () => {
    let selection = singlePhotoEditingSelection("p2");
    selection = select(selection, "p4", RANGE);
    expect(selection).toEqual({ activeId: "p4", selectedIds: ["p2", "p3", "p4"], anchorId: "p2" });

    // 起点より前を Shift クリックすると、範囲はその向きに選び直す（p3・p4 は外れる）
    selection = select(selection, "p1", RANGE);
    expect(selection).toEqual({ activeId: "p1", selectedIds: ["p2", "p1"], anchorId: "p2" });
  });

  it("⌘ と Shift を一緒に押すと、今の選択に範囲を足す", () => {
    let selection = singlePhotoEditingSelection("p1");
    selection = select(selection, "p4", TOGGLE);
    selection = select(selection, "p5", TOGGLE_RANGE);
    expect(selection).toEqual({ activeId: "p5", selectedIds: ["p1", "p4", "p5"], anchorId: "p4" });
  });

  it("一覧に無い写真は選ばない", () => {
    const selection = singlePhotoEditingSelection("p1");
    expect(select(selection, "missing", TOGGLE)).toBe(selection);
  });
});

describe("selectAllPhotoEditingPhotos", () => {
  it("一覧の順ですべてを選び、表示中の写真は変えない", () => {
    const selection = selectAllPhotoEditingPhotos(singlePhotoEditingSelection("p3"), IDS);
    expect(selection).toEqual({ activeId: "p3", selectedIds: IDS, anchorId: "p3" });
  });

  it("写真が無ければ何もしない", () => {
    expect(selectAllPhotoEditingPhotos(EMPTY_PHOTO_EDITING_SELECTION, [])).toBe(EMPTY_PHOTO_EDITING_SELECTION);
  });
});

describe("addPhotoEditingPhotosToSelection（記事制作の「画像を追加」#16347）", () => {
  it("何も選んでいなければ、開いた写真を開いた順にすべて選び、指定した写真を表示する", () => {
    expect(addPhotoEditingPhotosToSelection(EMPTY_PHOTO_EDITING_SELECTION, ["p1", "p2", "p3"], "p1")).toEqual({
      activeId: "p1",
      selectedIds: ["p1", "p2", "p3"],
      anchorId: "p1",
    });
  });

  it("今の選択に足し（重ねて開いた写真は二重にしない）、開いた写真を表示する", () => {
    const selection = { activeId: "p2", selectedIds: ["p1", "p2"], anchorId: "p1" };
    expect(addPhotoEditingPhotosToSelection(selection, ["p2", "p4", "p5"], "p4")).toEqual({
      activeId: "p4",
      selectedIds: ["p1", "p2", "p4", "p5"],
      anchorId: "p4",
    });
  });
});

describe("restrictPhotoEditingSelection（入れられなかった写真だけを選び直す）", () => {
  it("この写真だけを並べた順で選び、表示中の写真が残るなら表示は変えない", () => {
    const selection = { activeId: "p3", selectedIds: ["p1", "p2", "p3", "p4"], anchorId: "p1" };
    expect(restrictPhotoEditingSelection(selection, ["p4", "p3"])).toEqual({
      activeId: "p3",
      selectedIds: ["p4", "p3"],
      anchorId: "p3",
    });
  });

  it("表示中の写真が残らなければ最初の 1 枚を表示し、空なら何もしない", () => {
    const selection = { activeId: "p1", selectedIds: ["p1", "p2", "p3"], anchorId: "p2" };
    expect(restrictPhotoEditingSelection(selection, ["p2", "p3"])).toEqual({
      activeId: "p2",
      selectedIds: ["p2", "p3"],
      anchorId: "p2",
    });
    expect(restrictPhotoEditingSelection(selection, [])).toBe(selection);
  });
});

describe("limitPhotoEditingSelection（フォルダの写真は一度に選べる枚数を抑える）", () => {
  it("上限以内ならそのまま返す", () => {
    const selection = { activeId: "p2", selectedIds: ["p1", "p2"], anchorId: "p1" };
    expect(limitPhotoEditingSelection(selection, 2)).toBe(selection);
  });

  it("Shift の範囲は起点側から残し、押した写真が外れたら残した最後の写真を表示する", () => {
    const range = select({ activeId: "p2", selectedIds: ["p2"], anchorId: "p2" }, "p5", RANGE);
    expect(limitPhotoEditingSelection(range, 2)).toEqual({ activeId: "p3", selectedIds: ["p2", "p3"], anchorId: "p2" });
    // 起点から前へ広げたときも起点側から
    const backward = select({ activeId: "p4", selectedIds: ["p4"], anchorId: "p4" }, "p1", RANGE);
    expect(limitPhotoEditingSelection(backward, 3)).toEqual({
      activeId: "p2",
      selectedIds: ["p4", "p3", "p2"],
      anchorId: "p4",
    });
  });

  it("⌘A（keepActive）は一覧の先頭から残し、表示中の写真は必ず残す", () => {
    const all = selectAllPhotoEditingPhotos({ activeId: "p5", selectedIds: ["p5"], anchorId: "p5" }, IDS);
    expect(limitPhotoEditingSelection(all, 3, { keepActive: true })).toEqual({
      activeId: "p5",
      selectedIds: ["p1", "p2", "p5"],
      anchorId: "p5",
    });
    const fromHead = selectAllPhotoEditingPhotos({ activeId: "p2", selectedIds: ["p2"], anchorId: "p2" }, IDS);
    expect(limitPhotoEditingSelection(fromHead, 3, { keepActive: true })).toEqual({
      activeId: "p2",
      selectedIds: ["p1", "p2", "p3"],
      anchorId: "p2",
    });
  });
});

describe("adjacentPhotoEditingPhotoId", () => {
  it("一覧の隣を返し、端を越えたら null", () => {
    expect(adjacentPhotoEditingPhotoId(IDS, "p2", 1)).toBe("p3");
    expect(adjacentPhotoEditingPhotoId(IDS, "p2", -1)).toBe("p1");
    expect(adjacentPhotoEditingPhotoId(IDS, "p5", 1)).toBeNull();
    expect(adjacentPhotoEditingPhotoId(IDS, "p1", -1)).toBeNull();
    expect(adjacentPhotoEditingPhotoId(IDS, "missing", 1)).toBeNull();
  });
});

describe("removePhotoEditingPhoto", () => {
  it("1 枚だけ選んでいて表示中の写真を閉じたら、一覧の隣を表示する（1 段目と同じ）", () => {
    expect(removePhotoEditingPhoto(singlePhotoEditingSelection("p2"), IDS, "p2")).toEqual(
      singlePhotoEditingSelection("p3"),
    );
    // 最後の写真なら 1 つ前
    expect(removePhotoEditingPhoto(singlePhotoEditingSelection("p5"), IDS, "p5")).toEqual(
      singlePhotoEditingSelection("p4"),
    );
  });

  it("複数枚を選んでいて表示中の写真を閉じたら、選択に残る写真のうち近いもの（後ろを優先）を表示する", () => {
    const selection = { activeId: "p3", selectedIds: ["p1", "p3", "p5"], anchorId: "p1" };
    expect(removePhotoEditingPhoto(selection, IDS, "p3")).toEqual({
      activeId: "p5",
      selectedIds: ["p1", "p5"],
      anchorId: "p1",
    });
    const nearerBefore = { activeId: "p4", selectedIds: ["p1", "p3", "p4"], anchorId: "p4" };
    expect(removePhotoEditingPhoto(nearerBefore, IDS, "p4")).toEqual({
      activeId: "p3",
      selectedIds: ["p1", "p3"],
      anchorId: "p3",
    });
  });

  it("表示中でない写真を閉じたら、選択から外すだけ", () => {
    const selection = { activeId: "p1", selectedIds: ["p1", "p2"], anchorId: "p2" };
    expect(removePhotoEditingPhoto(selection, IDS, "p2")).toEqual({
      activeId: "p1",
      selectedIds: ["p1"],
      anchorId: "p1",
    });
    expect(removePhotoEditingPhoto(selection, IDS, "p4")).toEqual(selection);
  });

  it("最後の写真を閉じたら空にする", () => {
    expect(removePhotoEditingPhoto(singlePhotoEditingSelection("p1"), ["p1"], "p1")).toEqual(
      EMPTY_PHOTO_EDITING_SELECTION,
    );
  });
});

describe("グリッド（#16580）", () => {
  it("矢印で移る数: フィルムストリップ（1 列）は ←→ も ↑↓ も隣、グリッドは ↑↓ で列の数だけ。矢印でなければ null", () => {
    expect(photoEditingArrowOffset("ArrowRight", 1)).toBe(1);
    expect(photoEditingArrowOffset("ArrowLeft", 1)).toBe(-1);
    expect(photoEditingArrowOffset("ArrowDown", 1)).toBe(1);
    expect(photoEditingArrowOffset("ArrowUp", 1)).toBe(-1);
    expect(photoEditingArrowOffset("ArrowDown", 4)).toBe(4);
    expect(photoEditingArrowOffset("ArrowUp", 4)).toBe(-4);
    expect(photoEditingArrowOffset("ArrowRight", 4)).toBe(1);
    // 数えられなかったときは 1 列として扱う
    expect(photoEditingArrowOffset("ArrowDown", 0)).toBe(1);
    expect(photoEditingArrowOffset("Enter", 4)).toBeNull();
  });

  it("移る先: 表示中の写真が無ければ先頭、下の行が無ければ動かない", () => {
    expect(movePhotoEditingPhotoId(IDS, null, 1)).toBe("p1");
    expect(movePhotoEditingPhotoId(IDS, "missing", 3)).toBe("p1");
    expect(movePhotoEditingPhotoId(IDS, "p1", 3)).toBe("p4");
    expect(movePhotoEditingPhotoId(IDS, "p3", 3)).toBeNull();
    expect(movePhotoEditingPhotoId(IDS, "p4", -3)).toBe("p1");
    expect(movePhotoEditingPhotoId([], null, 1)).toBeNull();
  });

  it("Esc は選択だけを解き、表示中の写真は残す（1 枚に戻すと表示中の写真だけを選び直す）", () => {
    const selection = { activeId: "p3", selectedIds: ["p1", "p3"], anchorId: "p1" };
    const cleared = clearPhotoEditingSelection(selection);
    expect(cleared).toEqual({ activeId: "p3", selectedIds: [], anchorId: "p3" });
    expect(clearPhotoEditingSelection(cleared)).toBe(cleared);
    expect(ensurePhotoEditingActiveSelected(cleared)).toEqual(singlePhotoEditingSelection("p3"));
    // 解いた後に ⌘ クリックで足すと、その写真だけを選ぶ
    expect(selectPhotoEditingPhoto(cleared, IDS, "p5", TOGGLE)).toEqual({
      activeId: "p5",
      selectedIds: ["p5"],
      anchorId: "p5",
    });
  });

  it("表示中の写真が選択に入っていれば同じ値を返し、選択の外なら後ろに足す", () => {
    const selection = { activeId: "p2", selectedIds: ["p1", "p2"], anchorId: "p1" };
    expect(ensurePhotoEditingActiveSelected(selection)).toBe(selection);
    expect(ensurePhotoEditingActiveSelected(EMPTY_PHOTO_EDITING_SELECTION)).toBe(EMPTY_PHOTO_EDITING_SELECTION);
    expect(ensurePhotoEditingActiveSelected({ activeId: "p4", selectedIds: ["p1"], anchorId: "p1" })).toEqual({
      activeId: "p4",
      selectedIds: ["p1", "p4"],
      anchorId: "p1",
    });
  });

  it("並びから消した写真を選択から外し、表示中の写真を消したら並びで近い残りの写真（後ろを優先）を表示中にする", () => {
    const selection = { activeId: "p2", selectedIds: ["p2", "p3"], anchorId: "p2" };
    expect(removePhotoEditingPhotosFromSelection(selection, IDS, ["p2", "p3"])).toEqual({
      activeId: "p4",
      selectedIds: [],
      anchorId: "p4",
    });
    // 後ろが無ければ前
    expect(removePhotoEditingPhotosFromSelection(singlePhotoEditingSelection("p5"), IDS, ["p5"])).toEqual({
      activeId: "p4",
      selectedIds: [],
      anchorId: "p4",
    });
    // 表示中でない写真だけなら、選択から外すだけ
    expect(removePhotoEditingPhotosFromSelection(selection, IDS, ["p3"])).toEqual({
      activeId: "p2",
      selectedIds: ["p2"],
      anchorId: "p2",
    });
    expect(removePhotoEditingPhotosFromSelection(selection, IDS, ["p5"])).toBe(selection);
    // 全部消したら空
    expect(removePhotoEditingPhotosFromSelection(singlePhotoEditingSelection("p1"), ["p1"], ["p1"])).toEqual({
      activeId: null,
      selectedIds: [],
      anchorId: null,
    });
  });
});
