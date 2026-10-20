"""colorcheck: NIHO develop-engine color measurement toolkit (Epic #16939 S9 / #16972).

Compares a reference image (Lightroom export / camera JPEG) with a NIHO output
at the same geometry and reports CIEDE2000 and related numbers.
"""
from __future__ import annotations

import os

__version__ = "1.0.0"

REF_ROOT_ENV = "NIHO_COLOR_REF_ROOT"
WORK_DIR_ENV = "NIHO_COLOR_WORK_DIR"
DEFAULT_REF_ROOT = "OWNER_DATA_ROOT"
DEFAULT_WORK_DIR = "OWNER_DATA_ROOT"


def ref_root() -> str:
    """Root used to resolve relative reference paths (env NIHO_COLOR_REF_ROOT)."""
    return os.environ.get(REF_ROOT_ENV) or DEFAULT_REF_ROOT


def work_dir() -> str:
    """Root used to resolve relative candidate paths (env NIHO_COLOR_WORK_DIR)."""
    return os.environ.get(WORK_DIR_ENV) or DEFAULT_WORK_DIR
