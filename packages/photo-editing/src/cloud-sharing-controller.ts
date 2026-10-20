import type {
  CloudClient,
  CloudError,
  CloudErrorCode,
  CloudResourceRef,
  MutationHeaders,
  ShareCreateRequest,
  ShareCreateResponse,
  ShareListItem,
  ShareRevokeRequest,
  ShareRevokeResponse,
} from "./cloud-sharing-contract.js";

export type PhotoCloudSharingAccess = "available" | "offline" | "signed-out" | "unavailable";

export type PhotoCloudSharePhase =
  | "target-confirmation"
  | "creating"
  | "created"
  | "listing"
  | "ready"
  | "revoking"
  | "cancelled"
  | "retryable-failure"
  | "nonretryable-failure"
  | "offline"
  | "signed-out"
  | "not-found-permission"
  | "quota"
  | "expired";

export interface PhotoCloudShareState {
  readonly phase: PhotoCloudSharePhase;
  readonly items: readonly ShareListItem[];
  readonly shareUrl: string | null;
  readonly message: string | null;
  readonly errorCode: CloudErrorCode | null;
  readonly pendingRevokeShareId: string | null;
  readonly resumableMutation: "create" | "revoke" | null;
  readonly mutationInFlight: boolean;
  readonly reconciliationNeeded: boolean;
}

type CreateMutation = {
  readonly kind: "create";
  readonly request: ShareCreateRequest;
  readonly headers: MutationHeaders;
};

type RevokeMutation = {
  readonly kind: "revoke";
  readonly request: ShareRevokeRequest;
  readonly headers: MutationHeaders;
};

type ShareMutation = CreateMutation | RevokeMutation;
type RetryAction = "create" | "list" | "revoke" | null;

const ERROR_COPY: Readonly<Record<CloudErrorCode, string>> = {
  invalid_request: "共有の内容を確認できませんでした。画面を閉じて、もう一度やり直してください。",
  unauthenticated: "ログインが切れています。もう一度ログインしてからお試しください。",
  not_found: "この写真が見つからないか、共有する権限がありません。",
  capability_expired: "共有の有効期限が切れています。共有一覧を更新してください。",
  capability_revoked: "この共有はすでに停止されています。共有一覧を更新してください。",
  capability_replayed: "この共有操作はすでに使われています。共有一覧を更新してください。",
  idempotency_conflict: "同じ操作として扱えない変更がありました。共有一覧を更新してからやり直してください。",
  quota_exceeded: "共有できる上限に達しました。不要な共有を停止してからお試しください。",
  content_rejected: "この写真は共有できません。写真を確認してからやり直してください。",
  rate_limited: "操作が続いたため、少し待ってからもう一度お試しください。",
  temporarily_unavailable: "共有サービスに接続できませんでした。時間をおいてもう一度お試しください。",
};

export function photoCloudShareErrorMessage(code: CloudErrorCode): string {
  return ERROR_COPY[code];
}

function unavailablePhase(access: Exclude<PhotoCloudSharingAccess, "available">): Pick<PhotoCloudShareState, "phase" | "message"> {
  if (access === "offline") {
    return { phase: "offline", message: "オフラインです。通信を確認してから共有一覧を更新してください。" };
  }
  if (access === "signed-out") {
    return { phase: "signed-out", message: "共有するにはログインが必要です。ログインしてからもう一度お試しください。" };
  }
  return { phase: "nonretryable-failure", message: "この環境ではクラウド共有を利用できません。" };
}

function phaseForError(error: CloudError): PhotoCloudSharePhase {
  switch (error.code) {
    case "unauthenticated":
      return "signed-out";
    case "not_found":
      return "not-found-permission";
    case "quota_exceeded":
      return "quota";
    case "capability_expired":
    case "capability_revoked":
    case "capability_replayed":
      return "expired";
    case "invalid_request":
    case "idempotency_conflict":
    case "content_rejected":
      return "nonretryable-failure";
    case "rate_limited":
    case "temporarily_unavailable":
      return error.retryable ? "retryable-failure" : "nonretryable-failure";
  }
}

function sameResource(left: CloudResourceRef | null, right: CloudResourceRef | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.resourceType === right.resourceType &&
    left.resourceId === right.resourceId &&
    left.ownerType === right.ownerType &&
    left.ownerId === right.ownerId &&
    left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId;
}

function initialState(access: PhotoCloudSharingAccess, target: CloudResourceRef | null): PhotoCloudShareState {
  if (access !== "available") {
    return {
      ...unavailablePhase(access),
      items: [],
      shareUrl: null,
      errorCode: null,
      pendingRevokeShareId: null,
      resumableMutation: null,
      mutationInFlight: false,
      reconciliationNeeded: false,
    };
  }
  return {
    phase: target ? "target-confirmation" : "not-found-permission",
    items: [],
    shareUrl: null,
    message: target ? null : "この写真はクラウド共有の対象として確認できませんでした。",
    errorCode: null,
    pendingRevokeShareId: null,
    resumableMutation: null,
    mutationInFlight: false,
    reconciliationNeeded: false,
  };
}

