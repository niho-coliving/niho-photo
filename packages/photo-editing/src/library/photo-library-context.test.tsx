// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhotoLibrary, PhotoLibraryCapabilities } from "./photo-library";
import {
  PhotoLibraryProvider,
  usePhotoEditingHost,
  usePhotoLibrary,
  usePhotoLibraryCapabilities,
  type PhotoEditingHost,
} from "./photo-library-context";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 中身を読まない口（Provider が受け渡すことだけを見る）。 */
const library = { place: "local" } as unknown as PhotoLibrary;

const host: PhotoEditingHost = {
  notifyPhotosChanged: vi.fn(),
  saveFile: vi.fn(async () => "saved" as const),
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PhotoLibraryProvider", () => {
  it("包んだ中の編集面に、渡した口とアプリの都合を渡す", () => {
    const seen: { library: PhotoLibrary | null; host: PhotoEditingHost | null } = { library: null, host: null };
    function Consumer() {
      seen.library = usePhotoLibrary();
      seen.host = usePhotoEditingHost();
      return null;
    }

    act(() =>
      root.render(
        <PhotoLibraryProvider library={library} host={host}>
          <Consumer />
        </PhotoLibraryProvider>,
      ),
    );

    expect(seen.library).toBe(library);
    expect(seen.host).toBe(host);
  });

  it("できることは、読めるまですぐ分かる値で描き、読めたら差し替える（口が変わったら読み直す）", async () => {
    const closed = { place: "local", nativeExport: false } as unknown as PhotoLibraryCapabilities;
    const ready = { place: "local", nativeExport: true } as unknown as PhotoLibraryCapabilities;
    let resolve: (value: PhotoLibraryCapabilities) => void = () => undefined;
    const withCapabilities = {
      place: "local",
      initialCapabilities: closed,
      capabilities: vi.fn(() => new Promise<PhotoLibraryCapabilities>((settle) => (resolve = settle))),
    } as unknown as PhotoLibrary;
    const seen: PhotoLibraryCapabilities[] = [];
    function Consumer() {
      seen.push(usePhotoLibraryCapabilities());
      return null;
    }

    act(() =>
      root.render(
        <PhotoLibraryProvider library={withCapabilities} host={host}>
          <Consumer />
        </PhotoLibraryProvider>,
      ),
    );
    expect(seen.at(-1)).toBe(closed);
    await act(async () => resolve(ready));
    expect(seen.at(-1)).toBe(ready);
    expect(withCapabilities.capabilities).toHaveBeenCalledTimes(1);
  });

  it("包まずに読むと、どこで包むかが分かる 1 行で投げる", () => {
    function Consumer() {
      usePhotoLibrary();
      return null;
    }
    // React（開発版）が投げ直す描画の失敗を、jsdom が標準エラーへ書かないようにする（投げたことは下の expect で見る）
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const silenceWindowError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", silenceWindowError);
    try {
      expect(() => act(() => root.render(<Consumer />))).toThrow("usePhotoLibrary must be used inside PhotoLibraryProvider");
    } finally {
      window.removeEventListener("error", silenceWindowError);
      consoleError.mockRestore();
    }
  });
});
