// @vitest-environment jsdom

import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useBrowserPhotoSelection, type BrowserPhotoSelection } from "./use-browser-photo-selection";

/**
 * ブラウザ版の一覧の複数選択の hook（F5a-2 移行元設計）。表示中の 1 枚（`activeKey`）は外が持つので、小さなテスト用の面が
 * `useState` で持って hook に渡し、戻りを取る。選び方の規則（クリック・⌘・⇧・⌘A）は `photo-editing-selection.ts` のもので、
 * ここでは hook が表示中の写真と複数選択をどう重ねるかを確かめる。
 */

const PLAIN = { toggle: false, range: false };
const TOGGLE = { toggle: true, range: false };
const RANGE = { toggle: false, range: true };
const TOGGLE_RANGE = { toggle: true, range: true };

/** 見出しをまたぐ並び（今日 2 枚・昨日 1 枚・9 月 2 枚）でも、範囲と「すべて」は一覧の key の順で数える */
const KEYS = ["t1", "t2", "y1", "s1", "o1"];

let container: HTMLDivElement;
let root: Root;
let selection: BrowserPhotoSelection;
let activeKey: string | null;
let setActiveKey: Dispatch<SetStateAction<string | null>>;

function Harness(props: { enabled: boolean; orderedKeys: readonly string[] }) {
  const [active, setActive] = useState<string | null>(null);
  activeKey = active;
  setActiveKey = setActive;
  selection = useBrowserPhotoSelection({
    enabled: props.enabled,
    orderedKeys: props.orderedKeys,
    activeKey: active,
    setActiveKey: setActive,
  });
  return null;
}

async function render(options: { enabled?: boolean; orderedKeys?: readonly string[] } = {}) {
  await act(async () => {
    root.render(<Harness enabled={options.enabled ?? true} orderedKeys={options.orderedKeys ?? KEYS} />);
  });
}

/** 1 つのイベントの中で操作を呼ぶ（実際のクリック・キーと同じく、状態の更新はまとめて反映される） */
async function run(action: () => void) {
  await act(async () => {
    action();
  });
}

