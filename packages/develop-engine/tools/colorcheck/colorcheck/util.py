"""Small shared helpers (JSON, time, names)."""
from __future__ import annotations

import datetime as _dt
import json
import os
import re

import numpy as np


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _default(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    raise TypeError(f"not JSON serializable: {type(o)}")


def write_json(path: str, data) -> str:
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, default=_default)
        fh.write("\n")
    return path


def read_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def slug(text: str) -> str:
    s = re.sub(r"[^0-9A-Za-z]+", "-", str(text)).strip("-").lower()
    return s or "item"


def safe_name(text: str) -> str:
    s = re.sub(r"[^0-9A-Za-z._-]+", "_", str(text)).strip("_")
    return s or "item"


def camera_block(make: str | None, model: str | None) -> dict:
    return {"make": make, "model": model}