export interface PhotoCloudShareControllerOptions {
  readonly client: CloudClient;
  readonly access: PhotoCloudSharingAccess;
  readonly target: CloudResourceRef | null;
  readonly createIdempotencyKey?: () => string;
  readonly now?: () => number;
}

/**
 * UI-framework independent share flow. Resource fields are selectors supplied
 * by a trusted host adapter; this controller never derives authority from them.
 */
export class PhotoCloudShareController {
  readonly #client: CloudClient;
  readonly #createIdempotencyKey: () => string;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #state: PhotoCloudShareState;
  #access: PhotoCloudSharingAccess;
  #target: CloudResourceRef | null;
  #activeMutation: ShareMutation | null = null;
  #retryAction: RetryAction = null;
  #contextVersion = 0;
  #responseVersion = 0;
  #disposed = false;
  #inFlightMutation: { readonly context: number; readonly mutation: ShareMutation } | null = null;
  #listInFlight: { readonly context: number; readonly response: number } | null = null;

  constructor(options: PhotoCloudShareControllerOptions) {
    this.#client = options.client;
    this.#access = options.access;
    this.#target = options.target;
    this.#createIdempotencyKey = options.createIdempotencyKey ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? Date.now;
    this.#state = initialState(options.access, options.target);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): PhotoCloudShareState => this.#state;

  #publish(next: PhotoCloudShareState): void {
    if (this.#disposed) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #patch(patch: Partial<PhotoCloudShareState>): void {
    this.#publish({ ...this.#state, ...patch });
  }

  #isCurrent(context: number, response: number): boolean {
    return !this.#disposed && context === this.#contextVersion && response === this.#responseVersion;
  }

  setAccess(access: PhotoCloudSharingAccess): void {
    if (access === this.#access) return;
    this.#access = access;
    this.#contextVersion += 1;
    this.#responseVersion += 1;
    this.#retryAction = null;
    this.#listInFlight = null;
    const mutation = this.#activeMutation;
    if (!mutation) {
      this.#publish(initialState(this.#access, this.#target));
      return;
    }
    const base = initialState(this.#access, this.#target);
    this.#publish({
      ...base,
      phase: access === "available" ? "cancelled" : base.phase,
      message: access === "available"
        ? "通信状態が変わりました。サーバー側で完了している場合があるため、共有一覧を更新してください。"
        : base.message,
      resumableMutation: mutation.kind,
      mutationInFlight: this.#inFlightMutation !== null,
      reconciliationNeeded: true,
    });
  }