function selected(): string[] {
  return Array.from(selection.selectedKeys);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("PC の選び方（macOS の一覧と同じ）", () => {
  it("何も選んでいないときは 0 枚。クリックはその 1 枚だけを選んで表示中にする（複数選択を持たない）", async () => {
    await render();
    expect(selected()).toEqual([]);
    expect(selection).toMatchObject({ count: 0, multiple: false, selecting: false, barVisible: false, allSelected: false });

    await run(() => selection.select("t2", PLAIN));
    expect(selected()).toEqual(["t2"]);
    expect(activeKey).toBe("t2");
    expect(selection).toMatchObject({ count: 1, multiple: false, selecting: false, barVisible: false });

    // 別の写真をふつうに押せば、その 1 枚だけに替わる
    await run(() => selection.select("o1", PLAIN));
    expect(selected()).toEqual(["o1"]);
    expect(activeKey).toBe("o1");
  });

  it("⌘ / Ctrl＋クリックは足す・外す（選んだ順）。最後の 1 枚は外れない。2 枚以上でバーを出す", async () => {
    await render();
    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.select("s1", TOGGLE));
    expect(selected()).toEqual(["t2", "s1"]);
    expect(activeKey).toBe("s1");
    expect(selection).toMatchObject({ count: 2, multiple: true, selecting: false, barVisible: true });

    await run(() => selection.select("y1", TOGGLE));
    expect(selected()).toEqual(["t2", "s1", "y1"]);
    expect(activeKey).toBe("y1");

    // 表示中でない写真を外しても、表示中は変わらない
    await run(() => selection.select("s1", TOGGLE));
    expect(selected()).toEqual(["t2", "y1"]);
    expect(activeKey).toBe("y1");

    // 表示中の写真を外すと、残りの最後の 1 枚が表示中になる。1 枚になれば複数選択は終わる
    await run(() => selection.select("y1", TOGGLE));
    expect(selected()).toEqual(["t2"]);
    expect(activeKey).toBe("t2");
    expect(selection).toMatchObject({ count: 1, multiple: false, barVisible: false });

    // 最後の 1 枚は⌘で外れない
    await run(() => selection.select("t2", TOGGLE));
    expect(selected()).toEqual(["t2"]);
    expect(activeKey).toBe("t2");
    expect(selection.count).toBe(1);
  });

  it("⇧＋クリックは起点からの範囲。見出しをまたぐ並びでも一覧の key の順で、起点から押した写真への向きで選ぶ", async () => {
    await render();
    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.select("s1", RANGE));
    // 今日の 2 枚目から 9 月の写真まで（昨日の見出しをまたぐ）
    expect(selected()).toEqual(["t2", "y1", "s1"]);
    expect(activeKey).toBe("s1");
    expect(selection.multiple).toBe(true);

    // 起点（t2）は動かない: 別の方向へ押すと、起点からの範囲に替わる
    await run(() => selection.select("t1", RANGE));
    expect(selected()).toEqual(["t2", "t1"]);
    expect(activeKey).toBe("t1");

    // ⌘＋⇧は今の選択に範囲を足す
    await run(() => selection.select("o1", TOGGLE_RANGE));
    expect(selected()).toEqual(["t2", "t1", "y1", "s1", "o1"]);
    expect(activeKey).toBe("o1");

    // 下から上へ押した範囲は、起点から押した写真への向き
    await run(() => selection.select("s1", PLAIN));
    await run(() => selection.select("t2", RANGE));
    expect(selected()).toEqual(["s1", "y1", "t2"]);
  });

  it("⇧＋矢印（extend）は今の起点から選択を伸ばす・縮める。何も選んでいなければ、その 1 枚だけ", async () => {
    await render();
    await run(() => selection.extend("y1"));
    expect(selected()).toEqual(["y1"]);
    expect(activeKey).toBe("y1");

    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.extend("y1"));
    await run(() => selection.extend("s1"));
    expect(selected()).toEqual(["t2", "y1", "s1"]);
    expect(activeKey).toBe("s1");

    // 起点は t2 のまま（戻ると縮み、越えると反対側へ伸びる）
    await run(() => selection.extend("y1"));
    expect(selected()).toEqual(["t2", "y1"]);
    await run(() => selection.extend("t1"));
    expect(selected()).toEqual(["t2", "t1"]);
    expect(activeKey).toBe("t1");
  });

  it("一覧に無い写真（追加している途中など）は選べない", async () => {
    await render();
    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.select("adding", TOGGLE));
    expect(selected()).toEqual(["t2"]);
    expect(activeKey).toBe("t2");
    await run(() => selection.select("adding", RANGE));
    expect(selected()).toEqual(["t2"]);
  });

  it("⌘A は今読み込んである分をすべて選ぶ（表示中の写真は変えない）。1 枚が外れれば「すべて」ではなくなる", async () => {
    await render();
    await run(() => selection.select("y1", PLAIN));
    expect(selection.allSelected).toBe(false);

    await run(() => selection.selectAll());
    expect(selected()).toEqual(KEYS);
    expect(activeKey).toBe("y1");
    expect(selection).toMatchObject({ count: 5, multiple: true, barVisible: true, allSelected: true });

    await run(() => selection.select("s1", TOGGLE));
    expect(selected()).toEqual(["t1", "t2", "y1", "o1"]);
    expect(selection.allSelected).toBe(false);

    // 何も選んでいなければ、先頭を表示中にしてすべて選ぶ
    await run(() => selection.clear());
    await run(() => selection.selectAll());
    expect(selected()).toEqual(KEYS);
    expect(activeKey).toBe("t1");
  });

  it("写真が 1 枚も無ければ、⌘A は何もしない（「すべて」でもない）。1 枚だけの一覧では、その 1 枚を選ぶだけ", async () => {
    await render({ orderedKeys: [] });
    await run(() => selection.selectAll());
    expect(selected()).toEqual([]);
    expect(activeKey).toBeNull();
    expect(selection).toMatchObject({ count: 0, barVisible: false, allSelected: false });

    await render({ orderedKeys: ["only"] });
    await run(() => selection.selectAll());
    expect(selected()).toEqual(["only"]);
    expect(activeKey).toBe("only");
    // 1 枚を選んでいるだけなので、バーは出さない
    expect(selection).toMatchObject({ count: 1, multiple: false, barVisible: false, allSelected: true });
  });

  it("clear は選択をすべて解き、表示中の写真も外す。collapse は表示中の 1 枚だけに畳む", async () => {
    await render();
    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.select("s1", TOGGLE));
    await run(() => selection.select("o1", TOGGLE));
    expect(selection.count).toBe(3);

    await run(() => selection.collapse());
    expect(selected()).toEqual(["o1"]);
    expect(activeKey).toBe("o1");
    expect(selection).toMatchObject({ count: 1, multiple: false, barVisible: false });

    await run(() => selection.select("t1", TOGGLE));
    expect(selection.count).toBe(2);
    await run(() => selection.clear());
    expect(selected()).toEqual([]);
    expect(activeKey).toBeNull();
    expect(selection).toMatchObject({ count: 0, selecting: false, barVisible: false });
  });
});

