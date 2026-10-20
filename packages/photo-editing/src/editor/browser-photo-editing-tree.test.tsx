// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserCloudPlace } from "../browser-photo-cloud-source";

import {
  BrowserPhotoEditingPlaceTabs,
  BrowserPhotoEditingTree,
  browserPhotoPlaceLabel,
  visibleBrowserPhotoPlaces,
  type BrowserPhotoTreeCounts,
  type BrowserPhotoAlbumSummary,
} from "./browser-photo-editing-tree";

/**
 * 左の木（PC）と狭い幅の上段のチップ（F5a-2 移行元設計 → F5b 移行元設計 のお気に入り）。並びは「写真」→「お気に入り」→「記事の画像」。
 * 「お気に入り」は 0 件でも出し、上段では ♥ のアイコンだけ（読み上げ名「お気に入り」）。
 */

let container: HTMLDivElement;
let root: Root;
let selected: BrowserCloudPlace[];

async function render(
  place: BrowserCloudPlace,
  counts: BrowserPhotoTreeCounts,
  albums: readonly BrowserPhotoAlbumSummary[] = [],
) {
  await act(async () => {
    root.render(
      <>
        <BrowserPhotoEditingPlaceTabs
          place={place}
          counts={counts}
          albums={albums}
          addButton={<button type="button" aria-label="写真を追加" />}
          onSelectPlace={(next) => selected.push(next)}
        />
        <BrowserPhotoEditingTree
          place={place}
          counts={counts}
          albums={albums}
          addButton={<button type="button" aria-label="写真を追加" />}
          onSelectPlace={(next) => selected.push(next)}
        />
      </>,
    );
  });
}

function treeNodes(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('aside[aria-label="写真の場所"] li > button'));
}

function chips(): HTMLButtonElement[] {
  // 場所のチップは 320px ではみ出さない横送りの内側に置く。
  const row = container.firstElementChild;
  return Array.from(row?.querySelectorAll<HTMLButtonElement>(":scope > div:first-child > button") ?? []);
}

function addButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="写真を追加"]'));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  selected = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("木（PC）", () => {
  it("「写真」→「お気に入り」→「記事の画像」の順に件数つきで並べ、「お気に入り」の件数は counts.favorites", async () => {
    await render("photos", { photos: 1234, favorites: 12, articleImages: 56 });
    expect(treeNodes().map((node) => node.textContent)).toEqual(["写真1234", "お気に入り12", "記事の画像56"]);
    expect(treeNodes().map((node) => node.getAttribute("aria-current"))).toEqual(["true", null, null]);
  });

  it("「お気に入り」は 0 件でも出し（件数は空欄）、記事の画像は 0 件なら出さない。読むまでは件数を出さない", async () => {
    await render("photos", { photos: 3, favorites: 0, articleImages: 0 });
    expect(treeNodes().map((node) => node.textContent)).toEqual(["写真3", "お気に入り"]);

    await render("photos", null);
    expect(treeNodes().map((node) => node.textContent)).toEqual(["写真", "お気に入り"]);
    expect(visibleBrowserPhotoPlaces("photos", null)).toEqual(["photos", "favorites"]);
    // 記事の画像を見ている間は 0 件でも残す
    expect(visibleBrowserPhotoPlaces("articleImages", { photos: 1, favorites: 0, articleImages: 0 })).toEqual([
      "photos",
      "favorites",
      "articleImages",
    ]);
  });

  it("「お気に入り」を押すと場所を選び、選んでいる間は aria-current。見出しの「＋」は「写真」「お気に入り」で出す", async () => {
    await render("photos", { photos: 2, favorites: 1, articleImages: 1 });
    await act(async () => {
      treeNodes()[1]?.click();
    });
    expect(selected).toEqual(["favorites"]);

    await render("favorites", { photos: 2, favorites: 1, articleImages: 1 });
    expect(treeNodes().map((node) => node.getAttribute("aria-current"))).toEqual([null, "true", null]);
    // 上段と木の見出しの両方に「＋」
    expect(addButtons()).toHaveLength(2);

    await render("articleImages", { photos: 2, favorites: 1, articleImages: 1 });
    expect(addButtons()).toHaveLength(0);
  });

  it("場所の名前（パンくずと同じ）", () => {
    expect(browserPhotoPlaceLabel("photos")).toBe("写真");
    expect(browserPhotoPlaceLabel("favorites")).toBe("お気に入り");
    expect(browserPhotoPlaceLabel("articleImages")).toBe("記事の画像");
    expect(browserPhotoPlaceLabel("album:album-1", [{ id: "album-1", name: "旅", photoCount: 2, cover: null }])).toBe("旅");
    // この Mac のフォルダ（NIHO camera C3 移行元設計）は木の中の名前（入れ子も）。見つからなければ「フォルダ」
    const folders = [{ folderId: "f1", name: "旅行", truncated: false, children: [{ folderId: "f1a", name: "京都", truncated: false, children: [] }] }];
    expect(browserPhotoPlaceLabel("folder:f1a", [], folders)).toBe("京都");
    expect(browserPhotoPlaceLabel("folder:missing", [], folders)).toBe("フォルダ");
  });

  it("アルバムを API の順で「お気に入り」と「記事の画像」の間に件数つきで出し、場所として選べる", async () => {
    const albums = [
      { id: "album-1", name: "旅", photoCount: 2, cover: null },
      { id: "album-2", name: "日々", photoCount: 0, cover: { photoId: "p1", imageUrl: "https://storage.test/p1.jpg" } },
    ];
    await render("album:album-1", { photos: 20, favorites: 3, articleImages: 1 }, albums);
    expect(treeNodes().map((node) => node.textContent)).toEqual(["写真20", "お気に入り3", "旅2", "日々0", "記事の画像1"]);
    expect(treeNodes().map((node) => node.getAttribute("aria-current"))).toEqual([null, null, "true", null, null]);
    await act(async () => treeNodes()[3]?.click());
    expect(selected).toEqual(["album:album-2"]);
  });

  it("アルバムが多いときに左の木を縦にスクロールできる", async () => {
    const albums = Array.from({ length: 80 }, (_, index) => ({
      id: `album-${index}`,
      name: `アルバム ${index}`,
      photoCount: index,
      cover: null,
    }));
    await render("photos", { photos: 1, favorites: 0, articleImages: 0 }, albums);
    const tree = container.querySelector<HTMLElement>('aside[aria-label="写真の場所"]');
    expect(tree?.className).toContain("overflow-y-auto");
    expect(treeNodes()).toHaveLength(albums.length + 2);
  });
});

