// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings, readDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import { writeEffectValue, writeGrayscale } from "../photo-editing-effects";
import type { DevelopSession, OpenedSource } from "./browser-photo-editing-model";
import { useBrowserPhotoEditSettings, type BrowserPhotoEditSettings } from "./use-browser-photo-edit-settings";

vi.mock("../library/photo-library-context", () => ({ usePhotoLibrary: () => ({}) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let edit: BrowserPhotoEditSettings;
const save = vi.fn();
const openedRef = { current: { mode: "wasm", decoded: null } as OpenedSource | null };
const sessionRef = {
  current: { input: { kind: "original" }, saver: { schedule: save } } as unknown as DevelopSession | null,
};

function Harness() {
  edit = useBrowserPhotoEditSettings({
    canEdit: true,
    openedRef,
    operationRef: { current: null },
    leavingRef: { current: null },
    developSessionRef: sessionRef,
    setStatus: () => undefined,
    setCompareOriginal: () => undefined,
  });
  return null;
}

beforeEach(async () => {
  save.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => edit.loadSettings(neutralDevelopSettings(), { history: true }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("画面内の効果操作は必要な編集形式へ昇格する", () => {
  const cases = [
    { name: "白黒", update: (settings: DevelopSettings) => writeGrayscale(settings, true), patch: { grayscale: true } },
    { name: "周辺光量", update: (settings: DevelopSettings) => writeEffectValue(settings, "vignetteAmount", -20), patch: { vignette: { amount: -20 } } },
    { name: "粒子", update: (settings: DevelopSettings) => writeEffectValue(settings, "grainAmount", 30), patch: { grain: { amount: 30 } } },
  ];
  it.each(cases)("新規写真の$nameを保存し、取り消し・やり直しできる", async ({ update, patch }) => {
    const neutral = { ...neutralDevelopSettings(), futureField: { retained: true } };
    await act(async () => edit.loadSettings(neutral, { history: true }));
    await act(async () => edit.changeSettings((current) => update(current as DevelopSettings), "commit"));
    const expected = { ...neutral, ...patch, v: 3 };
    expect(edit.settings).toEqual(expected);
    expect(save).toHaveBeenLastCalledWith(expected);
    await act(async () => edit.undo());
    expect(edit.settings).toEqual(neutral);
    expect(save).toHaveBeenLastCalledWith(neutral);
    await act(async () => edit.redo());
    expect(edit.settings).toEqual(expected);
    expect(save).toHaveBeenLastCalledWith(expected);
  });

  it("旧保存recipeのengine/base/lookと未知fieldを維持する", async () => {
    const legacy = { ...neutralDevelopSettings(), engine: "niho-2", base: "raw-apple.d8.p1.e1.cal-none", futureField: { retained: true } };
    await act(async () => edit.loadSettings(legacy, { history: true }));
    await act(async () => edit.changeSettings((current) => writeGrayscale(current, true), "commit"));
    expect(edit.settings).toEqual({ ...legacy, v: 3, grayscale: true });
    expect(save).toHaveBeenLastCalledWith({ ...legacy, v: 3, grayscale: true });
  });

  it("dragからcommitへ進んでも効果が消えず、1回の取り消しで戻る", async () => {
    await act(async () => edit.changeSettings((current) => writeEffectValue(current, "grainAmount", 30), "drag"));
    await act(async () => edit.changeSettings((current) => writeEffectValue(current, "grainAmount", 30), "commit"));
    expect(edit.settings).toMatchObject({ v: 3, grain: { amount: 30 } });
    await act(async () => edit.undo());
    expect(edit.settings).toEqual(neutralDevelopSettings());
    expect(edit.canUndo).toBe(false);
  });

  it("外部readerの低すぎる版、不明な版、不正なmaskの拒否を維持する", async () => {
    expect(readDevelopSettings(writeGrayscale(neutralDevelopSettings(), true))).toBeNull();
    await act(async () => edit.changeSettings((current) => ({ ...current, v: 99, grayscale: true }), "commit"));
    await act(async () => edit.changeSettings((current) => ({ ...current, masks: [{ invalid: true }] }), "commit"));
    expect(edit.settings).toEqual(neutralDevelopSettings());
    expect(save).not.toHaveBeenCalled();
    expect(edit.canUndo).toBe(false);
  });
});