describe("複数選択できない場所（enabled が false）", () => {
  it("どの修飾キーでも常に 1 枚。「すべて」も選択モードも効かない", async () => {
    await render({ enabled: false });
    await run(() => selection.select("t2", TOGGLE));
    expect(selected()).toEqual(["t2"]);
    await run(() => selection.select("s1", TOGGLE));
    expect(selected()).toEqual(["s1"]);
    expect(activeKey).toBe("s1");
    await run(() => selection.select("t1", RANGE));
    expect(selected()).toEqual(["t1"]);
    await run(() => selection.select("o1", TOGGLE_RANGE));
    expect(selected()).toEqual(["o1"]);

    await run(() => selection.selectAll());
    expect(selected()).toEqual(["o1"]);
    await run(() => selection.startSelecting());
    await run(() => selection.startSelecting("t2"));
    expect(selection).toMatchObject({ count: 1, selecting: false, barVisible: false });
    expect(selected()).toEqual(["o1"]);
    expect(activeKey).toBe("o1");
  });

  it("複数選択を持っている間に場所が替わる（enabled が false になる）と消え、戻しても復活しない", async () => {
    await render();
    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.select("s1", TOGGLE));
    expect(selection.count).toBe(2);

    await render({ enabled: false });
    expect(selected()).toEqual(["s1"]);
    expect(selection).toMatchObject({ count: 1, barVisible: false });

    await render({ enabled: true });
    expect(selected()).toEqual(["s1"]);
    expect(selection.count).toBe(1);
  });
});

