#!/usr/bin/env python3
"""Repack Panasonic RW2 v5-v7 from an explicit numeric tag allowlist and exact RAW strips.

No original metadata region, EXIF IFD, MakerNotes, camera IFD, JPEG preview, ICC,
GPS or serial is copied. Unsupported compression/offset layouts fail closed.
Run the original and output through the decoder audit before approving an asset.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
# Sensor geometry, CFA, bit depth, levels, WB, raw format and decoder parameters.
NUMERIC = set(range(1, 0x2E)) | {0x2F, 0x30, 0x31, 0x32, 0x111, 0x112, 0x116, 0x117, 0x118, 0x121}
STRINGS = {0x10F, 0x110}  # make and model only


def entries(data):
    if len(data) < 24 or data[:4] != b'IIU\x00':
        raise ValueError('unsupported RW2 header')
    offset = struct.unpack_from('<I', data, 4)[0]
    if offset + 2 > len(data):
        raise ValueError('invalid IFD')
    count = struct.unpack_from('<H', data, offset)[0]
    if count > 256 or offset + 6 + 12 * count > len(data):
        raise ValueError('invalid IFD size')
    found = {}
    for index in range(count):
        start = offset + 2 + 12 * index
        tag, kind, length, value = struct.unpack_from('<HHII', data, start)
        if tag in found or kind not in TYPE_SIZE:
            raise ValueError('unsupported or duplicate TIFF field')
        size = length * TYPE_SIZE[kind]
        payload = data[start + 8:start + 12][:size] if size <= 4 else data[value:value + size]
        if len(payload) != size:
            raise ValueError('truncated TIFF payload')
        found[tag] = (kind, length, payload)
    return found


def scalar(fields, tag):
    kind, count, value = fields[tag]
    if count != 1 or kind not in (3, 4):
        raise ValueError('unsupported RAW offset/format')
    return int.from_bytes(value, 'little')


def sanitize(data):
    fields = entries(data)
    if scalar(fields, 0x2D) not in (5, 6, 7):
        raise ValueError('only offset-independent Panasonic v5-v7 is supported')
    offset, size = scalar(fields, 0x118), scalar(fields, 0x117)
    if not size or offset < 24 or offset + size > len(data):
        raise ValueError('invalid RAW strip range')
    strip = data[offset:offset + size]
    selected = []
    for tag, (kind, count, payload) in sorted(fields.items()):
        if tag in NUMERIC:
            if kind not in (1, 3, 4, 5, 8, 9, 10, 11, 12):
                if tag != 1 or kind != 7 or count != 4:
                    continue  # opaque vendor metadata is excluded

        elif tag in STRINGS:
            if kind != 2 or count > 64 or not payload.endswith(b'\0'):
                raise ValueError('invalid camera identity')
            if tag == 0x10F and payload.rstrip(b'\0') != b'Panasonic':
                raise ValueError('unsupported camera make')
        else:
            continue
        selected.append((tag, kind, count, payload))
    # Relocate every retained value; no bytes of the original metadata prefix survive.
    prefix = bytearray(data[:24])
    struct.pack_into('<I', prefix, 4, 24)
    prefix += struct.pack('<H', len(selected)) + bytes(12 * len(selected) + 4)
    for index, (tag, kind, count, payload) in enumerate(selected):
        if len(payload) <= 4:
            value = int.from_bytes(payload.ljust(4, b'\0'), 'little')
        else:
            value = len(prefix)
            prefix += payload
            if len(prefix) % 2:
                prefix += b'\0'
        struct.pack_into('<HHII', prefix, 26 + 12 * index, tag, kind, count, value)
    if len(prefix) % 16:
        prefix += bytes(16 - len(prefix) % 16)
    for index, (tag, _, _, _) in enumerate(selected):
        if tag == 0x118:
            struct.pack_into('<I', prefix, 26 + 12 * index + 8, len(prefix))
    output = bytes(prefix) + strip
    audit = {'schema': 'niho.rw2-sanitization/1', 'sourceSha256': hashlib.sha256(data).hexdigest(),
             'outputSha256': hashlib.sha256(output).hexdigest(), 'rawStripSha256': hashlib.sha256(strip).hexdigest(),
             'rawStripBytes': len(strip), 'sourceBytes': len(data), 'outputBytes': len(output),
             'retainedTags': [f'{tag:04x}' for tag, _, _, _ in selected],
             'removed': ['GPS', 'serial', 'names', 'EXIF', 'MakerNotes', 'camera IFD', 'embedded JPEG/thumbnail', 'ICC']}
    return output, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--audit', type=Path, required=True)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve() or (args.output.exists() and args.source.samefile(args.output)):
        parser.error('source and output must differ')
    output, audit = sanitize(args.source.read_bytes())
    args.output.write_bytes(output)
    args.audit.write_text(json.dumps(audit, indent=2) + '\n')
    print('RW2 repacked; verify decoded samples and interpretation before publication.')


if __name__ == '__main__':
    main()
