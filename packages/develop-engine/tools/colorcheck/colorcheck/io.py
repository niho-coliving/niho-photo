"""Image I/O.

Reading
  * JPEG and 8-bit PNG: Pillow (EXIF orientation applied; an embedded ICC
    profile that is not sRGB is converted to sRGB with littleCMS).
  * 16-bit PNG, TIFF (8/16-bit, 32-bit float): cv2.imread(IMREAD_UNCHANGED),
    BGR -> RGB, alpha dropped, uint16 / 65535, float kept as is.
Writing
  * 8-bit JPEG / PNG via Pillow (sRGB ICC embedded when available).
  * 16-bit sRGB TIFF via cv2 (for the Photo Bench raster path).
"""
from __future__ import annotations

import io as _io
import os
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np
from PIL import Image, ImageOps

from . import color as C
from . import imageops

try:  # optional
    from PIL import ImageCms  # type: ignore
except Exception:  # pragma: no cover
    ImageCms = None

try:  # optional
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None

Image.MAX_IMAGE_PIXELS = 400_000_000  # 60MP+ exports are expected, not bombs

JPEG_EXT = {".jpg", ".jpeg"}
PNG_EXT = {".png"}
TIFF_EXT = {".tif", ".tiff"}


@dataclass
class LoadedImage:
    path: str
    raw: np.ndarray  # H x W x 3: uint8 | uint16 | float32
    icc: str | None = None
    notes: list = field(default_factory=list)

    @property
    def size(self) -> list:
        return [int(self.raw.shape[1]), int(self.raw.shape[0])]

    @property
    def bit_depth(self) -> int:
        if self.raw.dtype == np.uint8:
            return 8
        if self.raw.dtype == np.uint16:
            return 16
        return 32

    def normalized(self) -> np.ndarray:
        """float32, integer data scaled to [0,1]; float data unchanged."""
        if self.raw.dtype == np.uint8:
            return self.raw.astype(np.float32) / np.float32(255.0)
        if self.raw.dtype == np.uint16:
            return self.raw.astype(np.float32) / np.float32(65535.0)
        return self.raw.astype(np.float32, copy=False)

    def linear(self, space: str) -> tuple[np.ndarray, str]:
        """Linear float32 data and its linear space for a declared pixel space."""
        if space == C.SPACE_SRGB:
            if self.raw.dtype == np.uint8:
                return C.srgb8_decode(self.raw), C.SPACE_LINEAR_SRGB
            if self.raw.dtype == np.uint16:
                return C.srgb16_decode(self.raw), C.SPACE_LINEAR_SRGB
            return C.srgb_decode(self.normalized()), C.SPACE_LINEAR_SRGB
        if space in (C.SPACE_LINEAR_SRGB, C.SPACE_LINEAR_PROPHOTO):
            return self.normalized(), space
        raise ValueError(f"unknown space {space!r} (use one of {', '.join(C.SPACES)})")

    def describe(self) -> dict:
        d = {"path": os.path.abspath(self.path), "size": self.size, "bitDepth": self.bit_depth}
        if self.icc:
            d["icc"] = self.icc
        if self.notes:
            d["notes"] = list(self.notes)
        return d


def _png_bit_depth(path: str) -> int | None:
    try:
        with open(path, "rb") as fh:
            head = fh.read(26)
        if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
            return head[24]
    except OSError:
        return None
    return None


def load_image(path: str) -> LoadedImage:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    ext = os.path.splitext(path)[1].lower()
    if ext in JPEG_EXT:
        return _load_pillow(path)
    if ext in PNG_EXT and (_png_bit_depth(path) or 8) <= 8:
        return _load_pillow(path)
    if cv2 is not None:
        arr = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if arr is not None:
            return _from_cv2(path, arr)
    return _load_pillow(path)


def _from_cv2(path: str, arr: np.ndarray) -> LoadedImage:
    notes = []
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    elif arr.shape[2] == 1:
        arr = np.concatenate([arr] * 3, axis=-1)
    elif arr.shape[2] >= 4:
        arr = arr[..., :3]
        notes.append("alpha を捨てた")
    arr = arr[..., ::-1]  # BGR -> RGB
    if arr.dtype in (np.uint8, np.uint16):
        pass
    elif arr.dtype in (np.float32, np.float64):
        arr = arr.astype(np.float32)
    else:
        raise ValueError(f"{path}: unsupported sample type {arr.dtype}")
    return LoadedImage(path, np.ascontiguousarray(arr), None, notes)