describe("外から壊れたとき・一覧が読み直されたとき", () => {
  it("外から表示中の写真が変わると複数選択は消え、戻しても復活しない（写真を追加した直後・1 枚を開くなど）", async () => {
    await render();
    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.select("s1", TOGGLE));
    await run(() => selection.select("y1", TOGGLE));
    expect(selected()).toEqual(["t2", "s1", "y1"]);
    expect(activeKey).toBe("y1");

    await run(() => setActiveKey("o1"));
    expect(selected()).toEqual(["o1"]);
    expect(selection).toMatchObject({ count: 1, multiple: false, barVisible: false });

    // 同じ写真（y1）に戻しても、前の複数選択は戻らない
    await run(() => setActiveKey("y1"));
    expect(selected()).toEqual(["y1"]);
    expect(selection.count).toBe(1);

    // 外から表示中の写真が外れた（null）ときも同じ
    await run(() => selection.select("t2", TOGGLE));
    expect(selection.count).toBe(2);
    await run(() => setActiveKey(null));
    expect(selected()).toEqual([]);
    expect(selection).toMatchObject({ count: 0, barVisible: false });
  });

  it("一覧から消えた写真（読み直されて無くなった写真）は数えない", async () => {
    await render();
    await run(() => selection.select("t1", PLAIN));
    await run(() => selection.select("s1", TOGGLE));
    await run(() => selection.select("y1", TOGGLE));
    expect(selected()).toEqual(["t1", "s1", "y1"]);

    await render({ orderedKeys: ["t1", "t2", "y1", "o1"] });
    expect(selected()).toEqual(["t1", "y1"]);
    expect(selection).toMatchObject({ count: 2, multiple: true, barVisible: true });

    // 表示中の写真も消え、1 枚だけになれば、バーは出さない
    await render({ orderedKeys: ["t1", "t2", "o1"] });
    expect(selected()).toEqual(["t1"]);
    expect(selection).toMatchObject({ count: 1, multiple: false, barVisible: false });
  });

  it("消えた写真のあとでも、足す・範囲は残っている写真を元に続けられる", async () => {
    await render();
    await run(() => selection.select("t1", PLAIN));
    await run(() => selection.select("s1", TOGGLE));
    await render({ orderedKeys: ["t1", "t2", "y1", "o1"] });
    expect(selected()).toEqual(["t1"]);

    await run(() => selection.select("o1", TOGGLE));
    expect(selected()).toEqual(["t1", "o1"]);
  });
});

