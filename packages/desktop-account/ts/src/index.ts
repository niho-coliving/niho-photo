import contract from "../../contract/native-account-v2.json";

export const ACCOUNT_CONTRACT = contract;
export type AccountPhase = "local_only" | "signed_out" | "waiting" | "refreshing" | "connected" | "offline" | "failed";
export type AccountError = "not_configured" | "invalid_config" | "busy" | "cancelled" | "expired" |
  "invalid_redirect" | "invalid_state" | "invalid_response" | "rejected" | "network" | "paused" | "account_unavailable" | "browser" | "storage" | "internal";
export type AccountSnapshot = {
  contractVersion: number;
  phase: AccountPhase;
  available: boolean;
  localEditingAvailable: true;
  error: AccountError | null;
};
export const LOCAL_ACCOUNT: AccountSnapshot = {
  contractVersion: contract.version, phase: "local_only", available: false, localEditingAvailable: true, error: null,
};

/** UI/telemetryへ未知のnative error文やresponseを流さず、固定契約へ絞る。 */
export function parseAccountSnapshot(value: unknown): AccountSnapshot {
  if (!value || typeof value !== "object") return { ...LOCAL_ACCOUNT };
  const state = value as Record<string, unknown>;
  if (Object.keys(state).some((key) => !["contractVersion", "phase", "available", "localEditingAvailable", "error"].includes(key)) ||
    state.contractVersion !== contract.version || (typeof state.phase !== "string" || !contract.phases.includes(state.phase)) ||
    typeof state.available !== "boolean" || state.localEditingAvailable !== true ||
    !(state.error === null || (typeof state.error === "string" && contract.errorCodes.includes(state.error))) ||
    (!state.available && state.phase !== "local_only") || (state.available && state.phase === "local_only")) return { ...LOCAL_ACCOUNT };
  return { contractVersion: contract.version, phase: state.phase as AccountPhase, available: state.available,
    localEditingAvailable: true, error: state.error as AccountError | null };
}

const ERROR_TEXT: Record<AccountError, string> = {
  not_configured: "アカウント接続は準備中です。写真はこのMacで編集できます。",
  invalid_config: "アカウント接続を利用できません。写真はこのMacで編集できます。",
  busy: "ブラウザでのログインを待っています。",
  cancelled: "ログインを取り消しました。",
  expired: "ログインの有効期限が切れました。もう一度ログインしてください。",
  invalid_redirect: "ログインを確認できませんでした。もう一度お試しください。",
  invalid_state: "ログインを確認できませんでした。もう一度お試しください。",
  invalid_response: "ログインを確認できませんでした。もう一度お試しください。",
  rejected: "ログインできませんでした。もう一度お試しください。",
  network: "接続できませんでした。ネットワークを確認して、もう一度お試しください。",
  paused: "アカウント接続を一時停止しています。写真はこのMacで編集できます。",
  account_unavailable: "このアカウントを利用できません。写真はこのMacで編集できます。",
  browser: "ブラウザを開けませんでした。もう一度お試しください。",
  storage: "アカウントの保存先にアクセスできませんでした。もう一度お試しください。",
  internal: "アカウント接続を利用できません。写真はこのMacで編集できます。",
};
export function accountMessage(state: AccountSnapshot): string {
  if (state.error) return ERROR_TEXT[state.error];
  switch (state.phase) {
    case "local_only": return ERROR_TEXT.not_configured;
    case "signed_out": return "写真はログインせずに、このMacで編集できます。";
    case "waiting": return "ブラウザでログインしてください。このMacでの編集は続けられます。";
    case "refreshing": return "アカウント接続を更新しています。編集は続けられます。";
    case "offline": return "オフラインです。写真はこのMacで編集できます。";
    case "connected": return "ログインしています。写真はこのMacに保存されます。";
    case "failed": return ERROR_TEXT.internal;
  }
}
export interface AccountBridge {
  read(): Promise<AccountSnapshot>;
  login(): Promise<void>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}
