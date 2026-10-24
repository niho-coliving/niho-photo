#!/usr/bin/env python3
"""完成したapp tarを展開・実行せず、検証済みinventoryへ照合する。"""
import hashlib
import json
import os
from pathlib import PurePosixPath
import stat
import sys
import tarfile

ROOT = "NIHO photo.app"
MAX_FILES = 50_000
MAX_TOTAL = 2 * 1024 * 1024 * 1024
MAX_FILE = 250 * 1024 * 1024

def require(value, message):
    if not value:
        raise ValueError(message)

def verify(manifest_path, archive_path):
    meta = os.lstat(manifest_path)
    require(stat.S_ISREG(meta.st_mode) and 0 < meta.st_size <= 16 * 1024 * 1024, "manifest bounds/type")
    with open(manifest_path, encoding="utf-8") as source:
        manifest = json.load(source)
    records = manifest.get("app", {}).get("files")
    require(isinstance(records, list) and 0 < len(records) <= MAX_FILES, "inventory count")
    expected = {}
    for record in records:
        name = record.get("path") if isinstance(record, dict) else None
        require(isinstance(name, str) and name not in expected and not name.startswith("/") and str(PurePosixPath(name)) == name and not any(p in (".", "..") for p in name.split("/")) and not any(ord(c) < 32 or ord(c) == 127 or c == "\\" for c in name), "inventory path")
        require(type(record.get("bytes")) is int and 0 <= record["bytes"] <= MAX_FILE and type(record.get("executable")) is bool and isinstance(record.get("sha256"), str), "inventory record")
        expected[name] = record
    item = os.lstat(archive_path)
    require(stat.S_ISREG(item.st_mode) and 0 < item.st_size <= MAX_FILE, "archive bounds/type")
    seen, files, total, count, root_seen = set(), set(), 0, 0, False
    with tarfile.open(archive_path, "r|gz") as archive:
        for member in archive:
            count += 1
            require(count <= MAX_FILES, "archive entry count")
            name = member.name.rstrip("/")
            if name.startswith("./"):
                name = name[2:]
            require(name not in seen and str(PurePosixPath(name)) == name and not name.startswith("/") and not any(p in (".", "..") for p in name.split("/")) and not any(ord(c) < 32 or ord(c) == 127 or c == "\\" for c in name), "archive duplicate/path")
            seen.add(name)
            require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) and member.mode & 0o7000 == 0, "archive special file/mode")
            if name == ROOT:
                require(member.isdir() and member.size == 0, "archive root")
                root_seen = True
                continue
            require(name.startswith(ROOT + "/"), "archive outside app")
            if member.isdir():
                require(member.size == 0, "archive directory size")
                continue
            relative = name[len(ROOT) + 1:]
            require(relative in expected, "archive extra file")
            record = expected[relative]
            total += member.size
            require(0 <= member.size == record["bytes"] <= MAX_FILE and total <= MAX_TOTAL and bool(member.mode & 0o111) == record["executable"], "archive file size/mode")
            source = archive.extractfile(member)
            require(source is not None, "archive file read")
            digest, size = hashlib.sha256(), 0
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                require(size <= member.size, "archive expanded size")
                digest.update(chunk)
            require(size == member.size and digest.hexdigest() == record["sha256"], "archive file hash")
            files.add(relative)
    require(root_seen and files == set(expected), "archive missing file/root")
    return len(files)

if __name__ == "__main__":
    try:
        require(len(sys.argv) == 3, "arguments")
        count = verify(sys.argv[1], sys.argv[2])
        print(f"app tar inventory: {count} files verified without extraction")
    except (ValueError, OSError, tarfile.TarError):
        print("app tar inventory verification failed (values hidden)", file=sys.stderr)
        raise SystemExit(1)