describe("スマホの選択モード", () => {
  it("startSelecting() は表示中の写真を外して 0 枚から始める。タイルを押すと修飾キーに関わらず足す・外す", async () => {
    await render();
    await run(() => selection.select("y1", PLAIN));
    await run(() => selection.startSelecting());
    expect(selected()).toEqual([]);
    expect(activeKey).toBeNull();
    expect(selection).toMatchObject({ count: 0, multiple: false, selecting: true, barVisible: true, allSelected: false });

    await run(() => selection.select("t2", PLAIN));
    expect(selected()).toEqual(["t2"]);
    expect(activeKey).toBe("t2");
    // 1 枚だけでも、選択モードの間はバーを出す
    expect(selection).toMatchObject({ count: 1, selecting: true, barVisible: true });

    // ⌘・⇧は無視して、ただ足す
    await run(() => selection.select("s1", RANGE));
    expect(selected()).toEqual(["t2", "s1"]);
    expect(activeKey).toBe("s1");
    await run(() => selection.select("y1", TOGGLE_RANGE));
    expect(selected()).toEqual(["t2", "s1", "y1"]);
    expect(activeKey).toBe("y1");
    expect(selection).toMatchObject({ count: 3, multiple: true, selecting: true, barVisible: true });
  });

  it("もう一度押すと外れる。表示中の写真を外すと残りの最後の 1 枚が表示中になり、外して 0 枚になってもモードは続く", async () => {
    await render();
    await run(() => selection.startSelecting());
    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.select("y1", PLAIN));
    await run(() => selection.select("s1", PLAIN));
    expect(selected()).toEqual(["t2", "y1", "s1"]);
    expect(activeKey).toBe("s1");

    // 表示中でない写真を外しても、表示中は変わらない
    await run(() => selection.select("t2", PLAIN));
    expect(selected()).toEqual(["y1", "s1"]);
    expect(activeKey).toBe("s1");

    // 表示中の写真を外すと、残りの最後
    await run(() => selection.select("s1", PLAIN));
    expect(selected()).toEqual(["y1"]);
    expect(activeKey).toBe("y1");

    // 0 枚になってもモードは続く。表示中の写真は無い
    await run(() => selection.select("y1", PLAIN));
    expect(selected()).toEqual([]);
    expect(activeKey).toBeNull();
    expect(selection).toMatchObject({ count: 0, selecting: true, barVisible: true });

    // そのまま選び直せる
    await run(() => selection.select("o1", PLAIN));
    expect(selected()).toEqual(["o1"]);
    expect(activeKey).toBe("o1");
  });

  it("startSelecting(key) はその 1 枚を選んでモードに入る（選んでいたものは捨てる）。一覧に無い写真は選べない", async () => {
    await render();
    await run(() => selection.startSelecting("t2"));
    expect(selected()).toEqual(["t2"]);
    expect(activeKey).toBe("t2");
    expect(selection).toMatchObject({ count: 1, selecting: true, barVisible: true });

    await run(() => selection.select("adding", PLAIN));
    expect(selected()).toEqual(["t2"]);

    await run(() => selection.select("s1", PLAIN));
    await run(() => selection.startSelecting("o1"));
    expect(selected()).toEqual(["o1"]);
    expect(activeKey).toBe("o1");
    expect(selection.selecting).toBe(true);
  });

  it("「すべて」は今読み込んである分をすべて選び、モードは続く。clear はモードも終える。collapse は表示中の 1 枚に畳む", async () => {
    await render();
    await run(() => selection.startSelecting());
    await run(() => selection.selectAll());
    expect(selected()).toEqual(KEYS);
    expect(selection).toMatchObject({ count: 5, selecting: true, barVisible: true, allSelected: true });
    expect(activeKey).toBe("t1");

    // すべて選んだあとも、押して外せる
    await run(() => selection.select("s1", PLAIN));
    expect(selected()).toEqual(["t1", "t2", "y1", "o1"]);
    expect(selection).toMatchObject({ selecting: true, allSelected: false });

    await run(() => selection.collapse());
    expect(selected()).toEqual(["t1"]);
    expect(activeKey).toBe("t1");
    expect(selection).toMatchObject({ count: 1, selecting: false, barVisible: false });

    await run(() => selection.startSelecting("y1"));
    await run(() => selection.select("o1", PLAIN));
    expect(selection).toMatchObject({ count: 2, selecting: true });
    await run(() => selection.clear());
    expect(selected()).toEqual([]);
    expect(activeKey).toBeNull();
    expect(selection).toMatchObject({ count: 0, selecting: false, barVisible: false });
  });

  it("0 枚のままで選択モードを使っている間に外から表示中の写真が変わると、モードも終わる", async () => {
    await render();
    await run(() => selection.startSelecting());
    expect(selection.selecting).toBe(true);

    await run(() => setActiveKey("y1"));
    expect(selection).toMatchObject({ selecting: false, count: 1, barVisible: false });
    expect(selected()).toEqual(["y1"]);
  });
});

describe("selectedKeys の参照", () => {
  it("中身が変わらないときは同じ参照を返す（再描画・同じ中身の新しい orderedKeys でも）。変わると新しくなる", async () => {
    await render();
    await run(() => selection.select("t2", PLAIN));
    await run(() => selection.select("s1", TOGGLE));
    const before = selection.selectedKeys;

    await render();
    expect(selection.selectedKeys).toBe(before);

    // 一覧が読み直されて、同じ中身の新しい配列になっても、選んでいる写真が同じなら変えない
    await render({ orderedKeys: [...KEYS] });
    expect(selection.selectedKeys).toBe(before);

    await run(() => selection.select("o1", TOGGLE));
    expect(selection.selectedKeys).not.toBe(before);
    expect(selected()).toEqual(["t2", "s1", "o1"]);
  });

  it("1 枚だけのときも、表示中の写真が同じなら同じ参照", async () => {
    await render();
    await run(() => selection.select("t2", PLAIN));
    const single = selection.selectedKeys;
    await render({ orderedKeys: [...KEYS] });
    expect(selection.selectedKeys).toBe(single);
    // 同じ写真をもう一度ふつうに押しても変わらない
    await run(() => selection.select("t2", PLAIN));
    expect(selection.selectedKeys).toBe(single);

    await run(() => selection.select("s1", PLAIN));
    expect(selection.selectedKeys).not.toBe(single);
  });
});
