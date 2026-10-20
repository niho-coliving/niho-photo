"""Container safety unit tests. Actual RW2 acceptance is mandatory in Rust fixture_pipeline."""
import struct
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from sanitize_rw2 import sanitize, entries, scalar


class SanitizationTests(unittest.TestCase):
    def sample(self):
        # Synthetic container tests offset rewriting and metadata removal, never RAW decoding.
        tags = [(1, 7, 4, b'0123'), (2, 3, 1, struct.pack('<H', 4)),
                (0x2D, 3, 1, struct.pack('<H', 6)),
                (0x10F, 2, 10, b'Panasonic\0'), (0x110, 2, 6, b'DC-S5\0'),
                (0x117, 4, 1, struct.pack('<I', 32)),
                (0x118, 4, 1, struct.pack('<I', 512)),
                (0x8769, 4, 1, struct.pack('<I', 400))]
        output = bytearray(b'IIU\0' + struct.pack('<I', 24) + bytes(16))
        output[8:24] = b'private-header!!'
        output += struct.pack('<H', len(tags)) + bytes(12 * len(tags) + 4)
        for index, (tag, kind, count, payload) in enumerate(tags):
            if len(payload) > 4:
                value = len(output)
                output += payload
            else:
                value = int.from_bytes(payload.ljust(4, b'\0'), 'little')
            struct.pack_into('<HHII', output, 26 + index * 12, tag, kind, count, value)
        output += bytes(512 - len(output))
        # Private metadata bytes must not survive even as unreferenced padding.
        output[400:421] = b'private serial marker'
        output += bytes(range(32))
        return bytes(output)

    def test_reconstructs_from_allowlist_and_preserves_strip_exactly(self):
        source = self.sample()
        clean, audit = sanitize(source)
        fields = entries(clean)
        self.assertNotIn(0x8769, fields)
        self.assertNotIn(b'private serial marker', clean)
        self.assertNotIn(b'private-header!!', clean)
        self.assertEqual(clean[8:24], bytes(16))
        offset = scalar(fields, 0x118)
        self.assertEqual(clean[offset:], bytes(range(32)))
        self.assertEqual(audit['rawStripBytes'], 32)
        self.assertEqual(sanitize(clean)[0], clean)

    def test_rejects_corrupt_or_unsupported_layout(self):
        with self.assertRaises(ValueError):
            sanitize(b'not a raw')
        source = bytearray(self.sample())
        # Pointer to a huge strip must fail before reading out of bounds.
        struct.pack_into('<I', source, 26 + 6 * 12 + 8, 0xffffffff)
        with self.assertRaises(ValueError):
            sanitize(bytes(source))

    def test_cli_rejects_audit_aliases_before_writing(self):
        source_bytes = self.sample()
        script = Path(__file__).with_name('sanitize_rw2.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.rw2'
            source.write_bytes(source_bytes)
            output = root / 'output.rw2'

            for output_path, audit_path in [
                (output, source),
                (output, output),
            ]:
                result = subprocess.run(
                    [sys.executable, str(script), str(source), str(output_path), '--audit', str(audit_path)],
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(source.read_bytes(), source_bytes)
                self.assertFalse(output.exists())

            hardlink = root / 'source-hardlink.rw2'
            os.link(source, hardlink)
            result = subprocess.run(
                [sys.executable, str(script), str(source), str(output), '--audit', str(hardlink)],
                capture_output=True, text=True, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(source.read_bytes(), source_bytes)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
