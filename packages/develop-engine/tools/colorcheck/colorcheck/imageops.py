"""Resampling and filtering. cv2 is used when available; numpy fallbacks give
the same box / Gaussian / bilinear results (tests exercise both paths)."""
from __future__ import annotations

import math

import numpy as np

try:  # optional
    import cv2  # type: ignore
    HAVE_CV2 = True
except Exception:  # pragma: no cover - depends on the environment
    cv2 = None
    HAVE_CV2 = False


def use_cv2(flag: bool | None) -> bool:
    if flag is None:
        return HAVE_CV2
    if flag and not HAVE_CV2:
        raise RuntimeError("cv2 (opencv-python-headless) is not available")
    return bool(flag)


def size_for_long_edge(w: int, h: int, long_edge: int) -> tuple[int, int]:
    """(w, h) scaled so that max(w, h) == long_edge, rounding the short side."""
    if w >= h:
        return int(long_edge), max(1, int(round(h * long_edge / w)))
    return max(1, int(round(w * long_edge / h))), int(long_edge)


def _area_axis(a: np.ndarray, n_out: int, axis: int) -> np.ndarray:
    """Exact box (area-average) resampling along one axis via a running integral."""
    n_in = a.shape[axis]
    if n_out == n_in:
        return a
    x = np.moveaxis(a, axis, 0).astype(np.float64, copy=False)
    zeros = np.zeros((1,) + x.shape[1:])
    cs = np.concatenate([zeros, np.cumsum(x, axis=0)], axis=0)
    x_ext = np.concatenate([x, zeros], axis=0)
    step = n_in / n_out
    edges = np.arange(n_out + 1) * step
    i = np.minimum(np.floor(edges).astype(np.int64), n_in)
    f = (edges - i).reshape((-1,) + (1,) * (x.ndim - 1))
    integ = cs[i] + f * x_ext[i]
    out = (integ[1:] - integ[:-1]) / step
    return np.moveaxis(out, 0, axis)


def resize(img: np.ndarray, size: tuple[int, int], cv2_flag: bool | None = None) -> np.ndarray:
    """Resize to size=(w, h). Box/area average when shrinking (linear when enlarging with cv2)."""
    w, h = int(size[0]), int(size[1])
    if img.shape[1] == w and img.shape[0] == h:
        return img
    src_dtype = img.dtype if img.dtype in (np.float32, np.float64) else np.float32
    if use_cv2(cv2_flag):
        a = np.ascontiguousarray(img, dtype=np.float32)
        enlarge = w > img.shape[1] or h > img.shape[0]
        interp = cv2.INTER_LINEAR if enlarge else cv2.INTER_AREA
        out = cv2.resize(a, (w, h), interpolation=interp)
        if out.ndim == 2 and img.ndim == 3:
            out = out[..., None]
        return out.astype(src_dtype, copy=False)
    out = _area_axis(img, h, 0)
    out = _area_axis(out, w, 1)
    return out.astype(src_dtype, copy=False)


def resize_long_edge(img: np.ndarray, long_edge: int, cv2_flag: bool | None = None) -> np.ndarray:
    h, w = img.shape[:2]
    return resize(img, size_for_long_edge(w, h, long_edge), cv2_flag)


def gaussian_kernel(sigma: float) -> np.ndarray:
    radius = max(1, int(math.ceil(4.0 * sigma)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2.0 * sigma * sigma))
    return k / k.sum()


def _conv_axis(a: np.ndarray, k: np.ndarray, axis: int) -> np.ndarray:
    r = len(k) // 2
    n = a.shape[axis]
    if n == 1:
        return a.astype(np.float64)
    ap = _pad_reflect_long(a, r, axis)  # == OpenCV BORDER_REFLECT_101
    out = np.zeros(a.shape, dtype=np.float64)
    for j, w in enumerate(k):
        sl = [slice(None)] * a.ndim
        sl[axis] = slice(j, j + n)
        out += w * ap[tuple(sl)]
    return out


