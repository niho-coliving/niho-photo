//! EXIF orientation (TIFF tag 0x0112) applied to interleaved RGB pixels.

use crate::par;

/// EXIF orientation. Names follow rawler (`Rotate90` = EXIF 6 = rotate 90° clockwise to display).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    Normal,
    HorizontalFlip,
    Rotate180,
    VerticalFlip,
    Transpose,
    Rotate90,
    Transverse,
    Rotate270,
}

impl Orientation {
    pub fn from_exif(v: u16) -> Option<Self> {
        Some(match v {
            1 => Self::Normal,
            2 => Self::HorizontalFlip,
            3 => Self::Rotate180,
            4 => Self::VerticalFlip,
            5 => Self::Transpose,
            6 => Self::Rotate90,
            7 => Self::Transverse,
            8 => Self::Rotate270,
            _ => return None,
        })
    }

    pub fn exif_value(self) -> u16 {
        match self {
            Self::Normal => 1,
            Self::HorizontalFlip => 2,
            Self::Rotate180 => 3,
            Self::VerticalFlip => 4,
            Self::Transpose => 5,
            Self::Rotate90 => 6,
            Self::Transverse => 7,
            Self::Rotate270 => 8,
        }
    }

    pub fn from_rawler(o: rawler::Orientation) -> Option<Self> {
        Self::from_exif(o.to_u16())
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Normal => "Normal",
            Self::HorizontalFlip => "HorizontalFlip",
            Self::Rotate180 => "Rotate180",
            Self::VerticalFlip => "VerticalFlip",
            Self::Transpose => "Transpose",
            Self::Rotate90 => "Rotate90",
            Self::Transverse => "Transverse",
            Self::Rotate270 => "Rotate270",
        }
    }

    /// True when width and height swap.
    pub fn swaps_axes(self) -> bool {
        matches!(
            self,
            Self::Transpose | Self::Rotate90 | Self::Transverse | Self::Rotate270
        )
    }

    /// Source pixel `(x, y)` of display pixel `(xo, yo)` for a stored image of `w × h`.
    #[inline]
    pub fn source_of(self, xo: usize, yo: usize, w: usize, h: usize) -> (usize, usize) {
        match self {
            Self::Normal => (xo, yo),
            Self::HorizontalFlip => (w - 1 - xo, yo),
            Self::Rotate180 => (w - 1 - xo, h - 1 - yo),
            Self::VerticalFlip => (xo, h - 1 - yo),
            Self::Transpose => (yo, xo),
            Self::Rotate90 => (yo, h - 1 - xo),
            Self::Transverse => (w - 1 - yo, h - 1 - xo),
            Self::Rotate270 => (w - 1 - yo, xo),
        }
    }
}

/// Apply `o` to an interleaved RGB image of `w × h`. Returns `(pixels, width, height)` for display.
pub fn apply(img: Vec<f32>, w: usize, h: usize, o: Orientation) -> (Vec<f32>, usize, usize) {
    if o == Orientation::Normal {
        return (img, w, h);
    }
    let (ow, oh) = if o.swaps_axes() { (h, w) } else { (w, h) };
    let mut out = vec![0.0_f32; ow * oh * 3];
    par::for_each_row_mut(&mut out, ow * 3, |yo, row| {
        for xo in 0..ow {
            let (x, y) = o.source_of(xo, yo, w, h);
            let s = (y * w + x) * 3;
            row[xo * 3..xo * 3 + 3].copy_from_slice(&img[s..s + 3]);
        }
    });
    (out, ow, oh)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3 × 2 image whose red channel is the pixel id `y * 3 + x`.
    fn img() -> Vec<f32> {
        (0..6).flat_map(|i| [i as f32, 0.0, 0.0]).collect()
    }

    fn ids(v: &[f32]) -> Vec<u32> {
        v.as_chunks::<3>().0.iter().map(|p| p[0] as u32).collect()
    }

    #[test]
    fn all_orientations() {
        // Stored:  0 1 2
        //          3 4 5
        let cases: [(u16, usize, usize, [u32; 6]); 8] = [
            (1, 3, 2, [0, 1, 2, 3, 4, 5]),
            (2, 3, 2, [2, 1, 0, 5, 4, 3]),
            (3, 3, 2, [5, 4, 3, 2, 1, 0]),
            (4, 3, 2, [3, 4, 5, 0, 1, 2]),
            (5, 2, 3, [0, 3, 1, 4, 2, 5]),
            // EXIF 6: rotate 90° clockwise — stored left column becomes the top row.
            (6, 2, 3, [3, 0, 4, 1, 5, 2]),
            (7, 2, 3, [5, 2, 4, 1, 3, 0]),
            // EXIF 8: rotate 90° counter-clockwise — stored top-right is the display top-left.
            (8, 2, 3, [2, 5, 1, 4, 0, 3]),
        ];
        for (exif, ew, eh, expected) in cases {
            let o = Orientation::from_exif(exif).unwrap();
            let (out, w, h) = apply(img(), 3, 2, o);
            assert_eq!((w, h), (ew, eh), "exif {exif}");
            assert_eq!(ids(&out), expected.to_vec(), "exif {exif}");
        }
    }
}
