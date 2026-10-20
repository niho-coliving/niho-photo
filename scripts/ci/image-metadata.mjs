// Container-level inspection complements exact inventory hashes. Values are never returned.
export function imageMetadataFailures(name, bytes) {
  const extension = name.toLowerCase().split('.').at(-1);
  const failures = [];
  if (extension === 'jpg' || extension === 'jpeg') {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return ['JPEGヘッダー不正'];
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 255 || offset + 3 >= bytes.length) return ['JPEG構造不正'];
      const marker = bytes[offset + 1];
      if (marker === 0xd9) {
        if (offset !== bytes.length - 2) return ['JPEG終端以降のデータ'];
        break;
      }
      const size = bytes.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > bytes.length) return ['JPEG構造不正'];
      const payload = bytes.subarray(offset + 4, offset + 2 + size);
      // A synthetic orientation-only IFD is functional image data; all other EXIF is rejected.
      const orientationOnly = marker === 0xe1 && payload.length === 32 && payload.subarray(0, 14).equals(Buffer.from([69,120,105,102,0,0,73,73,42,0,8,0,0,0])) && payload.readUInt16LE(14) === 1 && payload.readUInt16LE(16) === 0x112 && payload.readUInt16LE(18) === 3 && payload.readUInt32LE(20) === 1 && payload.readUInt16LE(24) >= 1 && payload.readUInt16LE(24) <= 8 && payload.readUInt16LE(26) === 0 && payload.readUInt32LE(28) === 0;
      if ([0xe1, 0xe2, 0xed, 0xfe].includes(marker) && !orientationOnly) failures.push('JPEGにEXIF/XMP/ICC/IPTC/comment');
      if (marker === 0xda) {
        if (bytes.length < offset + 2 + size + 2 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return ['JPEG終端不正'];
        // JPEGの圧縮データ内のFFは00でエスケープされる。後続scan間のAPP/COMも拒否する。
        for (let index = offset + 2 + size; index < bytes.length - 2; index++) {
          if (bytes[index] === 0xff && [0xe1, 0xe2, 0xed, 0xfe].includes(bytes[index + 1])) failures.push('JPEGにEXIF/XMP/ICC/IPTC/comment');
        }
        break;
      }
      offset += 2 + size;
    }
  }
  if (extension === 'png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['PNGヘッダー不正'];
    let offset = 8, ended = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) return ['PNG構造不正'];
      const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + size > bytes.length) return ['PNG構造不正'];
      if (!['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB'].includes(type)) failures.push('PNGに不要metadata');
      if (type === 'IEND') {
        if (size !== 0 || offset + 12 !== bytes.length) failures.push('PNG終端以降のデータ');
        ended = true;
        break;
      }
      offset += 12 + size;
    }
    if (!ended) failures.push('PNG終端不正');
  }
  if (extension === 'rw2') {
    // Only the audited, repacked v5-v7 layout is accepted. Other RAW containers require a new audit.
    if (bytes.length < 32 || !bytes.subarray(0, 4).equals(Buffer.from([73, 73, 85, 0]))) return ['RW2ヘッダー不正'];
    const offset = bytes.readUInt32LE(4);
    if (offset !== 24 || offset + 2 > bytes.length) return ['RW2 IFD不正'];
    const count = bytes.readUInt16LE(offset);
    if (count > 256 || offset + 6 + count * 12 > bytes.length) return ['RW2 IFD不正'];
    const widths = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    const seen = new Set(); let rawOffset, rawSize, format;
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      const tag = bytes.readUInt16LE(entry), kind = bytes.readUInt16LE(entry + 2), length = bytes.readUInt32LE(entry + 4), value = bytes.readUInt32LE(entry + 8);
      const numeric = (tag >= 1 && tag <= 0x2d) || [0x2f, 0x30, 0x31, 0x32, 0x111, 0x112, 0x116, 0x117, 0x118, 0x121].includes(tag);
      const identity = [0x10f, 0x110].includes(tag);
      if (seen.has(tag) || (!numeric && !identity) || !widths[kind]) { failures.push('RW2に禁止または未知metadata'); continue; }
      seen.add(tag);
      if (identity ? kind !== 2 || length > 64 : (kind === 2 || (kind === 7 && !(tag === 1 && length === 4)))) failures.push('RW2タグ形式不正');
      const size = length * widths[kind];
      if (size > 4 && (value < offset + 6 + count * 12 || value + size > bytes.length)) failures.push('RW2 metadata範囲不正');
      if ([0x117, 0x118, 0x2d].includes(tag) && (length !== 1 || ![3, 4].includes(kind))) failures.push('RW2 RAW位置不正');
      if (tag === 0x118) rawOffset = value;
      if (tag === 0x117) rawSize = value;
      if (tag === 0x2d) format = value;
    }
    if (bytes.readUInt32LE(offset + 2 + count * 12) !== 0 || ![5, 6, 7].includes(format) || !rawOffset || !rawSize || rawOffset + rawSize !== bytes.length) failures.push('RW2追加領域または圧縮形式不正');
  }
  return [...new Set(failures)];
}
