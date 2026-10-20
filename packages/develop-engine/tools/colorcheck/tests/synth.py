"""Synthetic test images (no photo data in the repository)."""
import numpy as np

from colorcheck import color as C
from colorcheck import imageops


def scene_linear_srgb(h: int, w: int, seed: int = 0) -> np.ndarray:
    """Smooth colored texture with a few hard-edged blocks, linear sRGB in [0.02, 0.75]."""
    rng = np.random.default_rng(seed)
    noise = rng.random((h, w, 3))
    field = imageops.gaussian_blur(noise, max(h, w) / 60.0, cv2_flag=False)
    lo = field.reshape(-1, 3).min(0)
    hi = field.reshape(-1, 3).max(0)
    field = 0.03 + 0.6 * (field - lo) / (hi - lo)
    fine = imageops.gaussian_blur(rng.random((h, w, 3)), 1.5, cv2_flag=False)
    field = field * (0.85 + 0.3 * fine)
    for _ in range(14):
        bh, bw = rng.integers(h // 12, h // 4), rng.integers(w // 12, w // 4)
        y, x = rng.integers(0, h - bh), rng.integers(0, w - bw)
        field[y:y + bh, x:x + bw] = 0.02 + 0.7 * rng.random(3)
    return np.clip(field, 0.02, 0.75)


def warp(img: np.ndarray, scale: float, dx: float, dy: float) -> np.ndarray:
    """Candidate whose content maps onto `img` with (scale, dx, dy)."""
    h, w = img.shape[:2]
    # inverse of warp_scale_shift: content at candidate x appears at reference s(x-c)+c+d
    out, _ = imageops.warp_scale_shift(img, 1.0 / scale, -dx / scale, -dy / scale, (h, w))
    return out


def render_reference_u8(lin_srgb: np.ndarray, ev: float = 0.0) -> np.ndarray:
    return C.render_display(C.apply_matrix(lin_srgb, C.M_SRGB_TO_PP), ev)


def warp_radial(img: np.ndarray, k, norm_radius: float | None = None) -> np.ndarray:
    """Candidate whose content maps onto `img` after the radial correction with k = (k1, k2)."""
    from colorcheck import align as A
    h, w = img.shape[:2]
    c = ((w - 1) / 2.0, (h - 1) / 2.0)
    R = norm_radius or float(np.hypot(w, h) / 2.0)
    rx, ry = A.radial_displacement(k, c, R, (h, w))
    ys, xs = np.mgrid[0:h, 0:w]
    # cand(y) = ref(y + r(y)) so that ref(x) ~ cand(x - r(x)) for small r
    out, _ = imageops.remap(img, xs + rx, ys + ry)
    return out