describe("狭い幅の上段のチップ", () => {
  it("1 行で「写真」「♥」「記事の画像」。♥ はアイコンだけで、読み上げ名「お気に入り」で押せる", async () => {
    await render("photos", { photos: 2, favorites: 1, articleImages: 1 });
    const [photos, favorites, articleImages] = chips();
    expect(chips()).toHaveLength(3);
    expect(photos?.textContent).toBe("写真");
    expect(favorites?.getAttribute("aria-label")).toBe("お気に入り");
    expect(favorites?.textContent).toBe("");
    expect(favorites?.querySelector("svg")).not.toBeNull();
    expect(articleImages?.textContent).toBe("記事の画像");

    await act(async () => {
      favorites?.click();
    });
    expect(selected).toEqual(["favorites"]);
  });

  it("選んでいるチップは aria-current（♥ も同じ見た目）。「お気に入り」を見ている間も右端に「＋」", async () => {
    await render("favorites", { photos: 2, favorites: 0, articleImages: 0 });
    expect(chips().map((chip) => chip.getAttribute("aria-label") ?? chip.textContent)).toEqual(["写真", "お気に入り"]);
    expect(chips().map((chip) => chip.getAttribute("aria-current"))).toEqual([null, "true"]);
    expect(chips()[1]?.className).toContain("bg-niho-accent-soft");
    expect(container.firstElementChild?.querySelector('button[aria-label="写真を追加"]')).not.toBeNull();
  });

  it("アルバムも同じ 1 行の横送りチップで選べる", async () => {
    await render("album:album-1", { photos: 2, favorites: 0, articleImages: 1 }, [
      { id: "album-1", name: "旅", photoCount: 4, cover: null },
    ]);
    expect(chips().map((chip) => chip.getAttribute("aria-label") ?? chip.textContent)).toEqual([
      "写真",
      "お気に入り",
      "旅4",
      "記事の画像",
    ]);
    expect(chips()[2]?.getAttribute("aria-current")).toBe("true");
    expect(container.firstElementChild?.querySelector(".overflow-x-auto")).not.toBeNull();
  });
});
