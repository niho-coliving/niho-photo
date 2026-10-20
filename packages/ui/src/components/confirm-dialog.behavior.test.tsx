// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Dialog portals + focus-traps, which is unstable under jsdom. Mock the
// presentational primitive to a passthrough so the real ConfirmDialog wiring
// (same-tick confirm guard, pending locks, touch targets) renders in-container
// and is clickable. The guard logic under test lives in ConfirmDialog itself,
// not in the Dialog primitive, so this keeps the behavioral assertion honest.
// The static confirm-dialog.test.tsx separately guards that the real shared
// Dialog primitive stays wired.
vi.mock("./dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) =>
    open ? (
      <div data-testid="dialog">
        <button
          type="button"
          data-testid="dialog-close-request"
          onClick={() => onOpenChange(false)}
        >
          close request
        </button>
        {children}
      </div>
    ) : null,
  DialogContent: ({
    children,
    hideClose,
    "aria-busy": ariaBusy,
    onEscapeKeyDown,
    onPointerDownOutside,
  }: {
    children: ReactNode;
    hideClose?: boolean;
    "aria-busy"?: boolean;
    onEscapeKeyDown?: (event: Event) => void;
    onPointerDownOutside?: (event: Event) => void;
  }) => (
    <div data-testid="dialog-content" aria-busy={ariaBusy}>
      {!hideClose ? (
        <button type="button" aria-label="Close">
          close
        </button>
      ) : null}
      <button
        type="button"
        data-testid="dialog-escape-request"
        onClick={(clickEvent) => {
          const event = new Event("escape", { cancelable: true });
          onEscapeKeyDown?.(event);
          clickEvent.currentTarget.dataset.prevented = String(
            event.defaultPrevented,
          );
        }}
      >
        escape request
      </button>
      <button
        type="button"
        data-testid="dialog-overlay-request"
        onClick={(clickEvent) => {
          const event = new Event("pointerdownoutside", { cancelable: true });
          onPointerDownOutside?.(event);
          clickEvent.currentTarget.dataset.prevented = String(
            event.defaultPrevented,
          );
        }}
      >
        overlay request
      </button>
      {children}
    </div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

type ConfirmDialogProps = Parameters<typeof ConfirmDialog>[0];

describe("ConfirmDialog same-tick submit guard", () => {
  let container: HTMLDivElement;
  let root: Root;

  function baseProps(): ConfirmDialogProps {
    return {
      open: true,
      onOpenChange: vi.fn(),
      title: "在館中の会員をチェックアウトします",
      confirmLabel: "チェックアウトする",
      onConfirm: vi.fn(),
    };
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  async function renderDialog(props: ConfirmDialogProps) {
    await act(async () => {
      root.render(<ConfirmDialog {...props} />);
    });
  }

  function findButton(label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes(label),
    );
    if (!button) throw new Error(`button not found: ${label}`);
    return button as HTMLButtonElement;
  }

  function findByTestId(testId: string): HTMLButtonElement {
    const element = container.querySelector(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`element not found: ${testId}`);
    return element as HTMLButtonElement;
  }

  it("同一 tick の確認連打でも onConfirm は1回しか呼ばない（二重送信防止）", async () => {
    const onConfirm = vi.fn();
    await renderDialog({ ...baseProps(), onConfirm });

    const confirmButton = findButton("チェックアウトする");
    await act(async () => {
      confirmButton.click();
      confirmButton.click();
      confirmButton.click();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("isPending 中は確認・キャンセルの両方を disabled にして再送信を止める", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    await renderDialog({ ...baseProps(), onConfirm, onOpenChange });

    await act(async () => {
      findButton("チェックアウトする").click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // 親が mutation 実行中に isPending へ遷移する典型フロー。
    await renderDialog({ ...baseProps(), onConfirm, onOpenChange, isPending: true });

    const confirmButton = findButton("チェックアウトする");
    const cancelButton = findButton("キャンセル");
    expect(confirmButton.disabled).toBe(true);
    expect(cancelButton.disabled).toBe(true);

    await act(async () => {
      confirmButton.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("isPending 中は進行中の文言とlive statusを支援技術へ通知する", async () => {
    await renderDialog({
      ...baseProps(),
      isPending: true,
      pendingLabel: "チェックアウト中…",
    });

    expect(findButton("チェックアウト中…").disabled).toBe(true);
    expect(findByTestId("dialog-content").getAttribute("aria-busy")).toBe(
      "true",
    );
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("チェックアウト中…");
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });

  it("dismissDisabled 中は全ての閉じる経路を止めても確認操作は許可する", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    await renderDialog({
      ...baseProps(),
      onConfirm,
      onOpenChange,
      dismissDisabled: true,
    });

    const confirmButton = findButton("チェックアウトする");
    const cancelButton = findButton("キャンセル");
    expect(confirmButton.disabled).toBe(false);
    expect(cancelButton.disabled).toBe(true);
    expect(container.querySelector('[aria-label="Close"]')).toBeNull();

    await act(async () => {
      findByTestId("dialog-close-request").click();
      findByTestId("dialog-escape-request").click();
      findByTestId("dialog-overlay-request").click();
      cancelButton.click();
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(findByTestId("dialog-escape-request").dataset.prevented).toBe("true");
    expect(findByTestId("dialog-overlay-request").dataset.prevented).toBe("true");

    await act(async () => {
      confirmButton.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("isPending 中も Escape・overlay・X による閉鎖を止める", async () => {
    const onOpenChange = vi.fn();
    await renderDialog({ ...baseProps(), onOpenChange, isPending: true });

    expect(container.querySelector('[aria-label="Close"]')).toBeNull();
    await act(async () => {
      findByTestId("dialog-close-request").click();
      findByTestId("dialog-escape-request").click();
      findByTestId("dialog-overlay-request").click();
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(findByTestId("dialog-escape-request").dataset.prevented).toBe("true");
    expect(findByTestId("dialog-overlay-request").dataset.prevented).toBe("true");
  });

  it("confirmDisabled のときは確認を押しても onConfirm を呼ばない", async () => {
    const onConfirm = vi.fn();
    await renderDialog({ ...baseProps(), onConfirm, confirmDisabled: true });

    await act(async () => {
      findButton("チェックアウトする").click();
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("errorMessage は共通バナー（エラー）として表示する", async () => {
    await renderDialog({ ...baseProps(), errorMessage: "チェックアウトに失敗しました" });

    expect(container.textContent).toContain("エラー");
    expect(container.textContent).toContain("チェックアウトに失敗しました");
  });

  it("確認・キャンセルボタンは 44px 以上のタッチターゲットを維持する", async () => {
    await renderDialog(baseProps());

    expect(findButton("チェックアウトする").className).toContain("min-h-11");
    expect(findButton("キャンセル").className).toContain("min-h-11");
  });
});
