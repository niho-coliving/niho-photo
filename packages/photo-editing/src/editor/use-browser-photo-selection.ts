"use client";

import { useMemo, useRef, useState } from "react";

import {
  selectAllPhotoEditingPhotos,
  selectPhotoEditingPhoto,
  type PhotoEditingSelection,
} from "../photo-editing-selection";

/**
 * ブラウザ版の写真編集の一覧の複数選択（F5a-2 移行元設計 / F5b 移行元設計）。お気に入り・アルバム操作とPCの複数書き出し（F7b 移行元設計）は
 * ここが渡す `selectedKeys` の上に載せる。補正の貼り付け・プリセット適用（一括の補正）も同じ選択状態を使う（`use-browser-photo-bulk.ts`）。
 *
 * 一覧の「表示中の 1 枚」（`useBrowserPhotoItems` の `selectedKey`。開く・書き出す・消すの対象）は置き換えず、その上に複数選択を
 * 重ねる。複数選択は「表示中の写真」と一緒に持ち、外から表示中の写真が変わったら（写真を追加した直後・場所の切り替え・1 枚を開く）
 * その render で捨てる（effect で同期しない）。後から同じ写真に戻っても復活しない。
 *
 * 選び方は macOS の一覧と同じ（`selectPhotoEditingPhoto`）: クリック = その 1 枚だけ、⌘ / Ctrl = 足す・外す（最後の 1 枚は外さない）、
 * Shift = 起点からの範囲、⌘A = 今読み込んである分のすべて。スマホは「選択モード」（タイルを押すと足す・外す。0 枚でも続く）。
 */

export type BrowserPhotoSelectModifiers = {
  /** ⌘（Windows などは Ctrl）: 1 枚ずつ足す・外す */
  toggle: boolean;
  /** Shift: 起点からの範囲 */
  range: boolean;
};

export type BrowserPhotoSelection = {
  /**
   * 選んでいる写真の key（一覧の `selectedKeys`）。複数選択が無いときは表示中の 1 枚（あれば）。選んだ順。安定した参照
   * （中身が変わるときだけ新しくする）
   */
  selectedKeys: ReadonlySet<string>;
  /** `selectedKeys.size` */
  count: number;
  /** 2 枚以上選んでいる */
  multiple: boolean;
  /** スマホの選択モード */
  selecting: boolean;
  /** 一覧の上の行を選択バーにする（`selecting || multiple`） */
  barVisible: boolean;
  /** 一覧の写真（`orderedKeys`）が 1 枚以上あり、すべて選んでいる */
  allSelected: boolean;
  /** 写真を押したとき。選択モードでは修飾キーを無視して足す・外す */
  select: (key: string, modifiers: BrowserPhotoSelectModifiers) => void;
  /** ⇧＋矢印。`select(key, { toggle: false, range: true })` */
  extend: (key: string) => void;
  /** ⌘A。今読み込んである分をすべて選ぶ */
  selectAll: () => void;
  /** 選択（とスマホの選択モード）をすべて解く。表示中の写真も外す */
  clear: () => void;
  /** スマホの選択モードに入る。`key` があればその 1 枚を選び、無ければ 0 枚から始める（表示中の写真は外す） */
  startSelecting: (key?: string) => void;
  /** 複数選択を、表示中の 1 枚だけの選択に畳む（1 枚で開く前に呼ぶ） */
  collapse: () => void;
};

/** 複数選択の状態（選んだ順）。1 枚だけの選択は持たず、表示中の写真から導く。 */
type MultiSelection = {
  /** この複数選択を作ったときの表示中の写真。外から表示中の写真が変わって合わなくなったら捨てる */
  activeKey: string | null;
  keys: readonly string[];
  anchorKey: string | null;
  selecting: boolean;
};

const NO_KEYS: readonly string[] = [];
const NO_PRESERVED_KEYS: ReadonlySet<string> = new Set();

/** 中身と並びが同じなら前の Set をそのまま返す（Set を渡された側の memo・effect を、再描画のたびに崩さない）。 */
function useStableKeySet(keys: readonly string[]): ReadonlySet<string> {
  const ref = useRef<ReadonlySet<string> | null>(null);
  const previous = ref.current;
  if (previous !== null && sameKeys(previous, keys)) return previous;
  const next = new Set(keys);
  ref.current = next;
  return next;
}

function sameKeys(set: ReadonlySet<string>, keys: readonly string[]): boolean {
  if (set.size !== keys.length) return false;
  let index = 0;
  for (const key of set) {
    if (key !== keys[index]) return false;
    index += 1;
  }
  return true;
}

