/**
 * 使用量の表示（例: 「1.2 / 5 GB」。NIHO camera C1 移行元設計 で web の photo-cloud-admin から移した。web は同じ関数を再 export する）。
 */

const BYTES_PER_GB = 1024 ** 3;

/**
 * バイト数を GB の数字にする（上限の 5GiB が「5」になるよう 1024³ で割る）。1 未満は小数 2 桁、1 以上は 1 桁で、
 * 末尾の 0 は落とす。0 より大きければ 0 と出さない（RAW 1 枚でも「0.03」）。
 */
export function formatPhotoCloudGigabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  const value = bytes / BYTES_PER_GB;
  const digits = value < 1 ? 2 : 1;
  const scale = 10 ** digits;
  const rounded = Math.max(Math.round(value * scale), 1) / scale;
  return rounded.toFixed(digits).replace(/\.?0+$/, "");
}

/** 使用量と上限（例: 「1.2 / 5 GB」。上限は API の値）。 */
export function formatPhotoCloudUsage(usage: { usedBytes: number; quotaBytes: number }): string {
  return `${formatPhotoCloudGigabytes(usage.usedBytes)} / ${formatPhotoCloudGigabytes(usage.quotaBytes)} GB`;
}

/**
 * 使用量の内訳（例: 「オリジナル 1.0 GB・サムネイルと記事の画像 0.2 GB」。移行元設計）。残りは使用量 − 元の写真で、2 つを足すと使用量に
 * なる。作業コピーはどちらにも数えない（使用量に入らない）。内訳を返さない古い API・何も置いていないときは null。
 */
export function formatPhotoCloudUsageBreakdown(usage: { usedBytes: number; originalBytes?: number }): string | null {
  if (usage.originalBytes === undefined || usage.usedBytes <= 0) return null;
  const otherBytes = Math.max(0, usage.usedBytes - usage.originalBytes);
  return `オリジナル ${formatPhotoCloudGigabytes(usage.originalBytes)} GB・サムネイルと記事の画像 ${formatPhotoCloudGigabytes(otherBytes)} GB`;
}