def _icc_description(icc_bytes: bytes) -> str | None:
    if not icc_bytes or ImageCms is None:
        return None
    try:
        prof = ImageCms.ImageCmsProfile(_io.BytesIO(icc_bytes))
        return (ImageCms.getProfileDescription(prof) or "").strip() or None
    except Exception:
        return None


def _load_pillow(path: str) -> LoadedImage:
    notes = []
    with Image.open(path) as im0:
        icc_bytes = im0.info.get("icc_profile")
        im = ImageOps.exif_transpose(im0)
        if im is None:
            im = im0
        if im.mode in ("I;16", "I;16B", "I;16L", "I"):
            arr = np.asarray(im, dtype=np.uint16)
            return LoadedImage(path, np.ascontiguousarray(np.stack([arr] * 3, axis=-1)), None, notes)
        desc = _icc_description(icc_bytes)
        if icc_bytes and desc and "srgb" not in desc.lower() and ImageCms is not None:
            try:
                src = ImageCms.ImageCmsProfile(_io.BytesIO(icc_bytes))
                dst = ImageCms.createProfile("sRGB")
                im = ImageCms.profileToProfile(im.convert("RGB"), src, dst,
                                               renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
                                               outputMode="RGB")
                notes.append(f"ICC '{desc}' を sRGB に変換した")
            except Exception as exc:  # pragma: no cover
                notes.append(f"ICC '{desc}' の変換に失敗（sRGB とみなした）: {exc}")
        if im.mode != "RGB":
            if "A" in im.mode:
                notes.append("alpha を捨てた")
            im = im.convert("RGB")
        arr = np.asarray(im, dtype=np.uint8)
    return LoadedImage(path, np.ascontiguousarray(arr), desc, notes)


@lru_cache(maxsize=1)
def srgb_icc_bytes() -> bytes | None:
    if ImageCms is None:
        return None
    try:
        return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    except Exception:  # pragma: no cover
        return None


def _ensure_dir(path: str) -> None:
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)


def save_srgb8(path: str, u8: np.ndarray, quality: int = 95) -> str:
    """Write 8-bit sRGB (JPEG or PNG by extension)."""
    _ensure_dir(path)
    ext = os.path.splitext(path)[1].lower()
    im = Image.fromarray(np.ascontiguousarray(u8, dtype=np.uint8), "RGB")
    kw = {}
    icc = srgb_icc_bytes()
    if icc:
        kw["icc_profile"] = icc
    if ext in JPEG_EXT:
        kw.update(quality=int(quality), subsampling=0 if quality >= 90 else 2, optimize=True)
        im.save(path, "JPEG", **kw)
    elif ext in PNG_EXT:
        im.save(path, "PNG", **kw)
    else:
        raise ValueError(f"{path}: 8-bit output must be .jpg/.jpeg/.png")
    return path


def save_tiff16_srgb(path: str, encoded: np.ndarray) -> str:
    """Write a 16-bit sRGB-encoded TIFF (3 channels, no alpha)."""
    if cv2 is None:
        raise RuntimeError("16-bit TIFF の書き込みには cv2 (opencv-python-headless) が要る")
    _ensure_dir(path)
    u16 = C.quantize16(encoded)
    ok = cv2.imwrite(path, np.ascontiguousarray(u16[..., ::-1]))
    if not ok:
        raise IOError(f"failed to write {path}")
    return path


def downscale_srgb8(u8: np.ndarray, long_edge: int) -> np.ndarray:
    """Shrink 8-bit sRGB in linear light (area average) so that max(w,h) <= long_edge."""
    h, w = u8.shape[:2]
    if max(h, w) <= long_edge:
        return u8
    lin = C.srgb8_decode(u8)
    small = imageops.resize_long_edge(lin, long_edge)
    return C.quantize8(C.srgb_encode(np.clip(small, 0.0, 1.0)))


def save_sample(path: str, u8: np.ndarray, long_edge: int = 480, quality: int = 80) -> str:
    return save_srgb8(path, downscale_srgb8(u8, long_edge), quality=quality)
