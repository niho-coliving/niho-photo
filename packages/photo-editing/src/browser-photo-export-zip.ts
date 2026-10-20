export type BrowserPhotoZipEntry = { name: string; blob: Blob };

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

async function crc32(blob: Blob, signal?: AbortSignal): Promise<number> {
  const reader = blob.stream().getReader();
  let crc = 0xffffffff;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function localHeader(name: Uint8Array<ArrayBuffer>, crc: number, size: number, date: number, time: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30 + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true);
  bytes.set(name, 30);
  return bytes;
}

function centralHeader(
  name: Uint8Array<ArrayBuffer>,
  crc: number,
  size: number,
  date: number,
  time: number,
  offset: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(46 + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, time, true);
  view.setUint16(14, date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  bytes.set(name, 46);
  return bytes;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, 0, true);
  return bytes;
}

/**
 * 写真を無圧縮（store）の ZIP にまとめる。JPEG・RAW は再圧縮の利得が小さいため、Blob を複製せず ZIP の部品として連結する。
 */
export async function createBrowserPhotoExportZip(
  entries: readonly BrowserPhotoZipEntry[],
  options: { signal?: AbortSignal; modifiedAt?: Date } = {},
): Promise<Blob> {
  if (entries.length > 0xffff) throw new Error("ZIP に入れるファイルが多すぎます。");
  const modified = dosDateTime(options.modifiedAt ?? new Date());
  const encoder = new TextEncoder();
  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (entry.blob.size > 0xffffffff) throw new Error("ZIP に入れるファイルが大きすぎます。");
    const name = encoder.encode(entry.name) as Uint8Array<ArrayBuffer>;
    const checksum = await crc32(entry.blob, options.signal);
    const local = localHeader(name, checksum, entry.blob.size, modified.date, modified.time);
    const central = centralHeader(name, checksum, entry.blob.size, modified.date, modified.time, localOffset);
    localParts.push(local, entry.blob);
    centralParts.push(central);
    localOffset += local.byteLength + entry.blob.size;
    centralSize += central.byteLength;
  }
  return new Blob(
    [...localParts, ...centralParts, endOfCentralDirectory(entries.length, centralSize, localOffset)],
    { type: "application/zip" },
  );
}