def _pad_reflect_long(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    n = a.shape[axis]
    idx = np.arange(-r, n + r)
    period = 2 * (n - 1)
    idx = np.abs(np.mod(idx, period))
    idx = np.where(idx >= n, period - idx, idx)
    return np.take(a, idx, axis=axis)


def gaussian_blur(img: np.ndarray, sigma: float, cv2_flag: bool | None = None) -> np.ndarray:
    """Separable Gaussian, kernel radius ceil(4 sigma), reflect-101 borders."""
    if sigma is None or sigma <= 0:
        return img
    k = gaussian_kernel(sigma)
    src_dtype = img.dtype if img.dtype in (np.float32, np.float64) else np.float32
    if use_cv2(cv2_flag) and min(img.shape[:2]) > len(k) // 2:
        a = np.ascontiguousarray(img, dtype=np.float32 if src_dtype == np.float32 else np.float64)
        ks = len(k)
        out = cv2.GaussianBlur(a, (ks, ks), sigmaX=sigma, sigmaY=sigma, borderType=cv2.BORDER_REFLECT_101)
        if out.ndim == 2 and img.ndim == 3:
            out = out[..., None]
        return out.astype(src_dtype, copy=False)
    out = _conv_axis(img, k, 0)
    out = _conv_axis(out, k, 1)
    return out.astype(src_dtype, copy=False)


def blur_masked(img: np.ndarray, mask: np.ndarray, sigma: float, cv2_flag: bool | None = None,
                coverage: float = 0.98) -> tuple[np.ndarray, np.ndarray]:
    """Normalized convolution: invalid pixels do not leak into valid ones.

    Returns (blurred, valid) where valid marks pixels whose kernel support is
    at least `coverage` inside `mask`.
    """
    if sigma is None or sigma <= 0:
        return img, mask.copy()
    m = mask.astype(img.dtype if img.dtype in (np.float32, np.float64) else np.float32)
    num = gaussian_blur(img * m[..., None], sigma, cv2_flag)
    den = gaussian_blur(m, sigma, cv2_flag)
    out = num / np.maximum(den, 1e-6)[..., None]
    return out.astype(num.dtype, copy=False), (den >= coverage) & mask


def _lerp_axis(a: np.ndarray, src: np.ndarray, axis: int) -> np.ndarray:
    """Linear interpolation along axis at fractional source positions (edge-replicate)."""
    n = a.shape[axis]
    s = np.clip(src, 0.0, n - 1)
    i0 = np.minimum(np.floor(s).astype(np.int64), max(n - 2, 0))
    f = s - i0
    i1 = np.minimum(i0 + 1, n - 1)
    shape = [1] * a.ndim
    shape[axis] = -1
    f = f.reshape(shape).astype(a.dtype if a.dtype in (np.float32, np.float64) else np.float64)
    return np.take(a, i0, axis=axis) * (1 - f) + np.take(a, i1, axis=axis) * f


def warp_scale_shift(img: np.ndarray, scale: float, dx: float, dy: float,
                     out_hw: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Map `img` into an out_hw frame with x_out = s (x_in - c_in) + c_out + dx.

    Bilinear (separable, since there is no rotation). Returns (warped, valid)
    where valid marks output pixels whose source lies inside the input image.
    """
    h_in, w_in = img.shape[:2]
    h, w = int(out_hw[0]), int(out_hw[1])
    cx_in, cy_in = (w_in - 1) / 2.0, (h_in - 1) / 2.0
    cx_out, cy_out = (w - 1) / 2.0, (h - 1) / 2.0
    xs = (np.arange(w) - cx_out - dx) / scale + cx_in
    ys = (np.arange(h) - cy_out - dy) / scale + cy_in
    tol = 1e-6
    vx = (xs >= -tol) & (xs <= w_in - 1 + tol)
    vy = (ys >= -tol) & (ys <= h_in - 1 + tol)
    out = _lerp_axis(img, xs, 1)
    out = _lerp_axis(out, ys, 0)
    return out, np.outer(vy, vx)


def crop_box(h: int, w: int, frac: float) -> tuple[int, int, int, int]:
    """(y0, y1, x0, x1) removing `frac` of each side."""
    my = int(round(h * frac))
    mx = int(round(w * frac))
    return my, h - my, mx, w - mx


def remap(img: np.ndarray, map_x: np.ndarray, map_y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """General backward mapping: out[y, x] = img[map_y[y, x], map_x[y, x]] (bilinear).

    Returns (out, valid) where valid marks output pixels whose source lies inside
    the input image. Out-of-range sources are edge-clamped in `out`.
    """
    h, w = img.shape[:2]
    mx = np.asarray(map_x, dtype=np.float64)
    my = np.asarray(map_y, dtype=np.float64)
    valid = (mx >= -1e-6) & (mx <= w - 1 + 1e-6) & (my >= -1e-6) & (my <= h - 1 + 1e-6)
    mx = np.clip(mx, 0.0, w - 1)
    my = np.clip(my, 0.0, h - 1)
    x0 = np.minimum(np.floor(mx).astype(np.int64), max(w - 2, 0))
    y0 = np.minimum(np.floor(my).astype(np.int64), max(h - 2, 0))
    fx = mx - x0
    fy = my - y0
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    if img.ndim == 3:
        fx = fx[..., None]
        fy = fy[..., None]
    dtype = img.dtype if img.dtype in (np.float32, np.float64) else np.float64
    a = img.astype(dtype, copy=False)
    out = (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x1] * fx * (1 - fy)
           + a[y1, x0] * (1 - fx) * fy + a[y1, x1] * fx * fy)
    return out.astype(dtype, copy=False), valid