export function useBrowserPhotoSelection(params: {
  /** 複数選択できる場所か（写真・お気に入り・アルバム。「記事の画像」は今までどおり 1 枚だけ） */
  enabled: boolean;
  /** 一覧の並びの順の key（追加している途中の写真を除く。呼ぶ側で useMemo する） */
  orderedKeys: readonly string[];
  /** 表示中の写真（`useBrowserPhotoItems` の `selectedKey`） */
  activeKey: string | null;
  /** `useBrowserPhotoItems` の `setSelectedKey` */
  setActiveKey: (key: string | null) => void;
  /** 一括適用・undo中に一覧条件から外れても選択を保つkey */
  preservedKeys?: ReadonlySet<string>;
}): BrowserPhotoSelection {
  const { enabled, orderedKeys, activeKey, setActiveKey, preservedKeys = NO_PRESERVED_KEYS } = params;
  const [multi, setMulti] = useState<MultiSelection | null>(null);
  const availableKeys = useMemo(() => new Set(orderedKeys), [orderedKeys]);

  // 外から壊れた（複数できない場所になった・表示中の写真が変わった）複数選択は、その render で捨てる。この render では無いものとして
  // 扱い、後から同じ写真に戻っても復活させない
  if (multi !== null && (!enabled || multi.activeKey !== activeKey)) setMulti(null);
  const current = multi !== null && enabled && multi.activeKey === activeKey ? multi : null;

  // 一覧から消えた選択は捨てる。一括適用・undo中だけは呼び側が保持するkeyを残す。
  const currentKeys = useMemo(
    () => (current === null ? NO_KEYS : current.keys.filter((key) => availableKeys.has(key) || preservedKeys.has(key))),
    [availableKeys, current, preservedKeys],
  );
  if (current !== null && currentKeys.length !== current.keys.length) {
    setMulti(
      currentKeys.length > 0 || current.selecting
        ? {
            ...current,
            keys: currentKeys,
            anchorKey: current.anchorKey !== null && currentKeys.includes(current.anchorKey) ? current.anchorKey : (currentKeys[0] ?? null),
          }
        : null,
    );
  }

  // 選んでいるkey。複数選択は一覧にあるものと、処理中に保持するもの。単一選択も一覧・保持対象から外れたら数えない。
  const keys = useMemo(() => {
    if (current === null) {
      return activeKey !== null && (availableKeys.has(activeKey) || preservedKeys.has(activeKey)) ? [activeKey] : NO_KEYS;
    }
    return currentKeys;
  }, [activeKey, availableKeys, current, currentKeys, preservedKeys]);
  const selectedKeys = useStableKeySet(keys);
  const count = selectedKeys.size;
  const selecting = current?.selecting ?? false;
  const allSelected = useMemo(
    () =>
      orderedKeys.length > 0 &&
      selectedKeys.size >= orderedKeys.length &&
      orderedKeys.every((key) => selectedKeys.has(key)),
    [orderedKeys, selectedKeys],
  );

  /** 今の状態を、選び方の規則（`selectPhotoEditingPhoto` など）が受け取る形にする */
  const snapshot = (): PhotoEditingSelection => ({
    activeId: activeKey,
    selectedIds: keys,
    anchorId: current?.anchorKey ?? activeKey,
  });

  /** 規則の結果を反映する。表示中の写真と複数選択は同じイベントの中で更新する（まとめて反映される）。1 枚だけなら複数選択は持たない */
  const apply = (next: PhotoEditingSelection, keepSelecting: boolean) => {
    setActiveKey(next.activeId);
    setMulti(
      next.selectedIds.length >= 2 || keepSelecting
        ? { activeKey: next.activeId, keys: next.selectedIds, anchorKey: next.anchorId, selecting: keepSelecting }
        : null,
    );
  };

  const select = (key: string, modifiers: BrowserPhotoSelectModifiers) => {
    if (!enabled) {
      setActiveKey(key);
      setMulti(null);
      return;
    }
    if (current?.selecting) {
      // スマホの選択モード: 修飾キーは無視して足す・外す。外して 0 枚になってもモードは続く
      if (!orderedKeys.includes(key)) return;
      const removing = keys.includes(key);
      const nextKeys = removing ? keys.filter((candidate) => candidate !== key) : [...keys, key];
      const nextActiveKey = removing ? (activeKey === key ? (nextKeys[nextKeys.length - 1] ?? null) : activeKey) : key;
      setActiveKey(nextActiveKey);
      setMulti({ activeKey: nextActiveKey, keys: nextKeys, anchorKey: key, selecting: true });
      return;
    }
    apply(selectPhotoEditingPhoto(snapshot(), orderedKeys, key, modifiers), false);
  };

  return {
    selectedKeys,
    count,
    multiple: count >= 2,
    selecting,
    barVisible: selecting || count >= 2,
    allSelected,
    select,
    extend: (key) => select(key, { toggle: false, range: true }),
    selectAll: () => {
      if (!enabled || orderedKeys.length === 0) return;
      apply(selectAllPhotoEditingPhotos(snapshot(), orderedKeys), selecting);
    },
    clear: () => {
      setActiveKey(null);
      setMulti(null);
    },
    startSelecting: (key) => {
      if (!enabled) return;
      setActiveKey(key ?? null);
      setMulti({ activeKey: key ?? null, keys: key === undefined ? NO_KEYS : [key], anchorKey: key ?? null, selecting: true });
    },
    collapse: () => setMulti(null),
  };
}