  setTarget(target: CloudResourceRef | null): void {
    if (sameResource(target, this.#target)) return;
    this.#target = target;
    this.#resetContext();
  }

  #resetContext(): void {
    this.#contextVersion += 1;
    this.#responseVersion += 1;
    this.#activeMutation = null;
    this.#retryAction = null;
    this.#inFlightMutation = null;
    this.#listInFlight = null;
    this.#publish(initialState(this.#access, this.#target));
  }

  create(expiresAt: string): void {
    if (this.#access !== "available" || !this.#target || this.#activeMutation || this.#inFlightMutation) return;
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.#now()) {
      this.#patch({
        phase: "nonretryable-failure",
        shareUrl: null,
        message: "有効期限を確認して、もう一度お試しください。",
        errorCode: "invalid_request",
      });
      return;
    }
    const mutation: CreateMutation = {
      kind: "create",
      request: { resource: this.#target, permission: "read", expiresAt },
      headers: { "Idempotency-Key": this.#createIdempotencyKey() },
    };
    this.#activeMutation = mutation;
    this.#runMutation(mutation);
  }

  revoke(shareId: string): void {
    if (this.#access !== "available" || !this.#target || this.#activeMutation || this.#inFlightMutation) return;
    const listed = this.#state.items.find((item) => item.shareId === shareId && item.revokedAt === null);
    if (!listed || !sameResource(listed.resource, this.#target)) return;
    const mutation: RevokeMutation = {
      kind: "revoke",
      request: { shareId: listed.shareId },
      headers: { "Idempotency-Key": this.#createIdempotencyKey() },
    };
    this.#activeMutation = mutation;
    this.#runMutation(mutation);
  }

  retry(): void {
    if (this.#state.phase !== "retryable-failure") return;
    if (this.#retryAction === "list") {
      this.refresh();
      return;
    }
    this.resumeMutation();
  }

  resumeMutation(): void {
    if (!this.#activeMutation || this.#inFlightMutation || this.#access !== "available") return;
    this.#runMutation(this.#activeMutation);
  }

  async #runMutation(mutation: ShareMutation): Promise<void> {
    if (this.#inFlightMutation) return;
    const context = this.#contextVersion;
    const response = ++this.#responseVersion;
    const operation = { context, mutation };
    this.#inFlightMutation = operation;
    this.#retryAction = mutation.kind;
    this.#patch({
      phase: mutation.kind === "create" ? "creating" : "revoking",
      shareUrl: null,
      message: null,
      errorCode: null,
      pendingRevokeShareId: mutation.kind === "revoke" ? mutation.request.shareId : null,
      resumableMutation: mutation.kind,
      mutationInFlight: true,
    });

    let result;
    try {
      result = mutation.kind === "create"
        ? await this.#client["share.create"](mutation.request, mutation.headers)
        : await this.#client["share.revoke"](mutation.request, mutation.headers);
    } catch {
      result = {
        ok: false as const,
        error: { code: "temporarily_unavailable" as const, requestId: "client-transport", retryable: true },
      };
    }

    const ownedInFlight = this.#inFlightMutation === operation;
    if (ownedInFlight) this.#inFlightMutation = null;
    if (!this.#isCurrent(context, response)) {
      if (!this.#disposed && ownedInFlight) this.#patch({ mutationInFlight: false });
      return;
    }
    if (!result.ok) {
      this.#applyError(result.error, mutation.kind);
      return;
    }

    this.#activeMutation = null;
    this.#retryAction = null;
    if (mutation.kind === "create") {
      const value = result.value as ShareCreateResponse;
      const items = [value.share, ...this.#state.items.filter((item) => item.shareId !== value.share.shareId)];
      this.#patch({
        phase: "created",
        items,
        shareUrl: value.shareUrl,
        message: "共有リンクを作成しました。",
        errorCode: null,
        pendingRevokeShareId: null,
        resumableMutation: null,
        mutationInFlight: false,
        reconciliationNeeded: false,
      });
      return;
    }

    const value = result.value as ShareRevokeResponse;
    this.#patch({
      phase: "ready",
      items: this.#state.items.map((item) => item.shareId === value.shareId
        ? { ...item, revokedAt: value.revokedAt }
        : item),
      shareUrl: null,
      message: "共有を停止しました。",
      errorCode: null,
      pendingRevokeShareId: null,
      resumableMutation: null,
      mutationInFlight: false,
      reconciliationNeeded: false,
    });
  }

  refresh(): void {
    if (this.#access !== "available" || !this.#target || this.#listInFlight || this.#inFlightMutation) return;
    const context = this.#contextVersion;
    const response = ++this.#responseVersion;
    const operation = { context, response };
    this.#listInFlight = operation;
    this.#retryAction = "list";
    this.#patch({
      phase: "listing",
      shareUrl: null,
      message: null,
      errorCode: null,
      pendingRevokeShareId: null,
    });
    const request = { resourceType: this.#target.resourceType, resourceId: this.#target.resourceId } as const;
    void this.#client["share.list"](request).catch(() => ({
      ok: false as const,
      error: { code: "temporarily_unavailable" as const, requestId: "client-transport", retryable: true },
    })).then((result) => {
      if (this.#listInFlight === operation) this.#listInFlight = null;
      if (!this.#isCurrent(context, response)) return;
      if (!result.ok) {
        this.#applyError(result.error, "list");
        return;
      }
      this.#retryAction = null;
      this.#patch({
        phase: "ready",
        items: result.value.items,
        shareUrl: null,
        message: result.value.items.length === 0 ? "共有中のリンクはありません。" : null,
        errorCode: null,
        pendingRevokeShareId: null,
        mutationInFlight: this.#inFlightMutation !== null,
      });
    });
  }

  #applyError(error: CloudError, action: Exclude<RetryAction, null>): void {
    const phase = phaseForError(error);
    if (phase !== "retryable-failure") {
      if (action !== "list") this.#activeMutation = null;
      this.#retryAction = null;
    }
    this.#patch({
      phase,
      shareUrl: null,
      message: photoCloudShareErrorMessage(error.code),
      errorCode: error.code,
      pendingRevokeShareId: null,
      resumableMutation: action === "list"
        ? this.#state.resumableMutation
        : phase === "retryable-failure"
          ? action
          : null,
      mutationInFlight: action === "list" && this.#inFlightMutation !== null,
      reconciliationNeeded: action === "list"
        ? this.#state.reconciliationNeeded
        : phase === "retryable-failure",
    });
  }

  cancel(): void {
    const mutation = this.#activeMutation;
    this.#responseVersion += 1;
    this.#retryAction = null;
    this.#patch({
      phase: "cancelled",
      shareUrl: null,
      message: mutation
        ? "画面上の待機を止めました。サーバー側で完了している場合があるため、共有一覧を更新してください。"
        : "操作を中止しました。",
      errorCode: null,
      pendingRevokeShareId: null,
      resumableMutation: mutation?.kind ?? null,
      mutationInFlight: this.#inFlightMutation !== null,
      reconciliationNeeded: mutation !== null,
    });
  }

  close(): void {
    this.#contextVersion += 1;
    this.#responseVersion += 1;
    this.#activeMutation = null;
    this.#retryAction = null;
    this.#inFlightMutation = null;
    this.#listInFlight = null;
    this.#state = { ...this.#state, phase: "cancelled", shareUrl: null, items: [] };
  }

  dispose(): void {
    this.close();
    this.#disposed = true;
    this.#listeners.clear();
  }
}
