// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DevelopSession, PhotoEditingLeaveGuard } from "./browser-photo-editing-model";
import { useBrowserPhotoLeaveGuards } from "./use-browser-photo-leave-guards";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function setup(onGuard: (guard: PhotoEditingLeaveGuard) => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const session = { key: "photo", photoId: "photo", spotId: "local" } as DevelopSession;
  const developSessionRef = { current: session };
  const leaveEditing = vi.fn(async (_options: { release: boolean }) => true);

  function Harness() {
    const guard = useBrowserPhotoLeaveGuards({
      unloadGuarded: false,
      guarded: false,
      dirty: false,
      operationRef: { current: null },
      saveGenerationRef: { current: 0 },
      addQueue: { running: false },
      developSessionRef,
      leaveEditing,
      active: true,
      openCloudPhotoId: null,
    });
    useEffect(() => onGuard(guard), [guard]);
    return null;
  }

  return { Harness, leaveEditing };
}

describe("useBrowserPhotoLeaveGuards", () => {
  it("flushes the open edit without releasing its session for a copy action", async () => {
    let guard: PhotoEditingLeaveGuard | null = null;
    const { Harness, leaveEditing } = setup((registered) => { guard = registered; });
    await act(async () => root.render(<Harness />));

    let result: boolean | null = null;
    await act(async () => { result = await guard?.({ release: false }) ?? null; });

    expect(result).toBe(true);
    expect(leaveEditing).toHaveBeenCalledWith({ release: false });
  });

  it("releases the open edit for an actual route leave by default", async () => {
    let guard: PhotoEditingLeaveGuard | null = null;
    const { Harness, leaveEditing } = setup((registered) => { guard = registered; });
    await act(async () => root.render(<Harness />));

    let result: boolean | null = null;
    await act(async () => { result = await guard?.() ?? null; });

    expect(result).toBe(true);
    expect(leaveEditing).toHaveBeenCalledWith({ release: true });
  });
});
